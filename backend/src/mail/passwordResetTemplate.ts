import { actionEmailHtml, escapeHtml } from "./layout.js";

export function passwordResetTemplate(link: string, email: string) {
    const subject = "Reset your PulseBoard password";
    const footer =
        "The link expires in 1 hour and works once. If you didn't ask to reset your password, you can ignore this email; your password stays the same.";
    const text = `Reset your password

Someone asked to reset the password of the PulseBoard account for ${email}. Choose a new password by opening this link:

${link}

${footer}`;

    const html = actionEmailHtml({
        subject,
        preheader: "Choose a new password for your PulseBoard account.",
        heading: "Reset your password",
        bodyHtml: `Someone asked to reset the password of the PulseBoard account for <strong>${escapeHtml(email)}</strong>. Choose a new one below; you'll be signed out everywhere else.`,
        buttonLabel: "reset password",
        link,
        footer,
    });

    return { subject, text, html };
}
