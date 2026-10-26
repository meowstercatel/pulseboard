import { actionEmailHtml, escapeHtml } from "./layout.js";

// Sent instead of an error when someone registers with an address that already
// has an account, so the register form doesn't reveal which emails are taken
export function accountExistsTemplate(
    loginLink: string,
    resetLink: string,
    email: string,
) {
    const subject = "You already have a PulseBoard account";
    const footer =
        "If you didn't try to register, you can ignore this email; nothing about your account changed.";
    const text = `You already have an account

Someone tried to register a new PulseBoard account with ${email}, but this address already has one. If it was you, log in instead:

${loginLink}

Forgot your password? Reset it here:

${resetLink}

${footer}`;

    const html = actionEmailHtml({
        subject,
        preheader: "Log in to your existing PulseBoard account.",
        heading: "You already have an account",
        bodyHtml: `Someone tried to register a new PulseBoard account with <strong>${escapeHtml(email)}</strong>, but this address already has one. If it was you, log in instead. Forgot your password? <a href="${escapeHtml(resetLink)}" style="color:#0f62fe;text-decoration:none;">Reset it</a>.`,
        buttonLabel: "log in",
        link: loginLink,
        footer,
    });

    return { subject, text, html };
}
