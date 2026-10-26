import { Hono } from "hono";
import { notifyAccountChange } from "../auth/accountNotice.js";
import { PROVIDER_NAMES, providers } from "../auth/oauth.js";
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
    const user = await db.orm.public.User.where({ id: userId })
        .select("passwordHash")
        .first();
    if (!user) return c.json({ error: "Not logged in" }, 401);
    const accounts = await db.orm.public.OAuthAccount.where({ userId })
        .select("id", "provider", "email", "createdAt")
        .all();
    accounts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    c.header("Cache-Control", "private, no-store");
    return c.json({
        hasPassword: user.passwordHash !== null,
        accounts,
        providers: Object.keys(providers),
    });
});

// Disconnects one login. The last way to log in can't be removed: a password
// or a login with a provider that is still enabled has to remain.
connectedAccounts.delete("/:id", async (c) => {
    const param = c.req.param("id");
    // Another user's link is "not found" too, so ids can't be probed
    if (!ID_RE.test(param)) {
        return c.json({ error: "Connected account not found" }, 404);
    }
    const id = Number(param);
    const userId = c.get("user").id;
    const sessionId = c.get("sessionId");

    const result = await db.transaction(async (tx) => {
        const current = await tx.orm.public.User.where({ id: userId }).first();
        if (!current) return null;
        // no-op update to lock the user row, so two parallel unlinks (or a
        // password change) can't together remove the last login
        const user = await tx.orm.public.User.where({
            id: userId,
            email: current.email,
        }).update({ email: current.email });
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
        // Sessions opened with that login end with it; this device stays
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
