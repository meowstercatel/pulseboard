import { actionEmailHtml, escapeHtml } from "./layout.js";

export function verifyEmailTemplate(link: string, email: string) {
    const subject = "Verify your PulseBoard email address";
    const footer =
        "The link expires in 24 hours. If you didn't create a PulseBoard account, you can ignore this email.";
    const text = `Verify your email address

Confirm that ${email} belongs to your PulseBoard account by opening this link:

${link}

${footer}`;

    const html = actionEmailHtml({
        subject,
        preheader: "Confirm your email to finish setting up PulseBoard.",
        heading: "Verify your email address",
        bodyHtml: `Confirm that <strong>${escapeHtml(email)}</strong> belongs to your PulseBoard account to finish setting it up.`,
        buttonLabel: "verify email",
        link,
        footer,
    });

    return { subject, text, html };
}
