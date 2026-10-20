import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { sendMail } from "../mail/mailer.js";
import { passwordResetTemplate } from "../mail/passwordResetTemplate.js";
import { db } from "../prisma/db.js";
import { hashPassword } from "./password.js";
import { trustedPublicUrl } from "./publicUrl.js";

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

async function createAndSendReset(c: Context, email: string) {
    const linkPrefix = trustedPublicUrl(c, "/reset-password?token=");
    if (!linkPrefix) {
        console.error("Set PUBLIC_URL to send password reset emails");
        return;
    }
    const token = randomBytes(32).toString("base64url");
    const user = await db.transaction(async (tx) => {
        // no-op update to lock the user row until commit
        const user = await tx.orm.public.User.where({ email })
            .where((u) => u.passwordHash.isNotNull())
            .update({ email });
        if (!user) return null;
        await tx.orm.public.PasswordReset.where({
            userId: user.id,
        }).deleteAll();
        await tx.orm.public.PasswordReset.create({
            tokenHash: hashToken(token),
            userId: user.id,
            email: user.email,
            expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
        });
        return user;
    });
    if (!user) return;

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
        return user;
    });
}
