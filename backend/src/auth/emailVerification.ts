import { createHash, randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { sendMail } from "../mail/mailer.js";
import { db } from "../prisma/db.js";
import { publicUrl } from "./publicUrl.js";
import type { AuthEnv } from "./session.js";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

// Replaces any earlier link for this user, so only the newest one works.
// Returns false (and sends nothing) if the email is already verified.
export async function sendVerificationEmail(
    c: Context,
    userId: number,
): Promise<boolean> {
    const token = randomBytes(32).toString("base64url");
    const user = await db.transaction(async (tx) => {
        // A no-op update locks the user row until commit, so an email change
        // can't slip in between reading the address and storing its token,
        // and we always send to the address the account has right now
        const user = await tx.orm.public.User.where({ id: userId })
            .where((u) => u.emailVerifiedAt.isNull())
            .update({ emailVerifiedAt: null });
        if (!user) return null;
        await tx.orm.public.EmailVerification.where({ userId }).deleteAll();
        await tx.orm.public.EmailVerification.create({
            tokenHash: hashToken(token),
            userId,
            email: user.email,
            expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
        });
        return user;
    });
    if (!user) return false;

    const link = publicUrl(c, `/verify-email?token=${token}`);
    await sendMail({
        to: user.email,
        subject: "Verify your PulseBoard email address",
        text: `Confirm this email address for your PulseBoard account by opening:\n\n${link}\n\nThe link expires in 24 hours. If you didn't create an account, ignore this email.`,
        html: `<p>Confirm this email address for your PulseBoard account:</p><p><a href="${escapeHtml(link)}">Verify email address</a></p><p>The link expires in 24 hours. If you didn't create an account, ignore this email.</p>`,
    });
    return true;
}

// Sending can fail (SMTP down, bad address); the account change still stands
// and the user can ask for a new link, so only log it.
export async function trySendVerificationEmail(c: Context, userId: number) {
    try {
        await sendVerificationEmail(c, userId);
    } catch (err) {
        console.error(
            `Couldn't send verification email to user ${userId}`,
            err,
        );
    }
}

// Accounts linked to Google/Facebook before verification existed: the
// provider already verified the address the link was made with, so if the
// account still uses that address it counts as verified.
export async function verifyOAuthLinkedUsers() {
    const users = db.orm.public.User.where((u) => u.emailVerifiedAt.isNull())
        .where((u) => u.oauthAccounts.some())
        .include("oauthAccounts")
        .all();
    let count = 0;
    for await (const user of users) {
        if (!user.oauthAccounts.some((a) => a.email === user.email)) continue;
        const updated = await db.orm.public.User.where({
            id: user.id,
            email: user.email,
        })
            .where((u) => u.emailVerifiedAt.isNull())
            .update({ emailVerifiedAt: new Date().toISOString() });
        if (updated) count++;
    }
    if (count)
        console.log(`Marked ${count} Google/Facebook user(s) as verified`);
}

// Returns the verified user, or null if the token is unknown, expired, or was
// sent to an address the account no longer uses.
export async function verifyEmailToken(token: string) {
    const tokenHash = hashToken(token);
    return db.transaction(async (tx) => {
        const pending = await tx.orm.public.EmailVerification.where({
            tokenHash,
        }).first();
        if (!pending) return null;
        if (new Date(pending.expiresAt).getTime() <= Date.now()) {
            await tx.orm.public.EmailVerification.where({ tokenHash }).delete();
            return null;
        }

        const user = await tx.orm.public.User.where({
            id: pending.userId,
            email: pending.email,
        }).update({ emailVerifiedAt: new Date().toISOString() });
        await tx.orm.public.EmailVerification.where({
            userId: pending.userId,
        }).deleteAll();
        return user;
    });
}

export const requireVerifiedEmail: MiddlewareHandler<AuthEnv> = async (
    c,
    next,
) => {
    if (!c.get("user").emailVerified) {
        return c.json({ error: "Verify your email address first" }, 403);
    }
    await next();
};
