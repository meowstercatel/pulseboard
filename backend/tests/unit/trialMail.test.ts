import { expect, it } from "vitest";
import { trialReminderTemplate } from "../../src/mail/trialReminderTemplate.js";

const buy = "https://pulseboard.example/buy";
const now = Date.parse("2026-11-06T12:00:00Z");
const hoursLater = (hours: number) =>
    new Date(now + hours * 60 * 60 * 1000).toISOString();

it.each([
    ["soon", 72, "Your PulseBoard trial ends in 3 days"],
    ["soon", 60, "Your PulseBoard trial ends in 3 days"],
    // a run after downtime sends it late
    ["soon", 30, "Your PulseBoard trial ends in 2 days"],
    ["last_day", 24, "Your PulseBoard trial ends within 24 hours"],
    ["last_day", 2, "Your PulseBoard trial ends within 24 hours"],
] as const)(
    "titles the %s reminder %sh before the end",
    (kind, hours, subject) => {
        const mail = trialReminderTemplate(kind, hoursLater(hours), buy, now);
        expect(mail.subject).toBe(subject);
    },
);

it("states the exact end in UTC and links to the plans", () => {
    const mail = trialReminderTemplate(
        "last_day",
        "2026-11-07T09:05:00Z",
        buy,
        now,
    );
    expect(mail.text).toContain("Saturday, 7 November 2026 at 09:05 UTC");
    expect(mail.text).toContain(buy);
    expect(mail.html).toContain(`href="${buy}"`);
});
