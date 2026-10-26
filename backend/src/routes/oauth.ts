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
import { safeNext } from "../auth/nextPath.js";
import { notifyAccountChange } from "../auth/accountNotice.js";
import { RateLimiter, limitByIp } from "../auth/rateLimit.js";
import { publicUrl } from "../auth/publicUrl.js";
import { limitAccountChanges, reauthenticate } from "../auth/reauth.js";
import {
    createSession,
    getSessionUser,
    requestSessionId,
    requireAuth,
    type AuthEnv,
} from "../auth/session.js";
import { hasAccess, startTrial } from "../billing/trial.js";
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

// Only a code, the provider name and a checked same-origin path go in the
// URL, so a crafted link can't put its own text on the login page
function fail(
    c: Context,
    code: OAuthErrorCode,
    provider: string,
    next: string | null,
) {
    const query = new URLSearchParams({ oauth_error: code, provider });
    if (next) query.set("next", next);
    return c.redirect(`/login?${query}`);
}

// Finds the user this provider account belongs to. If it isn't linked yet, it
// is linked to the password-less or unverified user with the same (verified)
// email, or a new user is made.
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
        // Covers links made before email verification existed. The provider
        // has to prove the address right now: a link made from the settings
        // may have stored an address it never verified.
        if (
            linksByEmail &&
            !user.emailVerifiedAt &&
            profile.emailVerified &&
            profile.email?.trim().toLowerCase() === user.email &&
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
        // A verified account with a password is never linked by email: its
        // owner connects providers in the settings, and a Google account they
        // disconnected there must not come back on its next sign-in. An
        // unverified one is still claimed below, which clears its password.
        if (
            user &&
            (!linksByEmail || (user.emailVerifiedAt && user.passwordHash))
        ) {
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
            user = (await startTrial(tx, user.id)) ?? user;
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

// Sent to /settings as ?link_error=, which maps each code to a fixed message
export type LinkErrorCode =
    | "cancelled"
    | "expired"
    | "failed"
    // the account's email isn't verified yet
    | "unverified"
    // this provider account already signs in to another PulseBoard account
    | "linked_elsewhere"
    // the account already has a login with this provider
    | "provider_linked";

class LinkError extends Error {
    constructor(readonly code: LinkErrorCode) {
        super(code);
    }
}

function failLink(c: Context, code: LinkErrorCode, provider: string) {
    const query = new URLSearchParams({ link_error: code, provider });
    return c.redirect(`/settings?${query}`);
}

// Attaches a provider account to the signed-in user. Never matched by email:
// the session says whose account it is, and the provider's email is only kept
// to show it in the settings.
async function linkAccount(
    userId: number,
    provider: string,
    profile: OAuthProfile,
) {
    return db.transaction(async (tx) => {
        const current = await tx.orm.public.User.where({ id: userId }).first();
        if (!current) throw new LinkError("expired");
        // no-op update to lock the user row, so parallel links (or an email
        // change) can't slip past the checks below
        const user = await tx.orm.public.User.where({
            id: userId,
            email: current.email,
        })
            .where((u) => u.emailVerifiedAt.isNotNull())
            .update({ email: current.email });
        if (!user) throw new LinkError("unverified");

        const existing = await tx.orm.public.OAuthAccount.where({
            provider,
            providerUserId: profile.id,
        }).first();
        if (existing) {
            // Moving it would take a login away from the other account
            if (existing.userId !== userId) {
                throw new LinkError("linked_elsewhere");
            }
            return { user, linked: false };
        }
        const sameProvider = await tx.orm.public.OAuthAccount.where({
            userId,
            provider,
        }).first();
        if (sameProvider) throw new LinkError("provider_linked");

        await tx.orm.public.OAuthAccount.create({
            provider,
            providerUserId: profile.id,
            userId,
            // only an address the provider verified, so a stored email can
            // never later count as proof of the account's address
            email: profile.emailVerified
                ? profile.email?.trim().toLowerCase() || null
                : null,
        });
        return { user, linked: true };
    });
}

// The second half of a link started from the settings page. `linkSession` is
// the session that started it; only that session may finish it.
async function finishLink(
    c: Context,
    name: string,
    provider: OAuthProvider,
    code: string,
    verifier: string,
    linkSession: string,
) {
    const user = await getSessionUser(c);
    if (!user || requestSessionId(c) !== linkSession) {
        return failLink(c, "expired", name);
    }

    let result;
    try {
        const profile = await provider.fetchProfile(
            code,
            redirectUri(c, name),
            verifier,
        );
        try {
            result = await linkAccount(user.id, name, profile);
        } catch (err) {
            // Lost a race with a parallel sign-in or link of the same account
            if (!isUniqueViolation(err)) throw err;
            result = await linkAccount(user.id, name, profile);
        }
    } catch (err) {
        if (err instanceof LinkError) return failLink(c, err.code, name);
        if (!(err instanceof OAuthError)) {
            console.error(`Linking ${PROVIDER_NAMES[name]} failed`, err);
        }
        return failLink(c, "failed", name);
    }

    if (result.linked) {
        notifyAccountChange(c, result.user, {
            kind: "linked",
            provider: PROVIDER_NAMES[name] ?? name,
        });
    }
    return c.redirect(`/settings?${new URLSearchParams({ linked: name })}`);
}

function setStateCookie(c: Context, value: string) {
    setCookie(c, STATE_COOKIE, value, {
        httpOnly: true,
        secure: process.env["NODE_ENV"] === "production",
        // Lax so the cookie comes back on the provider's top-level redirect
        sameSite: "Lax",
        path: "/api/auth/oauth",
        maxAge: STATE_TTL_SECONDS,
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
    // the page to return to; encoded because the cookie is split on "."
    const next = Buffer.from(safeNext(c.req.query("next")) ?? "").toString(
        "base64url",
    );
    setStateCookie(c, `${name}.${state}.${verifier}.${next}`);
    return c.redirect(
        provider.authorizeUrl(redirectUri(c, name), state, verifier),
    );
});

// Starts linking another login to the signed-in account. A POST, so another
// site can't start it, and it asks for the password (or a fresh sign-in), so
// a stolen session can't add a login that outlives it. Answers with the
// provider URL for the page to open; the callback finishes the link.
oauth.post("/:provider/link", requireAuth, limitAccountChanges, async (c) => {
    const name = c.req.param("provider");
    const provider = providers[name];
    if (!provider) return c.json({ error: "Not found" }, 404);
    const user = c.get("user");

    if (!c.req.header("content-type")?.startsWith("application/json")) {
        return c.json({ error: "Invalid request" }, 400);
    }
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return c.json({ error: "Invalid request" }, 400);
    }
    if (!user.emailVerified) {
        return c.json({ error: "Verify your email address first" }, 403);
    }
    const current = await db.orm.public.User.where({ id: user.id }).first();
    if (!current) return c.json({ error: "Not logged in" }, 401);
    const reauth = await reauthenticate(
        current,
        c.get("sessionId"),
        (body as Record<string, unknown>)["currentPassword"],
    );
    if (reauth === "wrong_password") {
        return c.json({ error: "Current password is incorrect" }, 400);
    }
    if (reauth === "sign_in_again") {
        return c.json(
            {
                error: "Sign in again with Google or Facebook, then connect the account within 10 minutes",
            },
            403,
        );
    }
    const label = PROVIDER_NAMES[name] ?? name;
    const sameProvider = await db.orm.public.OAuthAccount.where({
        userId: user.id,
        provider: name,
    }).first();
    if (sameProvider) {
        return c.json(
            {
                error: `A ${label} account is already connected. Disconnect it first`,
            },
            409,
        );
    }

    const state = randomBytes(16).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    // no page to return to: the callback always goes back to the settings
    setStateCookie(c, `${name}.${state}.${verifier}..${c.get("sessionId")}`);
    return c.json({
        url: provider.authorizeUrl(redirectUri(c, name), state, verifier),
    });
});

oauth.get("/:provider/callback", limitByIp(callbackIpLimiter), async (c) => {
    const name = c.req.param("provider");
    const provider = providers[name];
    if (!provider) return c.notFound();
    const label = PROVIDER_NAMES[name];

    const cookie = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/api/auth/oauth" });
    // linkSession is set when the settings page started a link
    const [cookieProvider, state, verifier, encodedNext, linkSession] =
        cookie?.split(".") ?? [];
    const next = safeNext(
        Buffer.from(encodedNext ?? "", "base64url").toString(),
    );
    const linking = !!linkSession && cookieProvider === name;

    // The user pressed "cancel" on the provider's consent screen
    if (c.req.query("error")) {
        return linking
            ? failLink(c, "cancelled", name)
            : fail(c, "cancelled", name, next);
    }

    const code = c.req.query("code");
    if (
        !code ||
        !state ||
        !verifier ||
        cookieProvider !== name ||
        c.req.query("state") !== state
    ) {
        return linking
            ? failLink(c, "expired", name)
            : fail(c, "expired", name, next);
    }
    if (linking) {
        return finishLink(c, name, provider, code, verifier, linkSession);
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
        if (err instanceof OAuthError) return fail(c, err.code, name, next);
        console.error(`${label} sign-in failed`, err);
        return fail(c, "failed", name, next);
    }

    if (created && !user.emailVerifiedAt)
        await trySendVerificationEmail(c, user.id);
    await createSession(c, user.id);
    // like the password login: unverified users go via /buy to /verify-email
    if (next && user.emailVerifiedAt) return c.redirect(next);
    return c.redirect(hasAccess(user) ? "/overview" : "/buy");
});
