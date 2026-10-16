import { Hono, type MiddlewareHandler } from "hono";
import {
    sendVerificationEmail,
    trySendVerificationEmail,
    verifyEmailToken,
} from "../auth/emailVerification.js";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../auth/password.js";
import {
    createSession,
    destroySession,
    requireAuth,
    toAuthUser,
    type AuthEnv,
} from "../auth/session.js";
import { RateLimiter, limitByIp, tooManyRequests } from "../auth/rateLimit.js";
import { db } from "../prisma/db.js";
import { isUniqueViolation } from "../prisma/errors.js";

// Excludes characters nodemailer reads as address-list syntax, so
// "a@b.com,c" can't send the verification email somewhere else
const EMAIL_RE =
    /^[^\s@,;:<>()"\[\]\\]+@[^\s@,;:<>()"\[\]\\]+\.[^\s@,;:<>()"\[\]\\]+$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;

const MINUTE = 60 * 1000;
// Every login request from one IP, to slow down credential stuffing
const loginIpLimiter = new RateLimiter(30, 15 * MINUTE);
// Failed logins per account, to stop password guessing spread across many IPs
const loginEmailLimiter = new RateLimiter(10, 15 * MINUTE);
// Account creation from one IP
const registerIpLimiter = new RateLimiter(5, 60 * MINUTE);
const accountLimiter = new RateLimiter(10, 15 * MINUTE);
// Verification emails resent per account, so the endpoint can't be used to spam an inbox
const resendLimiter = new RateLimiter(3, 15 * MINUTE);
// Verification attempts from one IP, against guessing tokens
const verifyIpLimiter = new RateLimiter(30, 15 * MINUTE);

const limitAccountChanges: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const key = String(c.get("user").id);
    const retryAfter = accountLimiter.retryAfter(key);
    if (retryAfter) return tooManyRequests(c, retryAfter);
    accountLimiter.hit(key);
    await next();
};

async function readAccountBody(req: Request) {
    if (!req.headers.get("content-type")?.startsWith("application/json")) {
        return null;
    }
    const body: unknown = await req.json().catch(() => null);
    return body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
}

function validPassword(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length >= MIN_PASSWORD &&
        value.length <= MAX_PASSWORD
    );
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

    const existing = await db.orm.public.User.where({ email })
        .select("id")
        .first();
    if (existing) {
        return c.json(
            { error: "An account with this email already exists" },
            409,
        );
    }

    let user;
    try {
        user = await db.orm.public.User.create({
            email,
            username: username ?? null,
            passwordHash: await hashPassword(password),
        });
    } catch (err) {
        if (isUniqueViolation(err)) {
            return c.json(
                { error: "An account with this email already exists" },
                409,
            );
        }
        throw err;
    }

    await trySendVerificationEmail(c, user.id);
    await createSession(c, user.id);
    return c.json({ user: toAuthUser(user) }, 201);
});

auth.post("/login", limitByIp(loginIpLimiter), async (c) => {
    const creds = await readCredentials(c.req.raw);
    if (!creds || creds.password.length > MAX_PASSWORD) {
        return c.json({ error: "Invalid request" }, 400);
    }

    const retryAfter = loginEmailLimiter.retryAfter(creds.email);
    if (retryAfter) return tooManyRequests(c, retryAfter);
    // Counted up front so parallel guesses can't all slip past the check
    loginEmailLimiter.hit(creds.email);

    const user = await db.orm.public.User.where({ email: creds.email }).first();
    const ok = await verifyPassword(
        creds.password,
        user?.passwordHash ?? DUMMY_HASH,
    );
    if (!user || !ok) {
        return c.json({ error: "Wrong email or password" }, 401);
    }
    loginEmailLimiter.reset(creds.email);

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
    const user = await verifyEmailToken(body.token);
    if (!user) {
        return c.json(
            { error: "This verification link is invalid or has expired" },
            400,
        );
    }
    return c.json({ user: toAuthUser(user) });
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
                error: "Email changes require a password-based account. This account uses social sign-in",
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
        const user = await db.orm.public.User.where({
            id: current.id,
            email: current.email,
            passwordHash: current.passwordHash,
        }).update(
            email === current.email
                ? { email, username }
                : // the new address has to be verified again
                  { email, username, emailVerifiedAt: null },
        );
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
        // Keep this device signed in and revoke every other session atomically.
        await tx.orm.public.Session.where({ userId: current.id })
            .where((session) => session.id.neq(c.get("sessionId")))
            .deleteAll();
        return updated;
    });
    if (!user)
        return c.json(
            { error: "Your account changed. Reload and try again" },
            409,
        );
    return c.json({ user: toAuthUser(user) });
});
