import { createHash, randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { hasAccess } from "../billing/trial.js";
import { db } from "../prisma/db.js";
import { clientIp } from "./rateLimit.js";

const COOKIE_NAME = "session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A session in use is extended to the full TTL once less than half is left
const EXTEND_BELOW_MS = SESSION_TTL_MS / 2;
// lastSeenAt is only written this often, so requests don't each update the row
export const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_USER_AGENT = 256;

export type AuthUser = {
    id: number;
    email: string;
    username: string | null;
    licensePlan: string | null;
    // end of the free trial, also once it has passed; null if it never started
    trialEndsAt: string | null;
    emailVerified: boolean;
};

type UserRow = Omit<AuthUser, "emailVerified"> & {
    emailVerifiedAt: string | null;
};

export function toAuthUser(user: UserRow): AuthUser {
    return {
        id: user.id,
        email: user.email,
        username: user.username,
        licensePlan: user.licensePlan,
        trialEndsAt: user.trialEndsAt,
        emailVerified: user.emailVerifiedAt !== null,
    };
}

export type AuthEnv = { Variables: { user: AuthUser; sessionId: string } };

// Only the SHA-256 of the cookie is stored, so a database leak can't be replayed
export function sessionIdFor(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

// Enough to tell devices apart on the settings page, without storing
// whatever a client chooses to send
export function trimUserAgent(value: string | undefined): string | null {
    const trimmed = value
        ?.replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_USER_AGENT)
        .trim();
    return trimmed || null;
}

function clientDetails(c: Context) {
    return {
        userAgent: trimUserAgent(c.req.header("user-agent")),
        ip: clientIp(c),
    };
}

function setSessionCookie(c: Context, token: string, expiresAt: Date) {
    setCookie(c, COOKIE_NAME, token, {
        httpOnly: true,
        secure: process.env["NODE_ENV"] === "production",
        sameSite: "Lax",
        path: "/",
        expires: expiresAt,
    });
}

type Queries = Pick<typeof db, "orm">;

// Pass a transaction to open the session only if a check in it holds
export async function createSession(
    c: Context,
    userId: number,
    queries: Queries = db,
) {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

    await queries.orm.public.Session.create({
        id: sessionIdFor(token),
        userId,
        expiresAt: expiresAt.toISOString(),
        lastSeenAt: now.toISOString(),
        ...clientDetails(c),
    });
    setSessionCookie(c, token, expiresAt);
}

// The stored id of this request's session cookie, if it has one
export function requestSessionId(c: Context): string | null {
    const token = getCookie(c, COOKIE_NAME);
    return token ? sessionIdFor(token) : null;
}

export async function getSessionUser(c: Context): Promise<AuthUser | null> {
    const token = getCookie(c, COOKIE_NAME);
    if (!token) return null;

    const id = sessionIdFor(token);
    const session = await db.orm.public.Session.where({ id })
        .include("user")
        .first();
    if (!session) return null;

    const now = Date.now();
    const expiresAt = new Date(session.expiresAt).getTime();
    if (expiresAt <= now) {
        await db.orm.public.Session.where({ id }).delete();
        return null;
    }

    const extend = expiresAt - now < EXTEND_BELOW_MS;
    const lastSeen = session.lastSeenAt
        ? new Date(session.lastSeenAt).getTime()
        : 0;
    if (extend || now - lastSeen >= LAST_SEEN_INTERVAL_MS) {
        const newExpiry = new Date(now + SESSION_TTL_MS);
        // Updating by id can't bring back a session revoked in the meantime
        const touched = await db.orm.public.Session.where({ id }).update({
            lastSeenAt: new Date(now).toISOString(),
            ...clientDetails(c),
            ...(extend ? { expiresAt: newExpiry.toISOString() } : {}),
        });
        if (!touched) return null;
        // the browser drops the cookie at its own expiry, so move that too
        if (extend) setSessionCookie(c, token, newExpiry);
    }

    return toAuthUser(session.user);
}

// Signs out every session of the user except `keep` (the current device),
// or every one if `keep` is null. Pass a transaction to revoke atomically
// with another account change.
export function revokeOtherSessions(
    userId: number,
    keep: string | null,
    queries: Queries = db,
): Promise<number> {
    const sessions = queries.orm.public.Session.where({ userId });
    return (
        keep === null ? sessions : sessions.where((s) => s.id.neq(keep))
    ).deleteAndCount();
}

// For a session that was never stored, like one whose transaction failed
export function clearSessionCookie(c: Context) {
    deleteCookie(c, COOKIE_NAME, { path: "/" });
}

export async function destroySession(c: Context) {
    const token = getCookie(c, COOKIE_NAME);
    if (token) {
        await db.orm.public.Session.where({ id: sessionIdFor(token) }).delete();
    }
    clearSessionCookie(c);
}

export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const user = await getSessionUser(c);
    if (!user) return c.json({ error: "Not logged in" }, 401);
    c.set("user", user);
    c.set("sessionId", sessionIdFor(getCookie(c, COOKIE_NAME)!));
    await next();
};

export const requireLicense: MiddlewareHandler<AuthEnv> = async (c, next) => {
    if (!c.get("user").emailVerified) {
        return c.json({ error: "Verify your email address first" }, 403);
    }
    // checked against the clock on every request, so access ends with the trial
    if (!hasAccess(c.get("user"))) {
        return c.json({ error: "No active license" }, 402);
    }
    await next();
};
