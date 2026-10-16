// Email clients ignore <style> blocks and modern layout, so this is
// table-based with inline styles. Colours and type follow the app's Carbon theme.

const FONT = "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif";

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function verifyEmailTemplate(link: string, email: string) {
    const subject = "Verify your PulseBoard email address";
    const text = `Verify your email address

Confirm that ${email} belongs to your PulseBoard account by opening this link:

${link}

The link expires in 24 hours. If you didn't create a PulseBoard account, you can ignore this email.`;

    const href = escapeHtml(link);
    // Mirrors AuthLayout: a centered 600px card with a soft shadow, the light
    // "PulseBoard" heading, and a full-width primary button
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;">
<div style="display:none;max-height:0;overflow:hidden;">Confirm your email to finish setting up PulseBoard.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
<tr><td align="center" style="padding:48px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;border:1px solid #e0e0e0;box-shadow:0 0 4px 2px rgba(0,0,0,0.25);">
<tr><td style="padding:16px;font-family:${FONT};color:#161616;">
<h1 style="margin:0 0 24px;font-size:42px;line-height:50px;font-weight:300;">PulseBoard</h1>
<p style="margin:0 0 8px;font-size:20px;line-height:28px;">Verify your email address</p>
<p style="margin:0 0 24px;font-size:16px;line-height:24px;">Confirm that <strong>${escapeHtml(email)}</strong> belongs to your PulseBoard account to finish setting it up.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="background:#0f62fe;"><a href="${href}" style="display:block;padding:15px 16px;font-family:${FONT};font-size:14px;line-height:18px;color:#ffffff;text-decoration:none;">verify email</a></td>
</tr></table>
<p style="margin:24px 0 4px;font-size:12px;line-height:16px;color:#525252;">Button not working? Paste this link into your browser:</p>
<p style="margin:0 0 24px;font-size:12px;line-height:16px;word-break:break-all;"><a href="${href}" style="color:#0f62fe;text-decoration:none;">${href}</a></p>
<p style="margin:0;font-size:12px;line-height:16px;color:#525252;">The link expires in 24 hours. If you didn't create a PulseBoard account, you can ignore this email.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

    return { subject, text, html };
}
