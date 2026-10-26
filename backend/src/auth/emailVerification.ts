import { createHash, randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { sendMail } from "../mail/mailer.js";
import { verifyEmailTemplate } from "../mail/verifyEmailTemplate.js";
import { db } from "../prisma/db.js";
import { providers } from "./oauth.js";
import { publicUrl } from "./publicUrl.js";
import { revokeOtherSessions, type AuthEnv } from "./session.js";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

// Replaces any earlier link for this user, so only the newest one works,
// unless `replace` is false: a link anyone can ask for by address mustn't
// cancel the one already in the owner's inbox. Returns null if the email is
// already verified.
async function createVerificationMail(
    c: Context,
    userId: number,
    { replace = true }: { replace?: boolean } = {},
) {
    const token = randomBytes(32).toString("base64url");
    const user = await db.transaction(async (tx) => {
        // A no-op update locks the user row until commit, so an email change
        // can't slip in between reading the address and storing its token,
        // and we always send to the address the account has right now
        const user = await tx.orm.public.User.where({ id: userId })
            .where((u) => u.emailVerifiedAt.isNull())
            .update({ emailVerifiedAt: null });
        if (!user) return null;
        if (replace) {
            await tx.orm.public.EmailVerification.where({
                userId,
            }).deleteAll();
        }
        await tx.orm.public.EmailVerification.create({
            tokenHash: hashToken(token),
            userId,
            email: user.email,
            expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
        });
        return user;
    });
    if (!user) return null;

    const link = publicUrl(c, `/verify-email?token=${token}`);
    return { to: user.email, ...verifyEmailTemplate(link, user.email) };
}

// Returns false (and sends nothing) if the email is already verified.
export async function sendVerificationEmail(
    c: Context,
    userId: number,
): Promise<boolean> {
    const mail = await createVerificationMail(c, userId);
    if (!mail) return false;
    await sendMail(mail);
    return true;
}

// Sending can fail (SMTP down, bad address); the account change still stands
// and the user can ask for a new link, so only log it. The link is stored
// before this returns, but the mail is sent in the background so a slow SMTP
// server doesn't hold up the response.
export async function trySendVerificationEmail(
    c: Context,
    userId: number,
    options?: { replace?: boolean },
) {
    const logFailure = (err: unknown) =>
        console.error(
            `Couldn't send verification email to user ${userId}`,
            err,
        );
    try {
        const mail = await createVerificationMail(c, userId, options);
        if (mail) sendMail(mail).catch(logFailure);
    } catch (err) {
        logFailure(err);
    }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Only Google's verified email proves the address (see linksByEmail)
const PROVES_EMAIL = "google";

// Removes the logins the owner of `email` can't be sure are theirs: every
// provider but Google, and Google links stored without a verified address or
// with another one (see linkAccount). The caller holds the user row lock, so
// no login is added meanwhile. Returns the providers removed and kept.
export async function dropUnprovenLogins(
    tx: Tx,
    userId: number,
    email: string,
) {
    const logins = await tx.orm.public.OAuthAccount.where({ userId })
        .select("provider", "email")
        .all();
    const proven = (a: { provider: string; email: string | null }) =>
        a.provider === PROVES_EMAIL && a.email === email;
    await tx.orm.public.OAuthAccount.where({ userId })
        .where((a) => a.provider.neq(PROVES_EMAIL))
        .deleteAll();
    await tx.orm.public.OAuthAccount.where({ userId })
        .where((a) => a.email.isNull())
        .deleteAll();
    await tx.orm.public.OAuthAccount.where({ userId })
        .where((a) => a.email.neq(email))
        .deleteAll();
    return {
        removed: logins.filter((a) => !proven(a)).map((a) => a.provider),
        kept: logins.filter(proven).map((a) => a.provider),
    };
}

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
    await dropUnprovenLogins(tx, id, email);
    return user;
}

// Verifies the address the token was sent to. Every session of the account
// ends except `session`, if it's one of the account's own. Returns null if the
// token is unknown, expired, or was sent to an address the account no longer
// uses.
//
// A password-less account opened from anywhere else may have been set up by
// someone else with the owner's address (a Facebook sign-up doesn't prove
// it), so its logins that don't prove the address go too: the clicker owns
// the address and gets the account, without anyone else's way in.
export async function verifyEmailToken(token: string, session: string | null) {
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

        // Locks the user row, like a link or an unlink does, so neither can
        // run between this and the removals below
        const user = await tx.orm.public.User.where({
            id: pending.userId,
            email: pending.email,
        }).update({ emailVerifiedAt: new Date().toISOString() });
        await tx.orm.public.EmailVerification.where({
            userId: pending.userId,
        }).deleteAll();
        if (!user) return null;

        const own = session
            ? await tx.orm.public.Session.where({
                  id: session,
                  userId: user.id,
              })
                  .where((s) => s.expiresAt.gt(new Date().toISOString()))
                  .first()
            : null;
        let removedLogins: string[] = [];
        let remaining: string[] | null = null;
        if (!own && !user.passwordHash) {
            const logins = await dropUnprovenLogins(tx, user.id, user.email);
            removedLogins = logins.removed;
            remaining = logins.kept;
            // a set-password link can't exist before verification, but one
            // must never outlive this either
            await tx.orm.public.PasswordReset.where({
                userId: user.id,
            }).deleteAll();
        }
        // After the logins: a sign-in with a removed login that got in first
        // has committed its session by now, so it goes too
        await revokeOtherSessions(user.id, own ? own.id : null, tx);

        // only needed (and only possibly empty) without a password
        remaining ??= user.passwordHash
            ? []
            : (
                  await tx.orm.public.OAuthAccount.where({ userId: user.id })
                      .select("provider")
                      .all()
              ).map((a) => a.provider);
        return {
            user,
            // `session` is the account's own and stays signed in
            kept: !!own,
            // providers whose logins were removed
            removedLogins,
            // nothing left to log in with later: no password, and no login
            // with a provider that is still enabled
            needsPassword:
                !user.passwordHash &&
                !remaining.some((provider) => providers[provider]),
        };
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
