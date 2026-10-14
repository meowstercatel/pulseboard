import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
    OAuthError,
    PROVIDER_NAMES,
    providers,
    type OAuthProfile,
} from "../auth/oauth.js";
import { RateLimiter, limitByIp } from "../auth/rateLimit.js";
import { createSession, type AuthEnv } from "../auth/session.js";
import { db } from "../prisma/db.js";
import { isUniqueViolation } from "../prisma/errors.js";

const STATE_COOKIE = "oauth_state";
const STATE_TTL_SECONDS = 10 * 60;

// Each sign-in costs two outbound requests, so cap them per IP
const callbackIpLimiter = new RateLimiter(30, 15 * 60 * 1000);

// Must match a redirect URI registered with the provider. Set PUBLIC_URL when
// the request URL differs from the public one (e.g. behind a reverse proxy).
function redirectUri(c: Context, provider: string): string {
    const base = process.env["PUBLIC_URL"] || new URL(c.req.url).origin;
    return `${base.replace(/\/$/, "")}/api/auth/oauth/${provider}/callback`;
}

function fail(c: Context, message: string) {
    return c.redirect(`/?oauth_error=${encodeURIComponent(message)}`);
}

// Finds the user this provider account belongs to. If it isn't linked yet, it
// is linked to the user with the same (verified) email, or a new user is made.
async function resolveUser(provider: string, profile: OAuthProfile) {
    const linked = await db.orm.public.OAuthAccount.where({
        provider,
        providerUserId: profile.id,
    })
        .include("user")
        .first();
    if (linked) return linked.user;

    const email = profile.email?.trim().toLowerCase();
    if (!email || !profile.emailVerified) {
        throw new OAuthError(
            `Your ${PROVIDER_NAMES[provider]} account has no verified email address`,
        );
    }

    return db.transaction(async (tx) => {
        let user = await tx.orm.public.User.where({ email }).first();
        if (user) {
            // The email owner just proved control of it, so sign out any
            // sessions that were opened before the link
            await tx.orm.public.Session.where({ userId: user.id }).deleteAll();
        } else {
            user = await tx.orm.public.User.create({
                email,
                username: profile.name,
                passwordHash: null,
            });
        }
        await tx.orm.public.OAuthAccount.create({
            provider,
            providerUserId: profile.id,
            userId: user.id,
            email,
        });
        return user;
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
        return fail(c, `${label} sign-in was cancelled`);
    }

    const code = c.req.query("code");
    if (
        !code ||
        !state ||
        !verifier ||
        cookieProvider !== name ||
        c.req.query("state") !== state
    ) {
        return fail(c, `${label} sign-in expired, please try again`);
    }

    let user;
    try {
        const profile = await provider.fetchProfile(
            code,
            redirectUri(c, name),
            verifier,
        );
        try {
            user = await resolveUser(name, profile);
        } catch (err) {
            // Lost a race with a parallel sign-in that created the same rows
            if (!isUniqueViolation(err)) throw err;
            user = await resolveUser(name, profile);
        }
    } catch (err) {
        if (err instanceof OAuthError) return fail(c, err.message);
        console.error(`${label} sign-in failed`, err);
        return fail(c, `Couldn't sign in with ${label}`);
    }

    await createSession(c, user.id);
    return c.redirect(user.licensePlan ? "/overview" : "/buy");
});
