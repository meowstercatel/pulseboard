import { Hono } from "hono";
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;

const MINUTE = 60 * 1000;
// Every login request from one IP, to slow down credential stuffing
const loginIpLimiter = new RateLimiter(30, 15 * MINUTE);
// Failed logins per account, to stop password guessing spread across many IPs
const loginEmailLimiter = new RateLimiter(10, 15 * MINUTE);
// Account creation from one IP
const registerIpLimiter = new RateLimiter(5, 60 * MINUTE);

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

function isUniqueViolation(err: unknown): boolean {
    for (let e = err; e && typeof e === "object"; e = (e as any).cause) {
        if ((e as { sqlState?: string }).sqlState === "23505") return true;
    }
    return false;
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
