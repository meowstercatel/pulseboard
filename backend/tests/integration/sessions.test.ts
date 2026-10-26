import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { deleteExpiredRows } from "../../src/cleanup.js";
import { hashPassword } from "../../src/auth/password.js";
import {
    LAST_SEEN_INTERVAL_MS,
    SESSION_TTL_MS,
    sessionIdFor,
} from "../../src/auth/session.js";
import { db } from "../../src/prisma/db.js";

const app = createApp();
// what the browser sends, so CSRF checks pass
const origin = process.env["PUBLIC_URL"]!;
const password = "Correct horse battery staple!";
const passwordHash = await hashPassword(password);
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const userIds = new Set<number>();
let ip: string;
let ipSequence = 0;

beforeEach(() => {
    ip = `198.51.100.${++ipSequence}`;
});
afterEach(async () => {
    for (const id of userIds) await db.orm.public.User.where({ id }).delete();
    userIds.clear();
});
afterAll(async () => {
    await db.close();
});

async function account() {
    const user = await db.orm.public.User.create({
        email: `sessions-${randomUUID()}@example.com`,
        passwordHash,
        emailVerifiedAt: new Date().toISOString(),
    });
    userIds.add(user.id);
    return user;
}

type SessionSeed = {
    expiresIn?: number;
    lastSeenAgo?: number | null;
    userAgent?: string | null;
    ip?: string | null;
};

// A session row as an older or other device would have left it
async function seedSession(
    userId: number,
    {
        expiresIn = SESSION_TTL_MS,
        lastSeenAgo = 0,
        userAgent = null,
        ip = null,
    }: SessionSeed = {},
) {
    const token = randomBytes(32).toString("base64url");
    const id = sessionIdFor(token);
    await db.orm.public.Session.create({
        id,
        userId,
        expiresAt: new Date(Date.now() + expiresIn).toISOString(),
        lastSeenAt:
            lastSeenAgo === null
                ? null
                : new Date(Date.now() - lastSeenAgo).toISOString(),
        userAgent,
        ip,
    });
    return { id, cookie: `session=${token}` };
}

function request(
    path: string,
    { cookie, method = "GET", headers = {}, body }: RequestOptions = {},
) {
    return app.request(`/api/${path}`, {
        method,
        headers: {
            origin,
            "x-forwarded-for": ip,
            ...(body === undefined
                ? {}
                : { "content-type": "application/json" }),
            ...(cookie ? { cookie } : {}),
            ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
type RequestOptions = {
    cookie?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
};

const row = (id: string) => db.orm.public.Session.where({ id }).first();

describe("recorded details", () => {
    it("stores a trimmed user agent, the client IP and lastSeenAt on login", async () => {
        const user = await account();
        const before = Date.now();
        const login = await request("auth/login", {
            method: "POST",
            body: { email: user.email, password },
            headers: {
                "user-agent": `  Mozilla/5.0\t\t(Test)  ${"x".repeat(400)}`,
                // the client's own claim comes first; nginx appends the real one
                "x-forwarded-for": `6.6.6.6, ${ip}`,
            },
        });
        expect(login.status).toBe(200);
        const token = login.headers
            .get("set-cookie")!
            .match(/^session=([^;]+)/)![1]!;
        const session = await row(sessionIdFor(token));
        expect(session!.ip).toBe(ip);
        expect(session!.userAgent).toMatch(/^Mozilla\/5\.0 \(Test\) x+$/);
        expect(session!.userAgent).toHaveLength(256);
        expect(new Date(session!.lastSeenAt!).getTime()).toBeGreaterThanOrEqual(
            before - 1000,
        );
    });
});

describe("sliding expiry", () => {
    it("extends a session in use once less than half of its TTL is left", async () => {
        const user = await account();
        const { id, cookie } = await seedSession(user.id, {
            expiresIn: 10 * DAY,
            lastSeenAgo: MINUTE,
        });
        const response = await request("auth/me", { cookie });
        expect(response.status).toBe(200);

        const expiresAt = new Date((await row(id))!.expiresAt).getTime();
        expect(expiresAt).toBeGreaterThan(Date.now() + SESSION_TTL_MS - MINUTE);
        // the browser would otherwise drop the cookie at the old expiry
        const setCookie = response.headers.get("set-cookie");
        expect(setCookie).toContain(cookie);
        const cookieExpiry = Date.parse(
            setCookie!.match(/Expires=([^;]+)/)![1]!,
        );
        expect(Math.abs(cookieExpiry - expiresAt)).toBeLessThan(1000);
    });

    it("leaves a session with more than half its TTL left alone", async () => {
        const user = await account();
        const { id, cookie } = await seedSession(user.id, {
            expiresIn: 20 * DAY,
            lastSeenAgo: MINUTE,
        });
        const before = await row(id);
        const response = await request("auth/me", { cookie });
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(await row(id)).toEqual(before);
    });

    it("does not revive an expired session", async () => {
        const user = await account();
        const { id, cookie } = await seedSession(user.id, { expiresIn: -1000 });
        expect((await request("auth/me", { cookie })).status).toBe(401);
        expect(await row(id)).toBeNull();
    });
});

describe("lastSeenAt", () => {
    it("is written at most once per interval", async () => {
        const user = await account();
        const recent = await seedSession(user.id, {
            lastSeenAgo: LAST_SEEN_INTERVAL_MS - MINUTE,
            ip: "192.0.2.200",
        });
        const before = await row(recent.id);
        expect(
            (await request("auth/me", { cookie: recent.cookie })).status,
        ).toBe(200);
        expect(await row(recent.id)).toEqual(before);

        const stale = await seedSession(user.id, {
            lastSeenAgo: LAST_SEEN_INTERVAL_MS + MINUTE,
            ip: "192.0.2.200",
        });
        const response = await request("auth/me", {
            cookie: stale.cookie,
            headers: { "user-agent": "NewBrowser/2" },
        });
        expect(response.status).toBe(200);
        // only the expiry needs the cookie to be sent again
        expect(response.headers.get("set-cookie")).toBeNull();
        const touched = await row(stale.id);
        expect(
            Date.now() - new Date(touched!.lastSeenAt!).getTime(),
        ).toBeLessThan(10_000);
        expect(touched!.ip).toBe(ip);
        expect(touched!.userAgent).toBe("NewBrowser/2");
    });

    it("is filled in for sessions from before it was recorded", async () => {
        const user = await account();
        const { id, cookie } = await seedSession(user.id, {
            lastSeenAgo: null,
        });
        expect((await request("auth/me", { cookie })).status).toBe(200);
        expect((await row(id))!.lastSeenAt).not.toBeNull();
    });
});

describe("GET /api/auth/sessions", () => {
    it("requires a session", async () => {
        expect((await request("auth/sessions")).status).toBe(401);
    });

    it("lists only the user's unexpired sessions, current first", async () => {
        const user = await account();
        const other = await account();
        const current = await seedSession(user.id, { lastSeenAgo: 2 * DAY });
        const phone = await seedSession(user.id, {
            lastSeenAgo: 10 * MINUTE,
            userAgent: "Phone/1",
            ip: "192.0.2.10",
        });
        const laptop = await seedSession(user.id, {
            lastSeenAgo: DAY,
            userAgent: "Laptop/1",
            ip: "192.0.2.11",
        });
        await seedSession(user.id, { expiresIn: -1000 });
        await seedSession(other.id);

        const response = await request("auth/sessions", {
            cookie: current.cookie,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toContain("no-store");
        const { sessions } = await response.json();
        expect(sessions.map((s: { id: string }) => s.id)).toEqual([
            current.id,
            phone.id,
            laptop.id,
        ]);
        expect(sessions.map((s: { current: boolean }) => s.current)).toEqual([
            true,
            false,
            false,
        ]);
        expect(Object.keys(sessions[1]).sort()).toEqual([
            "createdAt",
            "current",
            "expiresAt",
            "id",
            "ip",
            "lastSeenAt",
            "userAgent",
        ]);
        expect(sessions[1]).toMatchObject({
            userAgent: "Phone/1",
            ip: "192.0.2.10",
        });
    });
});

describe("DELETE /api/auth/sessions/:id", () => {
    it("signs out one of the user's other sessions", async () => {
        const user = await account();
        const current = await seedSession(user.id);
        const other = await seedSession(user.id);
        const response = await request(`auth/sessions/${other.id}`, {
            method: "DELETE",
            cookie: current.cookie,
        });
        expect(response.status).toBe(204);
        expect(await row(other.id)).toBeNull();
        expect(await row(current.id)).not.toBeNull();
        expect(
            (await request("auth/me", { cookie: other.cookie })).status,
        ).toBe(401);
        expect(
            (await request("auth/me", { cookie: current.cookie })).status,
        ).toBe(200);
    });

    it("answers 404 for another user's session and leaves it alone", async () => {
        const user = await account();
        const victim = await account();
        const current = await seedSession(user.id);
        const theirs = await seedSession(victim.id);
        const response = await request(`auth/sessions/${theirs.id}`, {
            method: "DELETE",
            cookie: current.cookie,
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "Session not found" });
        expect(await row(theirs.id)).not.toBeNull();
        expect(
            (await request("auth/me", { cookie: theirs.cookie })).status,
        ).toBe(200);
    });

    it("answers 404 for unknown and malformed ids", async () => {
        const user = await account();
        const current = await seedSession(user.id);
        for (const id of [
            "0".repeat(64),
            "abc",
            current.id.toUpperCase(),
            `${current.id}0`,
        ]) {
            const response = await request(`auth/sessions/${id}`, {
                method: "DELETE",
                cookie: current.cookie,
            });
            expect(response.status).toBe(404);
        }
        expect(await row(current.id)).not.toBeNull();
    });

    it("signs this browser out when it revokes its own session", async () => {
        const user = await account();
        const current = await seedSession(user.id);
        const response = await request(`auth/sessions/${current.id}`, {
            method: "DELETE",
            cookie: current.cookie,
        });
        expect(response.status).toBe(204);
        expect(response.headers.get("set-cookie")).toMatch(/^session=;/);
        expect(await row(current.id)).toBeNull();
    });

    it("requires a session", async () => {
        const user = await account();
        const other = await seedSession(user.id);
        const response = await request(`auth/sessions/${other.id}`, {
            method: "DELETE",
        });
        expect(response.status).toBe(401);
        expect(await row(other.id)).not.toBeNull();
    });
});

describe("POST /api/auth/sessions/revoke-others", () => {
    it("signs out every other session of the user only", async () => {
        const user = await account();
        const bystander = await account();
        const current = await seedSession(user.id);
        const others = [await seedSession(user.id), await seedSession(user.id)];
        const theirs = await seedSession(bystander.id);

        const response = await request("auth/sessions/revoke-others", {
            method: "POST",
            cookie: current.cookie,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ revoked: 2 });
        for (const { id } of others) expect(await row(id)).toBeNull();
        expect(await row(current.id)).not.toBeNull();
        expect(await row(theirs.id)).not.toBeNull();

        const list = await request("auth/sessions", { cookie: current.cookie });
        const { sessions } = await list.json();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({ id: current.id, current: true });
    });
});

describe("csrf", () => {
    it("rejects cross-site revocations", async () => {
        const user = await account();
        const current = await seedSession(user.id);
        const other = await seedSession(user.id);
        for (const headers of <Record<string, string>[]>[
            { origin: "https://evil.example" },
            { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        ]) {
            const one = await request(`auth/sessions/${other.id}`, {
                method: "DELETE",
                cookie: current.cookie,
                headers,
            });
            expect(one.status).toBe(403);
            const all = await request("auth/sessions/revoke-others", {
                method: "POST",
                cookie: current.cookie,
                headers,
            });
            expect(all.status).toBe(403);
        }
        expect(await row(other.id)).not.toBeNull();
    });
});

describe("expired row cleanup", () => {
    it("deletes expired sessions even if they were seen recently", async () => {
        const user = await account();
        const expired = await seedSession(user.id, {
            expiresIn: -1000,
            lastSeenAgo: 0,
        });
        const active = await seedSession(user.id, {
            expiresIn: 2 * DAY,
            lastSeenAgo: 40 * DAY,
        });
        await deleteExpiredRows();
        expect(await row(expired.id)).toBeNull();
        expect(await row(active.id)).not.toBeNull();
    });
});
