import { createTransport, type Transporter } from "nodemailer";

export type Mail = { to: string; subject: string; text: string; html: string };

const FROM =
    process.env["MAIL_FROM"] || "PulseBoard <no-reply@pulseboard.local>";

// SMTP_URL is e.g. smtp://mailpit:1025 or smtps://user:pass@smtp.example.com:465.
// Without it mail is printed to the console, which is enough for local dev.
const smtpUrl = process.env["SMTP_URL"];
// Give up quickly on a dead server instead of nodemailer's minutes-long
// defaults; some mail (resending a verification link) is sent while the
// request waits
const transport: Transporter | null = smtpUrl
    ? createTransport({
          url: smtpUrl,
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 20_000,
      })
    : null;

export async function sendMail(mail: Mail) {
    if (!transport) {
        console.log(`[mail] to ${mail.to}: ${mail.subject}\n${mail.text}`);
        return;
    }
    await transport.sendMail({ from: FROM, ...mail });
}
