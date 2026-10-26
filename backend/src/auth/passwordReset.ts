import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { sendMail } from "../mail/mailer.js";
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

async function createAndSendReset(c: Context, email: string) {
    const linkPrefix = publicUrl(c, "/reset-password?token=");
    const reset = await db.transaction(async (tx) => {
        // no-op update to lock the user row until commit
        const user = await tx.orm.public.User.where({ email })
            .where((u) => u.passwordHash.isNotNull())
            .update({ email });
        if (!user) return null;
        return { user, token: await storeToken(tx, user, { replace: true }) };
    });
    if (!reset) return;
    const { user, token } = reset;

    sendMail({
        to: user.email,
        ...passwordResetTemplate(linkPrefix + token, user.email),
    }).catch((err) => {
        console.error(
            `Couldn't send password reset email to user ${user.id}`,
            err,
        );
    });
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
    const linkPrefix = publicUrl(c, "/reset-password?purpose=set&token=");
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
        const logins = await tx.orm.public.OAuthAccount.where({ userId })
            .select("provider", "email")
            .all();
        // Earlier links keep working: if this email can't be sent, the
        // last one that arrived still can be used
        const token = await storeToken(tx, user, { replace: false });
        return { user, logins, token };
    });
    if (typeof setup === "string") return setup;
    await sendMail({
        to: setup.user.email,
        ...setPasswordTemplate(
            linkPrefix + setup.token,
            setup.user.email,
            setup.logins.map(
                ({ provider, email }) =>
                    (PROVIDER_NAMES[provider] ?? provider) +
                    (email ? ` (${email})` : ""),
            ),
        ),
    });
    return "sent";
}

// Returns the user, and whether the account had no password before (a link
// from sendPasswordSetup), or null if the link is invalid or expired
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
        await tx.orm.public.PasswordReset.where({
            userId: user.id,
        }).deleteAll();
        await tx.orm.public.Session.where({ userId: user.id }).deleteAll();
        return { user, passwordWasSet: current.passwordHash === null };
    });
}
