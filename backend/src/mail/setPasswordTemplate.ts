import { actionEmailHtml, escapeHtml } from "./layout.js";

// `logins` describes the logins already connected (like "Facebook
// (a@example.com)"), so an owner can spot one that isn't theirs before
// making the account their own
export function setPasswordTemplate(
    link: string,
    email: string,
    logins: string[],
) {
    const subject = "Set a password for PulseBoard";
    const connected = logins.length
        ? ` It can already be logged in to with: ${logins.join(", ")}. If you don't recognize one, disconnect it in your account settings.`
        : "";
    const footer =
        "The link expires in 1 hour and works once. If you didn't ask for it, you can ignore this email; your account stays as it is.";
    const text = `Set a password

You asked to add a password to the PulseBoard account for ${email}, so you can also log in with your email address.${connected}

Choose a password by opening this link:

${link}

${footer}`;

    const html = actionEmailHtml({
        subject,
        preheader: "Add a password to your PulseBoard account.",
        heading: "Set a password",
        bodyHtml: `You asked to add a password to the PulseBoard account for <strong>${escapeHtml(email)}</strong>, so you can also log in with your email address.${escapeHtml(connected)} Choose one below; you'll be signed out everywhere else.`,
        buttonLabel: "set password",
        link,
        footer,
    });

    return { subject, text, html };
}
