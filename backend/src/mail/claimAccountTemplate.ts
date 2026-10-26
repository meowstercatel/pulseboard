import { actionEmailHtml, escapeHtml } from "./layout.js";

// Sent after someone opens a verification link and says they didn't create
// the account: the link is a password reset link, the way back in
export function claimAccountTemplate(link: string, email: string) {
    const subject = "Choose a password for PulseBoard";
    const footer =
        "The link expires in 1 hour and works once. If it expires, ask for a new one with “Forgot password?” on the login page.";
    const text = `Choose a password

You said you didn't create the PulseBoard account for ${email}. The address is now verified, everyone who was signed in to the account has been signed out, and the password it was set up with no longer works. Choose your own password by opening this link:

${link}

${footer}`;

    const html = actionEmailHtml({
        subject,
        preheader: "Choose your own password for your PulseBoard account.",
        heading: "Choose a password",
        bodyHtml: `You said you didn't create the PulseBoard account for <strong>${escapeHtml(email)}</strong>. The address is now verified, everyone who was signed in to the account has been signed out, and the password it was set up with no longer works. Choose your own password below.`,
        buttonLabel: "choose password",
        link,
        footer,
    });

    return { subject, text, html };
}
