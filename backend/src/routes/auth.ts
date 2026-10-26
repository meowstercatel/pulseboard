import { Hono, type Context } from "hono";
import {
    sendVerificationEmail,
    trySendVerificationEmail,
    verifyEmailToken,
} from "../auth/emailVerification.js";
import {
    DUMMY_HASH,
    MAX_PASSWORD,
    MIN_PASSWORD,
    hashPassword,
    needsRehash,
    validPassword,
    verifyPassword,
} from "../auth/password.js";
import { notifyAccountChange } from "../auth/accountNotice.js";
import { PROVIDER_NAMES } from "../auth/oauth.js";
import {
    requestPasswordReset,
    resetPassword,
    sendPasswordSetup,
} from "../auth/passwordReset.js";
import { publicUrl } from "../auth/publicUrl.js";
import { limitAccountChanges, reauthenticate } from "../auth/reauth.js";
import {
    createSession,
    destroySession,
    getSessionUser,
    requestSessionId,
    requireAuth,
    revokeOtherSessions,
    toAuthUser,
    type AuthEnv,
} from "../auth/session.js";
import {
    RateLimiter,
    clientIp,
    limitByIp,
    tooManyRequests,
} from "../auth/rateLimit.js";
import { accountExistsTemplate } from "../mail/accountExistsTemplate.js";
import { sendMail } from "../mail/mailer.js";
import { db } from "../prisma/db.js";
import { cancelSubscriptionOf } from "./billing.js";
import { isUniqueViolation } from "../prisma/errors.js";

// Excludes characters nodemailer reads as address-list syntax, so
// "a@b.com,c" can't send the verification email somewhere else
const EMAIL_RE =
    /^[^\s@,;:<>()"\[\]\\]+@[^\s@,;:<>()"\[\]\\]+\.[^\s@,;:<>()"\[\]\\]+$/;

const MINUTE = 60 * 1000;
// Every login request from one IP, to slow down credential stuffing
const loginIpLimiter = new RateLimiter(30, 15 * MINUTE);
// Logins per account from one IP, so one client can't lock the owner out
const loginIpEmailLimiter = new RateLimiter(10, 15 * MINUTE);
// Failed logins per account from all IPs, against password guessing spread
// across many IPs. High, so it takes a lot of addresses to lock the owner out.
const loginEmailLimiter = new RateLimiter(100, 60 * MINUTE);
// Account creation from one IP
const registerIpLimiter = new RateLimiter(5, 60 * MINUTE);
// "You already have an account" emails per address; over the limit they're
// dropped silently, so the register form can't be used to spam an inbox
const accountExistsEmailLimiter = new RateLimiter(3, 60 * MINUTE);
// Padding so the response time doesn't reveal whether the account exists
const MIN_REGISTER_RESPONSE_MS = 250;
// Verification emails resent per account, so the endpoint can't be used to spam an inbox
const resendLimiter = new RateLimiter(3, 15 * MINUTE);
// Verification attempts from one IP, against guessing tokens
const verifyIpLimiter = new RateLimiter(30, 15 * MINUTE);
const resetRequestIpLimiter = new RateLimiter(10, 15 * MINUTE);
const resetIpEmailLimiter = new RateLimiter(3, 15 * MINUTE);
// Over the limit requests are dropped silently, so strangers can't lock someone out
const resetEmailLimiter = new RateLimiter(5, 60 * MINUTE);
const resetIpLimiter = new RateLimiter(30, 15 * MINUTE);
// "Set a password" links per account, so the endpoint can't be used to spam an inbox
const setupLimiter = new RateLimiter(3, 15 * MINUTE);

async function readAccountBody(req: Request) {
    if (!req.headers.get("content-type")?.startsWith("application/json")) {
        return null;
    }
    const body: unknown = await req.json().catch(() => null);
    return body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
}

type Credentials = { email: string; password: string; username?: string };

async function readCredentials(req: Request): Promise<Credentials | null> {
    if (!req.headers.get("content-type")?.startsWith("application/json")) {
        return null;
    }
    const body: unknown = await req.json().catch(() => null);
    if (typeof body !== "object" || body === null) return null;

    const { email, password, username } = body as Record<string, unknown>;
    if (typeof email !== "string" || typeof password !== "string") {
        return null;
    }
    return {
        email: email.trim().toLowerCase(),
        password,
        username:
            typeof username === "string" && username.trim()
                ? username.trim()
                : undefined,
    };
}

export const auth = new Hono<AuthEnv>();

auth.post("/register", limitByIp(registerIpLimiter), async (c) => {
    const creds = await readCredentials(c.req.raw);
    if (!creds) return c.json({ error: "Invalid request" }, 400);

    const { email, password, username } = creds;
    if (!EMAIL_RE.test(email)) {
        return c.json({ error: "Enter a valid email address" }, 400);
    }
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
        return c.json(
            {
                error: `Password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters`,
            },
            400,
        );
    }

    // Hashed even when the email is taken, so both cases take as long
    const passwordHash = await hashPassword(password);
    const padding = new Promise((r) => setTimeout(r, MIN_REGISTER_RESPONSE_MS));
    await registerOrNotify(c, email, username, passwordHash);
    await padding;
    // The same answer whether or not the email is taken. The session comes from
    // the verification link, which only the owner of the address gets.
    return c.body(null, 202);
});

// Creates the account and emails its verification link, or, if the address
// already has an account, emails its owner to log in instead. Mail goes out in
// the background, so a slow mail server doesn't reveal which one was sent.
async function registerOrNotify(
    c: Context,
    email: string,
    username: string | undefined,
    passwordHash: string,
) {
    const existing = await db.orm.public.User.where({ email })
        .select("id")
        .first();
    if (!existing) {
        try {
            const user = await db.orm.public.User.create({
                email,
                username: username ?? null,
                passwordHash,
            });
            await trySendVerificationEmail(c, user.id);
            return;
        } catch (err) {
            // Lost a race with a parallel registration of the same email
            if (!isUniqueViolation(err)) throw err;
        }
    }

    if (accountExistsEmailLimiter.retryAfter(email)) return;
    accountExistsEmailLimiter.hit(email);
    sendMail({
        to: email,
        ...accountExistsTemplate(
            publicUrl(c, "/login"),
            publicUrl(c, "/forgot-password"),
            email,
        ),
    }).catch((err) => {
        console.error("Couldn't send account exists email", err);
    });
}

auth.post("/login", limitByIp(loginIpLimiter), async (c) => {
    const creds = await readCredentials(c.req.raw);
    if (!creds || creds.password.length > MAX_PASSWORD) {
        return c.json({ error: "Invalid request" }, 400);
    }

    const ipEmailKey = `${clientIp(c)} ${creds.email}`;
    const retryAfter = Math.max(
        loginIpEmailLimiter.retryAfter(ipEmailKey),
        loginEmailLimiter.retryAfter(creds.email),
    );
    if (retryAfter) return tooManyRequests(c, retryAfter);
    // Counted up front so parallel guesses can't all slip past the check
    loginIpEmailLimiter.hit(ipEmailKey);
    loginEmailLimiter.hit(creds.email);

    const user = await db.orm.public.User.where({ email: creds.email }).first();
    const ok = await verifyPassword(
        creds.password,
        user?.passwordHash ?? DUMMY_HASH,
    );
    if (!user || !ok) {
        return c.json({ error: "Wrong email or password" }, 401);
    }
    loginIpEmailLimiter.reset(ipEmailKey);
    // only failures count against the account
    loginEmailLimiter.undo(creds.email);

    if (user.passwordHash && needsRehash(user.passwordHash)) {
        // Conditional, so a password changed in the meantime isn't overwritten.
        // The upgrade can wait for the next login if it fails.
        try {
            await db.orm.public.User.where({
                id: user.id,
                passwordHash: user.passwordHash,
            }).update({ passwordHash: await hashPassword(creds.password) });
        } catch (err) {
            console.error(`Couldn't rehash password of user ${user.id}`, err);
        }
    }

    await createSession(c, user.id);
    return c.json({ user: toAuthUser(user) });
});

auth.post("/logout", async (c) => {
    await destroySession(c);
    return c.body(null, 204);
});

auth.get("/me", requireAuth, (c) => {
    return c.json({ user: c.get("user") });
});

auth.post("/verify-email", limitByIp(verifyIpLimiter), async (c) => {
    const body = await readAccountBody(c.req.raw);
    if (!body || typeof body.token !== "string" || !body.token) {
        return c.json({ error: "Invalid request" }, 400);
    }
    // Only a session that already belongs to the account stays signed in
    const current = await getSessionUser(c);
    const verified = await verifyEmailToken(
        body.token,
        current ? requestSessionId(c) : null,
    );
    if (!verified) {
        return c.json(
            { error: "This verification link is invalid or has expired" },
            400,
        );
    }
    // The link proves the address, so it signs in to the account it verified.
    // Every other session is gone: whoever registered the address may not be
    // its owner, and could still be logged in to the account the owner now
    // uses (see verifyEmailToken for the logins that go with them).
    const { user, kept, removedLogins, needsPassword } = verified;
    if (!kept) {
        if (current) await destroySession(c);
        await createSession(c, user.id);
    }
    return c.json({
        user: toAuthUser(user),
        removedLogins: [
            ...new Set(removedLogins.map((p) => PROVIDER_NAMES[p] ?? p)),
        ],
        needsPassword,
    });
});

auth.post("/verify-email/resend", requireAuth, async (c) => {
    const user = c.get("user");
    if (user.emailVerified) {
        return c.json({ error: "Your email address is already verified" }, 400);
    }
    const key = String(user.id);
    const retryAfter = resendLimiter.retryAfter(key);
    if (retryAfter) return tooManyRequests(c, retryAfter);
    resendLimiter.hit(key);

    let sent;
    try {
        sent = await sendVerificationEmail(c, user.id);
    } catch (err) {
        console.error(
            `Couldn't send verification email to user ${user.id}`,
            err,
        );
        return c.json(
            { error: "Couldn't send the email, try again later" },
            502,
        );
    }
    // verified by another tab since this session was loaded
    if (!sent) {
        return c.json({ error: "Your email address is already verified" }, 400);
    }
    return c.body(null, 204);
});

auth.post("/delete-account", requireAuth, limitAccountChanges, async (c) => {
    const body = await readAccountBody(c.req.raw);
    const current = await db.orm.public.User.where({
        id: c.get("user").id,
    }).first();
    if (!current) return c.json({ error: "Not logged in" }, 401);
    if (
        !body ||
        typeof body.confirmation !== "string" ||
        body.confirmation.trim().toLowerCase() !== "delete my account"
    ) {
        return c.json(
            { error: 'Type "delete my account" to confirm deletion' },
            400,
        );
    }
    const reauth = await reauthenticate(
        current,
        c.get("sessionId"),
        body.currentPassword,
    );
    if (reauth === "wrong_password") {
        return c.json({ error: "Current password is incorrect" }, 400);
    }
    if (reauth === "sign_in_again") {
        return c.json(
            {
                error: "Sign in again with Google or Facebook, then delete your account within 10 minutes",
            },
            403,
        );
    }

    // Foreign keys atomically cascade to sessions, OAuth links, datasets, and metrics.
    const deleted = await db.orm.public.User.where({
        id: current.id,
        email: current.email,
        passwordHash: current.passwordHash,
    }).delete();
    if (!deleted)
        return c.json(
            { error: "Your account changed. Reload and try again" },
            409,
        );
    await cancelSubscriptionOf(current).catch((err) => {
        console.error(
            `Couldn't cancel Stripe subscription ${current.stripeSubscriptionId} of deleted user ${current.id}`,
            err,
        );
    });
    await destroySession(c);
    return c.body(null, 204);
});

auth.post("/profile", requireAuth, limitAccountChanges, async (c) => {
    const body = await readAccountBody(c.req.raw);
    if (
        !body ||
        typeof body.email !== "string" ||
        typeof body.username !== "string"
    ) {
        return c.json({ error: "Invalid request" }, 400);
    }
    const email = body.email.trim().toLowerCase();
    const username = body.username.trim() || null;
    if (!EMAIL_RE.test(email)) {
        return c.json({ error: "Enter a valid email address" }, 400);
    }

    const current = await db.orm.public.User.where({
        id: c.get("user").id,
    }).first();
    if (!current) return c.json({ error: "Not logged in" }, 401);
    if (email !== current.email && !current.passwordHash) {
        return c.json(
            {
                error: "Set a password first (under Password below) to change your email address",
            },
            400,
        );
    }
    if (
        email !== current.email &&
        (!current.passwordHash ||
            !validPassword(body.currentPassword) ||
            !(await verifyPassword(body.currentPassword, current.passwordHash)))
    ) {
        return c.json(
            { error: "Enter your current password to change your email" },
            400,
        );
    }

    try {
        // Avoid applying a change authorized with a password that just changed,
        // or writing back an old email (and its verified state) over a newer one.
        const user = await db.transaction(async (tx) => {
            const updated = await tx.orm.public.User.where({
                id: current.id,
                email: current.email,
                passwordHash: current.passwordHash,
            }).update(
                email === current.email
                    ? { email, username }
                    : // the new address has to be verified again
                      { email, username, emailVerifiedAt: null },
            );
            if (!updated || email === current.email) return updated;
            await tx.orm.public.PasswordReset.where({
                userId: updated.id,
            }).deleteAll();
            // Keep this device signed in and revoke every other session atomically.
            await revokeOtherSessions(updated.id, c.get("sessionId"), tx);
            return updated;
        });
        if (!user)
            return c.json(
                { error: "Your account changed. Reload and try again" },
                409,
            );
        if (email !== current.email) {
            await trySendVerificationEmail(c, user.id);
        }
        return c.json({ user: toAuthUser(user) });
    } catch (err) {
        if (isUniqueViolation(err)) {
            return c.json(
                { error: "An account with this email already exists" },
                409,
            );
        }
        throw err;
    }
});

auth.post("/password", requireAuth, limitAccountChanges, async (c) => {
    const body = await readAccountBody(c.req.raw);
    if (!body || !validPassword(body.newPassword)) {
        return c.json(
            {
                error: `New password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters`,
            },
            400,
        );
    }
    const current = await db.orm.public.User.where({
        id: c.get("user").id,
    }).first();
    if (!current) return c.json({ error: "Not logged in" }, 401);
    if (!current.passwordHash) {
        return c.json(
            {
                error: "This account uses social sign-in and has no password to change",
            },
            400,
        );
    }
    if (
        !validPassword(body.currentPassword) ||
        !(await verifyPassword(body.currentPassword, current.passwordHash))
    ) {
        return c.json({ error: "Current password is incorrect" }, 400);
    }
    if (body.newPassword === body.currentPassword) {
        return c.json(
            { error: "Choose a different password from your current password" },
            400,
        );
    }

    const passwordHash = await hashPassword(body.newPassword);
    const user = await db.transaction(async (tx) => {
        const updated = await tx.orm.public.User.where({
            id: current.id,
            passwordHash: current.passwordHash,
        }).update({ passwordHash });
        if (!updated) return null;
        await tx.orm.public.PasswordReset.where({
            userId: current.id,
        }).deleteAll();
        // Keep this device signed in and revoke every other session atomically.
        await revokeOtherSessions(current.id, c.get("sessionId"), tx);
        return updated;
    });
    if (!user)
        return c.json(
            { error: "Your account changed. Reload and try again" },
            409,
        );
    return c.json({ user: toAuthUser(user) });
});

// Emails a link to add a password to an account that only signs in with
// Google/Facebook; the link is a password reset link. Without a password the
// email can't be changed either, so this also unlocks that.
auth.post("/password/setup", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user.emailVerified) {
        return c.json({ error: "Verify your email address first" }, 403);
    }
    const key = String(user.id);
    const retryAfter = setupLimiter.retryAfter(key);
    if (retryAfter) return tooManyRequests(c, retryAfter);
    setupLimiter.hit(key);

    let result;
    try {
        result = await sendPasswordSetup(c, user.id);
    } catch (err) {
        console.error(
            `Couldn't send password setup email to user ${user.id}`,
            err,
        );
        return c.json(
            { error: "Couldn't send the email, try again later" },
            502,
        );
    }
    if (result === "gone") return c.json({ error: "Not logged in" }, 401);
    if (result === "has_password") {
        return c.json(
            { error: "This account already has a password. Reload the page" },
            409,
        );
    }
    if (result === "unverified") {
        return c.json({ error: "Verify your email address first" }, 403);
    }
    return c.body(null, 204);
});

auth.post("/password-reset", limitByIp(resetRequestIpLimiter), async (c) => {
    const body = await readAccountBody(c.req.raw);
    if (!body || typeof body.email !== "string") {
        return c.json({ error: "Invalid request" }, 400);
    }
    const email = body.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
        return c.json({ error: "Enter a valid email address" }, 400);
    }
    const key = `${clientIp(c)} ${email}`;
    const retryAfter = resetIpEmailLimiter.retryAfter(key);
    if (retryAfter) return tooManyRequests(c, retryAfter);
    resetIpEmailLimiter.hit(key);

    if (!resetEmailLimiter.retryAfter(email)) {
        resetEmailLimiter.hit(email);
        await requestPasswordReset(c, email);
    }
    return c.body(null, 204);
});

auth.post("/password-reset/confirm", limitByIp(resetIpLimiter), async (c) => {
    const body = await readAccountBody(c.req.raw);
    if (!body || typeof body.token !== "string" || !body.token) {
        return c.json({ error: "Invalid request" }, 400);
    }
    if (!validPassword(body.newPassword)) {
        return c.json(
            {
                error: `New password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters`,
            },
            400,
        );
    }
    const reset = await resetPassword(body.token, body.newPassword);
    if (!reset) {
        return c.json(
            { error: "This reset link is invalid or has expired" },
            400,
        );
    }
    const { user } = reset;
    // the account gained a way to log in, unlike a reset of a forgotten password
    if (reset.passwordWasSet) {
        notifyAccountChange(c, user, { kind: "password_set" });
    }
    // An owner who changed their address and reset before verifying it can
    // lose logins they connected themselves, so they hear about each one
    for (const provider of new Set(reset.removedLogins)) {
        notifyAccountChange(c, user, {
            kind: "unlinked",
            provider: PROVIDER_NAMES[provider] ?? provider,
        });
    }
    loginEmailLimiter.reset(user.email);
    loginIpEmailLimiter.reset(`${clientIp(c)} ${user.email}`);
    await createSession(c, user.id);
    return c.json({ user: toAuthUser(user) });
});
