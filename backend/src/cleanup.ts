import { startPeriodic } from "./periodic.js";
import { db } from "./prisma/db.js";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Expired sessions and links are otherwise only deleted when someone uses them
export async function deleteExpiredRows() {
    const now = new Date().toISOString();
    const sessions = await db.orm.public.Session.where((s) =>
        s.expiresAt.lte(now),
    ).deleteAndCount();
    const verifications = await db.orm.public.EmailVerification.where((v) =>
        v.expiresAt.lte(now),
    ).deleteAndCount();
    const resets = await db.orm.public.PasswordReset.where((r) =>
        r.expiresAt.lte(now),
    ).deleteAndCount();
    return { sessions, verifications, resets };
}

// Runs now and then hourly
export function startCleanup(): () => Promise<void> {
    return startPeriodic(
        "Expired row cleanup",
        CLEANUP_INTERVAL_MS,
        async () => {
            const { sessions, verifications, resets } =
                await deleteExpiredRows();
            if (sessions || verifications || resets) {
                console.log(
                    `Deleted expired rows: ${sessions} session(s), ${verifications} verification link(s), ${resets} reset link(s)`,
                );
            }
        },
    );
}
