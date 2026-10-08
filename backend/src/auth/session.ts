import { randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { db } from "../prisma/db.js";

const COOKIE_NAME = "session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type AuthUser = {
    id: number;
    email: string;
    username: string | null;
    licensePlan: string | null;
};

export function toAuthUser(user: AuthUser): AuthUser {
    return {
        id: user.id,
        email: user.email,
        username: user.username,
        licensePlan: user.licensePlan,
    };
}

export type AuthEnv = { Variables: { user: AuthUser } };

export async function createSession(c: Context, userId: number) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await db.orm.public.Session.create({
        id: token,
        userId,
        expiresAt: expiresAt.toISOString(),
    });

    setCookie(c, COOKIE_NAME, token, {
        httpOnly: true,
        secure: process.env["NODE_ENV"] === "production",
        sameSite: "Lax",
        path: "/",
        expires: expiresAt,
    });
}

export async function getSessionUser(c: Context): Promise<AuthUser | null> {
    const token = getCookie(c, COOKIE_NAME);
    if (!token) return null;

    const id = token;
    const session = await db.orm.public.Session.where({ id })
        .include("user")
        .first();
    if (!session) return null;

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
        await db.orm.public.Session.where({ id }).delete();
        return null;
    }

    return toAuthUser(session.user);
}

export async function destroySession(c: Context) {
    const token = getCookie(c, COOKIE_NAME);
    if (token) {
        await db.orm.public.Session.where({ id: token }).delete();
    }
    deleteCookie(c, COOKIE_NAME, { path: "/" });
}

export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const user = await getSessionUser(c);
    if (!user) return c.json({ error: "Not logged in" }, 401);
    c.set("user", user);
    await next();
};

export const requireLicense: MiddlewareHandler<AuthEnv> = async (c, next) => {
    if (!c.get("user").licensePlan) {
        return c.json({ error: "No active license" }, 402);
    }
    await next();
};
