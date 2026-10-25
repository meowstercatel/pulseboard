import { createHash, randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { sendMail } from "../mail/mailer.js";
import { verifyEmailTemplate } from "../mail/verifyEmailTemplate.js";
import { db } from "../prisma/db.js";
import { publicUrl } from "./publicUrl.js";
import type { AuthEnv } from "./session.js";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
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
        ...verifyEmailTemplate(link, user.email),
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Only Google's verified email proves the address (see linksByEmail)
const PROVES_EMAIL = "google";

// Verifies an account whose address a provider just proved. Anything set up
// before that may be an attacker's, so the password, sessions, links made
// with another address and Facebook links go. Returns null if it was verified
// meanwhile.
export async function claimUnverifiedUser(
    tx: Tx,
    { id, email }: { id: number; email: string },
) {
    const user = await tx.orm.public.User.where({ id, email })
        .where((u) => u.emailVerifiedAt.isNull())
        .update({
            emailVerifiedAt: new Date().toISOString(),
            passwordHash: null,
        });
    if (!user) return null;
    await tx.orm.public.Session.where({ userId: id }).deleteAll();
    await tx.orm.public.OAuthAccount.where({ userId: id })
        .where((a) => a.email.neq(email))
        .deleteAll();
    await tx.orm.public.OAuthAccount.where({ userId: id })
        .where((a) => a.email.isNull())
        .deleteAll();
    await tx.orm.public.OAuthAccount.where({ userId: id })
        .where((a) => a.provider.neq(PROVES_EMAIL))
        .deleteAll();
    return user;
}

// Accounts linked to Google before verification existed: Google already
// verified the address the link was made with, so if the account still uses
// that address it counts as verified. Facebook links don't count: Facebook
// sign-ups stay unverified until the emailed link is used.
export async function verifyOAuthLinkedUsers() {
    const users = db.orm.public.User.where((u) => u.emailVerifiedAt.isNull())
        .where((u) => u.oauthAccounts.some())
        .include("oauthAccounts")
        .all();
    let count = 0;
    for await (const user of users) {
        if (
            !user.oauthAccounts.some(
                (a) => a.provider === PROVES_EMAIL && a.email === user.email,
            )
        )
            continue;
        const updated = await db.transaction((tx) =>
            claimUnverifiedUser(tx, user),
        );
        if (updated) count++;
    }
    if (count) console.log(`Marked ${count} Google user(s) as verified`);
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
