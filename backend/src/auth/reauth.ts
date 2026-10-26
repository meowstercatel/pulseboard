import { db } from "../prisma/db.js";
import { verifyPassword } from "./password.js";

// Social-only accounts prove it's them by signing in again shortly before
const REAUTH_WINDOW_MS = 10 * 60 * 1000;
const MAX_PASSWORD = 256;

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
            typeof currentPassword === "string" &&
            currentPassword.length > 0 &&
            currentPassword.length <= MAX_PASSWORD &&
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
