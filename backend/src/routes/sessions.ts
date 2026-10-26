import { Hono } from "hono";
import { destroySession, requireAuth, type AuthEnv } from "../auth/session.js";
import { db } from "../prisma/db.js";

// Session ids are the SHA-256 (hex) of the cookie token. Exposing them is safe:
// the cookie is hashed again on every request, so an id can't be used to sign in.
const SESSION_ID_RE = /^[0-9a-f]{64}$/;

export const sessions = new Hono<AuthEnv>();

sessions.use(requireAuth);

// The signed-in user's unexpired sessions, most recently used first
sessions.get("/", async (c) => {
    const now = new Date().toISOString();
    const rows = await db.orm.public.Session.where({ userId: c.get("user").id })
        .where((s) => s.expiresAt.gt(now))
        .select("id", "userAgent", "ip", "createdAt", "lastSeenAt", "expiresAt")
        .all();
    const current = c.get("sessionId");
    const list = rows
        .map((s) => ({ ...s, current: s.id === current }))
        .sort(
            (a, b) =>
                Number(b.current) - Number(a.current) ||
                (b.lastSeenAt ?? b.createdAt).localeCompare(
                    a.lastSeenAt ?? a.createdAt,
                ),
        );
    c.header("Cache-Control", "private, no-store");
    return c.json({ sessions: list });
});

// Signs out every session but this one
sessions.post("/revoke-others", async (c) => {
    const revoked = await db.orm.public.Session.where({
        userId: c.get("user").id,
    })
        .where((s) => s.id.neq(c.get("sessionId")))
        .deleteAndCount();
    return c.json({ revoked });
});

sessions.delete("/:id", async (c) => {
    const id = c.req.param("id");
    // Another user's session is "not found" too, so ids can't be probed
    if (!SESSION_ID_RE.test(id)) {
        return c.json({ error: "Session not found" }, 404);
    }
    if (id === c.get("sessionId")) {
        await destroySession(c);
        return c.body(null, 204);
    }
    const deleted = await db.orm.public.Session.where({
        id,
        userId: c.get("user").id,
    }).delete();
    if (!deleted) return c.json({ error: "Session not found" }, 404);
    return c.body(null, 204);
});
