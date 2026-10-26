import { describe, expect, it } from "vitest";
import {
    accountDestination,
    hasAccess,
    trialDaysLeft,
    trialEnded,
    type User,
} from "../src/lib/auth";
import { planSummary } from "../src/lib/plan";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-26T12:00:00Z");

const user = (fields: Partial<User>): User => ({
    id: 1,
    email: "a@example.com",
    username: null,
    licensePlan: null,
    trialEndsAt: null,
    emailVerified: true,
    ...fields,
});
const endsIn = (ms: number) => new Date(now + ms).toISOString();

describe("free trial", () => {
    it("counts whole days left, a part day as one", () => {
        expect(
            trialDaysLeft(user({ trialEndsAt: endsIn(14 * DAY) }), now),
        ).toBe(14);
        expect(
            trialDaysLeft(user({ trialEndsAt: endsIn(13 * DAY + 1) }), now),
        ).toBe(14);
        expect(trialDaysLeft(user({ trialEndsAt: endsIn(3 * DAY) }), now)).toBe(
            3,
        );
        expect(trialDaysLeft(user({ trialEndsAt: endsIn(60_000) }), now)).toBe(
            1,
        );
        expect(trialDaysLeft(user({ trialEndsAt: endsIn(0) }), now)).toBeNull();
        expect(trialDaysLeft(user({}), now)).toBeNull();
    });

    it("gives access while it runs, and a paid license always", () => {
        expect(hasAccess(user({ trialEndsAt: endsIn(1000) }), now)).toBe(true);
        expect(hasAccess(user({ trialEndsAt: endsIn(-1000) }), now)).toBe(
            false,
        );
        expect(hasAccess(user({}), now)).toBe(false);
        expect(
            hasAccess(
                user({ licensePlan: "lifetime", trialEndsAt: endsIn(-DAY) }),
                now,
            ),
        ).toBe(true);
    });

    it("has ended only for unpaid accounts that had one", () => {
        expect(trialEnded(user({ trialEndsAt: endsIn(-1000) }), now)).toBe(
            true,
        );
        expect(trialEnded(user({ trialEndsAt: endsIn(1000) }), now)).toBe(
            false,
        );
        // accounts from before the trial never had one
        expect(trialEnded(user({}), now)).toBe(false);
        expect(
            trialEnded(
                user({ licensePlan: "subscription", trialEndsAt: endsIn(-1) }),
                now,
            ),
        ).toBe(false);
    });

    it("sends trial users to the dashboard and expired ones to the plans", () => {
        const future = new Date(Date.now() + DAY).toISOString();
        const past = new Date(Date.now() - DAY).toISOString();
        expect(accountDestination(user({ trialEndsAt: future }))).toBe(
            "/overview",
        );
        expect(accountDestination(user({ trialEndsAt: past }))).toBe("/buy");
        expect(
            accountDestination(
                user({ trialEndsAt: future, emailVerified: false }),
            ),
        ).toBe("/verify-email");
    });
});

describe("plan summary", () => {
    it("describes each state", () => {
        expect(
            planSummary(user({ trialEndsAt: "2026-11-09T12:00:00Z" }), now),
        ).toEqual({
            text: "Free trial, 14 days left (ends 9 November 2026).",
            action: "Choose a plan",
        });
        expect(planSummary(user({ trialEndsAt: endsIn(-1) }), now).text).toBe(
            "Your free trial has ended.",
        );
        expect(planSummary(user({ licensePlan: "lifetime" }), now).text).toBe(
            "Lifetime license.",
        );
        expect(
            planSummary(user({ licensePlan: "subscription" }), now).action,
        ).toBe("Manage subscription");
        expect(planSummary(user({}), now).text).toBe("No plan yet.");
    });
});
