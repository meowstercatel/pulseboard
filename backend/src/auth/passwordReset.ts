import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { startTrial } from "../billing/trial.js";
import { sendMail } from "../mail/mailer.js";
import { claimAccountTemplate } from "../mail/claimAccountTemplate.js";
import {
    claimUnverifiedUser,
    dropUnprovenLogins,
    lockVerification,
    trySendVerificationEmail,
} from "./emailVerification.js";
import { passwordResetTemplate } from "../mail/passwordResetTemplate.js";
import { setPasswordTemplate } from "../mail/setPasswordTemplate.js";
import { db } from "../prisma/db.js";
import { PROVIDER_NAMES } from "./oauth.js";
import { hashPassword } from "./password.js";
import { publicUrl } from "./publicUrl.js";

const TOKEN_TTL_MS = 60 * 60 * 1000;
// Padding so the response time doesn't reveal whether the account exists
const MIN_RESPONSE_MS = 250;

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

export async function requestPasswordReset(c: Context, email: string) {
    const padding = new Promise((r) => setTimeout(r, MIN_RESPONSE_MS));
    await createAndSendReset(c, email);
    await padding;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// With `replace`, earlier links for this user stop working. Using any link
// deletes them all (see resetPassword), and so does an email change.
async function storeToken(
    tx: Tx,
    user: { id: number; email: string },
    { replace }: { replace: boolean },
): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    if (replace) {
        await tx.orm.public.PasswordReset.where({
            userId: user.id,
        }).deleteAll();
    }
    await tx.orm.public.PasswordReset.create({
        tokenHash: hashToken(token),
        userId: user.id,
        email: user.email,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
    });
    return token;
}

// After the #, so it never reaches a server or its logs. The reset page puts
// it in a hidden username field, so password managers save the new password
// for the right account.
function emailHint(email: string) {
    return `#email=${encodeURIComponent(email)}`;
}

// A verified account without a password gets the set-password link instead,
// so an owner left with no login (see verifyEmailToken) can always get back
// in. An unverified one gets a new verification link: proving its address is
// that link's job, which also removes logins someone else set up. Earlier
// links keep working, so asking for one can't cancel the owner's.
async function createAndSendReset(c: Context, email: string) {
    const reset = await db.transaction(async (tx) => {
        // no-op update to lock the user row until commit
        const user = await tx.orm.public.User.where({ email }).update({
            email,
        });
        if (!user) return null;
        if (!user.passwordHash) {
            if (!user.emailVerifiedAt) {
                return { verify: true as const, userId: user.id };
            }
            return setupMail(c, tx, user);
        }
        const token = await storeToken(tx, user, { replace: true });
        return {
            to: user.email,
            ...passwordResetTemplate(
                publicUrl(
                    c,
                    `/reset-password?token=${token}${emailHint(user.email)}`,
                ),
                user.email,
            ),
            userId: user.id,
        };
    });
    if (!reset) return;
    // after the transaction, which still holds the user row it locks
    if (reset.verify) {
        return trySendVerificationEmail(c, reset.userId, { replace: false });
    }
    const { userId, ...mail } = reset;
    sendMail(mail).catch((err) => {
        console.error(
            `Couldn't send password reset email to user ${userId}`,
            err,
        );
    });
}

// Earlier links keep working: if this email can't be sent, the last one that
// arrived still can be used
async function setupMail(
    c: Context,
    tx: Tx,
    user: { id: number; email: string },
) {
    const logins = await tx.orm.public.OAuthAccount.where({ userId: user.id })
        .select("provider", "email")
        .all();
    const token = await storeToken(tx, user, { replace: false });
    return {
        to: user.email,
        ...setPasswordTemplate(
            publicUrl(
                c,
                `/reset-password?purpose=set&token=${token}${emailHint(user.email)}`,
            ),
            user.email,
            logins.map(
                ({ provider, email }) =>
                    (PROVIDER_NAMES[provider] ?? provider) +
                    (email ? ` (${email})` : ""),
            ),
        ),
        userId: user.id,
    };
}

// Emails a link that adds a password to an account that only signs in with
// Google/Facebook. It is a password reset link (same table, page and confirm
// endpoint), only worded differently. The address must already be verified,
// so this link never becomes a second way to verify it.
export type PasswordSetup =
    | "sent"
    | "has_password"
    | "unverified"
    // the account was deleted meanwhile
    | "gone";

export async function sendPasswordSetup(
    c: Context,
    userId: number,
): Promise<PasswordSetup> {
    const setup = await db.transaction(async (tx) => {
        const current = await tx.orm.public.User.where({ id: userId }).first();
        if (!current) return "gone" as const;
        // no-op update to lock the user row until commit, and only while
        // the address is still the one just read
        const user = await tx.orm.public.User.where({
            id: userId,
            email: current.email,
        }).update({ email: current.email });
        if (!user) return "gone" as const;
        if (user.passwordHash) return "has_password" as const;
        if (!user.emailVerifiedAt) return "unverified" as const;
        return setupMail(c, tx, user);
    });
    if (typeof setup === "string") return setup;
    const { userId: _, ...mail } = setup;
    await sendMail(mail);
    return "sent";
}

// Returns the user, whether the account had no password before (a link from
// sendPasswordSetup) and the providers of the logins removed, or null if the
// link is invalid or expired
export async function resetPassword(token: string, newPassword: string) {
    const tokenHash = hashToken(token);
    const passwordHash = await hashPassword(newPassword);
    return db.transaction(async (tx) => {
        const pending = await tx.orm.public.PasswordReset.where({
            tokenHash,
        }).first();
        if (!pending) return null;
        // lock the user before the token, like other account changes, to avoid deadlocks
        const current = await tx.orm.public.User.where({
            id: pending.userId,
            email: pending.email,
        }).update({ email: pending.email });
        // deleting claims the token, so it can't be used twice
        const claimed = await tx.orm.public.PasswordReset.where({
            tokenHash,
        }).delete();
        if (
            !current ||
            !claimed ||
            new Date(pending.expiresAt).getTime() <= Date.now()
        ) {
            return null;
        }
        const user = await tx.orm.public.User.where({
            id: current.id,
            email: current.email,
        }).update({
            passwordHash,
            // the emailed link proves they own the address
            emailVerifiedAt:
                current.emailVerifiedAt ?? new Date().toISOString(),
        });
        if (!user) return null;
        // Like the verification link, this proves the address of an account
        // someone else may have set up with it (and since replaced the
        // password of), so the logins it can't vouch for go too
        const removedLogins = current.emailVerifiedAt
            ? []
            : (await dropUnprovenLogins(tx, user.id, user.email)).removed;
        await tx.orm.public.PasswordReset.where({
            userId: user.id,
        }).deleteAll();
        await tx.orm.public.Session.where({ userId: user.id }).deleteAll();
        return {
            user: (await startTrial(tx, user.id)) ?? user,
            passwordWasSet: current.passwordHash === null,
            removedLogins,
        };
    });
}

// "I didn't create this account", from the page a verification link opens.
// The link proves the clicker owns the address, so the account becomes
// theirs, without anything whoever registered it set up: the address is
// verified, the password stops working, every session ends and the logins
// that don't prove the address go (see claimUnverifiedUser). A reset link to
// the address lets the owner choose their own password. Returns null if the
// token is unknown, expired, or was sent to an address the account no longer
// uses; `emailSent` is false if the link couldn't be sent, and "Forgot
// password?" sends a new one.
export async function disownAccount(c: Context, token: string) {
    const claimed = await db.transaction(async (tx) => {
        const pending = await lockVerification(tx, token);
        if (!pending) return null;
        const user = await claimUnverifiedUser(tx, pending);
        // the link is used up, like any verification
        await tx.orm.public.EmailVerification.where({
            userId: pending.id,
        }).deleteAll();
        if (!user) return null;
        // set-password links go with every other way in
        const reset = await storeToken(tx, user, { replace: true });
        return { user, reset };
    });
    if (!claimed) return null;
    const { user, reset } = claimed;
    let emailSent = true;
    try {
        await sendMail({
            to: user.email,
            ...claimAccountTemplate(
                publicUrl(
                    c,
                    `/reset-password?purpose=set&token=${reset}${emailHint(user.email)}`,
                ),
                user.email,
            ),
        });
    } catch (err) {
        console.error(
            `Couldn't send the password link to disowned user ${user.id}`,
            err,
        );
        emailSent = false;
    }
    return { user, emailSent };
}
