import { db } from "../prisma/db.js";

export const TRIAL_DAYS = 14;
export const DAY_MS = 24 * 60 * 60 * 1000;

type Queries = Pick<typeof db, "orm">;

// Starts the free trial when an account's email address is first verified, so
// it isn't running while the owner still has to find the email. Only once per
// account: verifying a changed address later doesn't restart it, and accounts
// from before the trial existed (trialEligible = false) never get one. Returns
// the updated user, or null if nothing changed.
export function startTrial(queries: Queries, userId: number) {
    return queries.orm.public.User.where({ id: userId, trialEligible: true })
        .where((u) => u.trialEndsAt.isNull())
        .where((u) => u.emailVerifiedAt.isNotNull())
        .update({
            trialEndsAt: new Date(
                Date.now() + TRIAL_DAYS * DAY_MS,
            ).toISOString(),
        });
}

export function trialActive(
    user: { trialEndsAt: string | null },
    now = Date.now(),
): boolean {
    return (
        user.trialEndsAt !== null && new Date(user.trialEndsAt).getTime() > now
    );
}

// A paid license or a running trial; email verification is checked separately
export function hasAccess(
    user: { licensePlan: string | null; trialEndsAt: string | null },
    now = Date.now(),
): boolean {
    return Boolean(user.licensePlan) || trialActive(user, now);
}
