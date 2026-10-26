import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
    OAuthError,
    PROVIDER_NAMES,
    providers,
    type OAuthErrorCode,
    type OAuthProfile,
    type OAuthProvider,
} from "../auth/oauth.js";
import {
    claimUnverifiedUser,
    trySendVerificationEmail,
} from "../auth/emailVerification.js";
import { RateLimiter, limitByIp } from "../auth/rateLimit.js";
import { publicUrl } from "../auth/publicUrl.js";
import { createSession, type AuthEnv } from "../auth/session.js";
import { db } from "../prisma/db.js";
import { isUniqueViolation } from "../prisma/errors.js";

const STATE_COOKIE = "oauth_state";
const STATE_TTL_SECONDS = 10 * 60;

// Each sign-in costs two outbound requests, so cap them per IP
const callbackIpLimiter = new RateLimiter(30, 15 * 60 * 1000);

// Must match a redirect URI registered with the provider
function redirectUri(c: Context, provider: string): string {
    return publicUrl(c, `/api/auth/oauth/${provider}/callback`);
}

// Only a code and the provider name go in the URL, so a crafted link can't put
// its own text on the login page
function fail(c: Context, code: OAuthErrorCode, provider: string) {
    const query = new URLSearchParams({ oauth_error: code, provider });
    return c.redirect(`/login?${query}`);
}

// Finds the user this provider account belongs to. If it isn't linked yet, it
// is linked to the user with the same (verified) email, or a new user is made.
async function resolveUser(
    provider: string,
    { linksByEmail }: OAuthProvider,
    profile: OAuthProfile,
) {
    const linked = await db.orm.public.OAuthAccount.where({
        provider,
        providerUserId: profile.id,
    })
        .include("user")
        .first();
    if (linked) {
        const { user } = linked;
        // Covers links made before email verification existed
        if (
            linksByEmail &&
            !user.emailVerifiedAt &&
            linked.email === user.email
        ) {
            const updated = await db.transaction((tx) =>
                claimUnverifiedUser(tx, user),
            );
            if (updated) return { user: updated, created: false };
        }
        return { user, created: false };
    }

    const email = profile.email?.trim().toLowerCase();
    if (!email || !profile.emailVerified) {
        throw new OAuthError("no_verified_email");
    }

    return db.transaction(async (tx) => {
        let user = await tx.orm.public.User.where({ email }).first();
        const created = !user;
        if (user && !linksByEmail) {
            throw new OAuthError("email_taken");
        }
        if (user) {
            // The email owner just proved control of it, so sign out any
            // sessions that were opened before the link
            await tx.orm.public.Session.where({ userId: user.id }).deleteAll();
            if (!user.emailVerifiedAt) {
                user = (await claimUnverifiedUser(tx, user)) ?? user;
            }
        } else {
            user = await tx.orm.public.User.create({
                email,
                username: profile.name,
                passwordHash: null,
                // Facebook doesn't prove the address, so like a password
                // sign-up the account stays unverified until the emailed link
                // (or a Google sign-in with it) does
                emailVerifiedAt: linksByEmail ? new Date().toISOString() : null,
            });
        }
        await tx.orm.public.OAuthAccount.create({
            provider,
            providerUserId: profile.id,
            userId: user.id,
            email,
        });
        return { user, created };
    });
}

export const oauth = new Hono<AuthEnv>();

oauth.get("/providers", (c) => {
    return c.json({ providers: Object.keys(providers) });
});

oauth.get("/:provider", (c) => {
    const name = c.req.param("provider");
    const provider = providers[name];
    if (!provider) return c.notFound();

    const state = randomBytes(16).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    setCookie(c, STATE_COOKIE, `${name}.${state}.${verifier}`, {
        httpOnly: true,
        secure: process.env["NODE_ENV"] === "production",
        // Lax so the cookie comes back on the provider's top-level redirect
        sameSite: "Lax",
        path: "/api/auth/oauth",
        maxAge: STATE_TTL_SECONDS,
    });
    return c.redirect(
        provider.authorizeUrl(redirectUri(c, name), state, verifier),
    );
});

oauth.get("/:provider/callback", limitByIp(callbackIpLimiter), async (c) => {
    const name = c.req.param("provider");
    const provider = providers[name];
    if (!provider) return c.notFound();
    const label = PROVIDER_NAMES[name];

    const cookie = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/api/auth/oauth" });
    const [cookieProvider, state, verifier] = cookie?.split(".") ?? [];

    // The user pressed "cancel" on the provider's consent screen
    if (c.req.query("error")) {
        return fail(c, "cancelled", name);
    }

    const code = c.req.query("code");
    if (
        !code ||
        !state ||
        !verifier ||
        cookieProvider !== name ||
        c.req.query("state") !== state
    ) {
        return fail(c, "expired", name);
    }

    let user, created;
    try {
        const profile = await provider.fetchProfile(
            code,
            redirectUri(c, name),
            verifier,
        );
        try {
            ({ user, created } = await resolveUser(name, provider, profile));
        } catch (err) {
            // Lost a race with a parallel sign-in that created the same rows
            if (!isUniqueViolation(err)) throw err;
            ({ user, created } = await resolveUser(name, provider, profile));
        }
    } catch (err) {
        if (err instanceof OAuthError) return fail(c, err.code, name);
        console.error(`${label} sign-in failed`, err);
        return fail(c, "failed", name);
    }

    if (created && !user.emailVerifiedAt)
        await trySendVerificationEmail(c, user.id);
    await createSession(c, user.id);
    return c.redirect(user.licensePlan ? "/overview" : "/buy");
});
