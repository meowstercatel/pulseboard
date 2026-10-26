import { trialDaysLeft, trialEnded, type User } from "./auth";

export const daysLeft = (days: number) =>
    days === 1 ? "1 day left" : `${days} days left`;

// e.g. "9 November 2026"
const endDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
    });

// One line about the account's plan for the settings page, and the label of
// the link to /buy that follows it
export function planSummary(
    user: User,
    now = Date.now(),
): { text: string; action: string } {
    if (user.licensePlan === "lifetime") {
        return { text: "Lifetime license.", action: "View plans" };
    }
    if (user.licensePlan) {
        return { text: "Subscription.", action: "Manage subscription" };
    }
    const days = trialDaysLeft(user, now);
    if (days !== null) {
        return {
            text: `Free trial, ${daysLeft(days)} (ends ${endDate(user.trialEndsAt!)}).`,
            action: "Choose a plan",
        };
    }
    if (trialEnded(user, now)) {
        return {
            text: "Your free trial has ended.",
            action: "Choose a plan",
        };
    }
    return { text: "No plan yet.", action: "Choose a plan" };
}

// Fills the header's TrialBadge on the dashboard pages; stays hidden for paid
// accounts
export function showTrialBadge(user: User, now = Date.now()) {
    const days = user.licensePlan ? null : trialDaysLeft(user, now);
    for (const badge of document.querySelectorAll<HTMLElement>(
        "[data-trial-badge]",
    )) {
        if (days === null) continue;
        badge.textContent = `Free trial: ${daysLeft(days)}`;
        badge.hidden = false;
    }
}
