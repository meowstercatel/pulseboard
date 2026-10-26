import { appUrl } from "../auth/publicUrl.js";
import { sendMail } from "../mail/mailer.js";
import { trialReminderTemplate } from "../mail/trialReminderTemplate.js";
import { db } from "../prisma/db.js";
import { DAY_MS } from "./trial.js";

const REMINDER_INTERVAL_MS = 60 * 60 * 1000;

// Each is due while the trial's end is within its window. `stage` is what
// User.trialRemindersSent becomes once it is sent, so the windows don't
// overlap: an account first seen on its last day only gets the last one.
const REMINDERS = [
    { kind: "soon", stage: 1, from: DAY_MS, to: 3 * DAY_MS },
    { kind: "last_day", stage: 2, from: 0, to: DAY_MS },
] as const;

// Moves the account from `before` to `stage` reminders sent, if no other
// instance has and the user hasn't paid meanwhile; only the caller that gets
// the user back sends the email. It has to be a single UPDATE: Postgres then
// re-checks the condition after waiting for a concurrent claim. The ORM's
// update() reads the row and then updates it by id, so two instances could
// both get through.
export async function claimReminder(id: number, before: number, stage: number) {
    const plan = db.raw.sql`UPDATE "User"
        SET "trialRemindersSent" = ${stage}, "updatedAt" = now()
        WHERE id = ${id} AND "trialRemindersSent" = ${before}
            AND "licensePlan" IS NULL
        RETURNING email, "trialEndsAt"`
        .returnsRow({
            email: "pg/text@1",
            trialEndsAt: "pg/timestamptz-string@1",
        })
        .build();
    for await (const row of db.runtime().query(plan)) return row;
    return null;
}

// Emails every unpaid trial user whose reminder is due. Safe to run on several
// instances at once and after restarts: a reminder is claimed by moving
// trialRemindersSent forward with a conditional update before it is sent, so
// only one run ever sends it. If sending fails the claim is given back and the
// next run tries again.
export async function sendTrialReminders(now = Date.now()) {
    let sent = 0;
    for (const { kind, stage, from, to } of REMINDERS) {
        const due = await db.orm.public.User.where((u) =>
            u.trialEndsAt.gt(new Date(now + from).toISOString()),
        )
            .where((u) => u.trialEndsAt.lte(new Date(now + to).toISOString()))
            .where((u) => u.trialRemindersSent.lt(stage))
            .where((u) => u.licensePlan.isNull())
            .where((u) => u.emailVerifiedAt.isNotNull())
            .select("id", "trialRemindersSent")
            .all();

        for (const { id, trialRemindersSent: before } of due) {
            const user = await claimReminder(id, before, stage);
            // another instance got there first, or the user just paid
            if (!user?.trialEndsAt) continue;
            try {
                await sendMail({
                    to: user.email,
                    ...trialReminderTemplate(
                        kind,
                        user.trialEndsAt,
                        appUrl("/buy"),
                    ),
                });
                sent++;
            } catch (err) {
                console.error(
                    `Couldn't send ${kind} trial reminder to user ${id}`,
                    err,
                );
                await db.orm.public.User.where({
                    id,
                    trialRemindersSent: stage,
                }).update({ trialRemindersSent: before });
            }
        }
    }
    return sent;
}

// Runs now and then hourly, like startCleanup. The returned stop function
// waits for a run in progress, so the database can be closed right after it.
export function startTrialReminders(): () => Promise<void> {
    let running: Promise<void> | undefined;
    const run = () => {
        if (running) return;
        running = sendTrialReminders()
            .then((sent) => {
                if (sent) console.log(`Sent ${sent} trial reminder(s)`);
            })
            .catch((err) => console.error("Trial reminders failed", err))
            .finally(() => (running = undefined));
    };
    run();
    const timer = setInterval(run, REMINDER_INTERVAL_MS).unref();
    return async () => {
        clearInterval(timer);
        await running;
    };
}
