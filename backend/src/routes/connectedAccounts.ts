import { Hono } from "hono";
import { notifyAccountChange } from "../auth/accountNotice.js";
import { PROVIDER_NAMES, providers } from "../auth/oauth.js";
import { limitAccountChanges, reauthenticate } from "../auth/reauth.js";
import {
    requireAuth,
    revokeOtherSessions,
    type AuthEnv,
} from "../auth/session.js";
import { db } from "../prisma/db.js";

const ID_RE = /^[1-9]\d{0,9}$/;

export const connectedAccounts = new Hono<AuthEnv>();

connectedAccounts.use(requireAuth);

// The signed-in user's Google/Facebook logins, whether they have a password,
// and which providers can be connected. Linking starts at
// POST /api/auth/oauth/:provider/link.
connectedAccounts.get("/", async (c) => {
    const userId = c.get("user").id;
    const [user, accounts] = await Promise.all([
        db.orm.public.User.where({ id: userId }).select("passwordHash").first(),
        db.orm.public.OAuthAccount.where({ userId })
            .select("id", "provider", "email", "createdAt")
            .orderBy((a) => a.createdAt.asc())
            .all(),
    ]);
    if (!user) return c.json({ error: "Not logged in" }, 401);
    c.header("Cache-Control", "private, no-store");
    return c.json({
        hasPassword: user.passwordHash !== null,
        accounts,
        providers: Object.keys(providers),
    });
});

// Disconnects one login. The last way to log in can't be removed: a password
// or a login with a provider that is still enabled has to remain. Like
// linking, it asks for the password (or a fresh sign-in), so a stolen
// session can't strip the owner's logins and sign out their devices.
connectedAccounts.delete("/:id", limitAccountChanges, async (c) => {
    const param = c.req.param("id");
    // Another user's link is "not found" too, so ids can't be probed
    if (!ID_RE.test(param)) {
        return c.json({ error: "Connected account not found" }, 404);
    }
    const id = Number(param);
    const userId = c.get("user").id;
    const sessionId = c.get("sessionId");

    const body: unknown = c.req
        .header("content-type")
        ?.startsWith("application/json")
        ? await c.req.json().catch(() => null)
        : null;
    const currentPassword =
        body && typeof body === "object"
            ? (body as Record<string, unknown>)["currentPassword"]
            : undefined;
    const before = await db.orm.public.User.where({ id: userId }).first();
    if (!before) return c.json({ error: "Not logged in" }, 401);
    const reauth = await reauthenticate(before, sessionId, currentPassword);
    if (reauth === "wrong_password") {
        return c.json({ error: "Current password is incorrect" }, 400);
    }
    if (reauth === "sign_in_again") {
        return c.json(
            {
                error: "Sign in again with Google or Facebook, then disconnect the account within 10 minutes",
            },
            403,
        );
    }

    const result = await db.transaction(async (tx) => {
        // no-op update to lock the user row, so two parallel unlinks (or a
        // password change) can't together remove the last login. Matching
        // the password re-checked above means it wasn't changed meanwhile.
        const user = await tx.orm.public.User.where({
            id: userId,
            email: before.email,
            passwordHash: before.passwordHash,
        }).update({ email: before.email });
        if (!user) return null;
        const accounts = await tx.orm.public.OAuthAccount.where({
            userId,
        }).all();
        const target = accounts.find((a) => a.id === id);
        if (!target) return "not_found" as const;
        const remaining =
            (user.passwordHash ? 1 : 0) +
            accounts.filter((a) => a.id !== id && providers[a.provider]).length;
        if (!remaining) return "last" as const;
        await tx.orm.public.OAuthAccount.where({ id, userId }).delete();
        // Sessions don't record which login opened them, so every other one
        // ends; this device stays, having just proved it's the owner
        const revoked = await revokeOtherSessions(userId, sessionId, tx);
        return { user, target, revoked };
    });

    if (!result) {
        return c.json(
            { error: "Your account changed. Reload and try again" },
            409,
        );
    }
    if (result === "not_found") {
        return c.json({ error: "Connected account not found" }, 404);
    }
    if (result === "last") {
        return c.json(
            {
                error: "This is your only way to log in. Set a password or connect another account first",
            },
            409,
        );
    }
    const provider = result.target.provider;
    notifyAccountChange(c, result.user, {
        kind: "unlinked",
        provider: PROVIDER_NAMES[provider] ?? provider,
    });
    return c.json({ revoked: result.revoked });
});
