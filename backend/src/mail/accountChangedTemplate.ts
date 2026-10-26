import { actionEmailHtml, escapeHtml } from "./layout.js";

export type AccountChange =
    | { kind: "linked"; provider: string }
    | { kind: "unlinked"; provider: string }
    | { kind: "password_set" };

// Sent after a change to how the account can be signed in to, so the owner
// notices one they didn't make. `provider` is a display name like "Google".
export function accountChangedTemplate(
    change: AccountChange,
    email: string,
    settingsLink: string,
) {
    const { subject, summary } =
        change.kind === "linked"
            ? {
                  subject: `${change.provider} was connected to your PulseBoard account`,
                  summary: `A ${change.provider} account was connected to the PulseBoard account for ${email}. It can now be used to log in.`,
              }
            : change.kind === "unlinked"
              ? {
                    subject: `${change.provider} was disconnected from your PulseBoard account`,
                    summary: `A ${change.provider} account was disconnected from the PulseBoard account for ${email}. It can no longer be used to log in, and your other devices were signed out.`,
                }
              : {
                    subject: "A password was set for your PulseBoard account",
                    summary: `A password was set for the PulseBoard account for ${email}. You can now log in with your email address and password, and your other devices were signed out.`,
                };
    const footer =
        "If this wasn't you, open your account settings, sign out other devices and disconnect anything you don't recognize, then reset your password.";
    const text = `${subject}

${summary}

Review your account: ${settingsLink}

${footer}`;

    const html = actionEmailHtml({
        subject,
        preheader: summary,
        heading: subject,
        bodyHtml: escapeHtml(summary),
        buttonLabel: "review account settings",
        link: settingsLink,
        footer,
    });

    return { subject, text, html };
}
