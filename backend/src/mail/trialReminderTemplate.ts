import { actionEmailHtml, escapeHtml } from "./layout.js";

// e.g. "Monday, 9 November 2026 at 14:05 UTC"
function formatEnd(trialEndsAt: string): string {
    const date = new Date(trialEndsAt);
    const day = date.toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
    });
    const time = date.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
    });
    return `${day} at ${time} UTC`;
}

// Sent three days before the free trial ends ("soon") and on its last day
export function trialReminderTemplate(
    kind: "soon" | "last_day",
    trialEndsAt: string,
    buyLink: string,
) {
    const end = formatEnd(trialEndsAt);
    const subject =
        kind === "soon"
            ? "Your PulseBoard trial ends in 3 days"
            : "Your PulseBoard trial ends today";
    const summary = `Your free trial ends on ${end}. Choose a plan to keep using your dashboards and forecasts after that.`;
    const footer =
        "Your datasets are kept when the trial ends, and you can choose a plan at any time to get back to them.";
    const text = `${subject}

${summary}

Choose a plan: ${buyLink}

${footer}`;

    const html = actionEmailHtml({
        subject,
        preheader: summary,
        heading: subject,
        bodyHtml: escapeHtml(summary),
        buttonLabel: "choose a plan",
        link: buyLink,
        footer,
    });

    return { subject, text, html };
}
