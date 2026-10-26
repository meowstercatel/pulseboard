import type { MiddlewareHandler } from "hono";
import { db } from "../prisma/db.js";
import { validPassword, verifyPassword } from "./password.js";
import { RateLimiter, tooManyRequests } from "./rateLimit.js";
import type { AuthEnv } from "./session.js";

// Social-only accounts prove it's them by signing in again shortly before
const REAUTH_WINDOW_MS = 10 * 60 * 1000;

// One budget per account for every change that checks the current password,
// so adding endpoints doesn't add password guesses for a stolen session
const accountLimiter = new RateLimiter(10, 15 * 60 * 1000);

export const limitAccountChanges: MiddlewareHandler<AuthEnv> = async (
    c,
    next,
) => {
    const key = String(c.get("user").id);
    const retryAfter = accountLimiter.retryAfter(key);
    if (retryAfter) return tooManyRequests(c, retryAfter);
    accountLimiter.hit(key);
    await next();
};

export type Reauth = "ok" | "wrong_password" | "sign_in_again";

// For changes a stolen session shouldn't be able to make: the current
// password, or for accounts without one, a session opened in the last
// 10 minutes (by signing in with Google or Facebook again)
export async function reauthenticate(
    user: { passwordHash: string | null },
    sessionId: string,
    currentPassword: unknown,
): Promise<Reauth> {
    if (user.passwordHash) {
        const ok =
            validPassword(currentPassword) &&
            (await verifyPassword(currentPassword, user.passwordHash));
        return ok ? "ok" : "wrong_password";
    }
    const session = await db.orm.public.Session.where({ id: sessionId })
        .select("createdAt")
        .first();
    const fresh =
        session &&
        Date.now() - new Date(session.createdAt).getTime() <= REAUTH_WINDOW_MS;
    return fresh ? "ok" : "sign_in_again";
}
