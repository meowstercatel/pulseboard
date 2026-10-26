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

// Runs now and then hourly. The returned stop function waits for a run in
// progress, so the database can be closed right after it.
export function startCleanup(): () => Promise<void> {
    let running: Promise<void> | undefined;
    const run = () => {
        if (running) return;
        running = deleteExpiredRows()
            .then(({ sessions, verifications, resets }) => {
                if (sessions || verifications || resets) {
                    console.log(
                        `Deleted expired rows: ${sessions} session(s), ${verifications} verification link(s), ${resets} reset link(s)`,
                    );
                }
            })
            .catch((err) => console.error("Expired row cleanup failed", err))
            .finally(() => (running = undefined));
    };
    run();
    const timer = setInterval(run, CLEANUP_INTERVAL_MS).unref();
    return async () => {
        clearInterval(timer);
        await running;
    };
}
