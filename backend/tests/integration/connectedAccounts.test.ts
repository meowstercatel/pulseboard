import { randomBytes, randomUUID } from "node:crypto";
import nock from "nock";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";

// Providers are read from the environment when the module is first imported
vi.hoisted(() => {
    process.env["GOOGLE_CLIENT_ID"] = "google-test-client";
    process.env["GOOGLE_CLIENT_SECRET"] = "google-test-secret";
    process.env["FACEBOOK_APP_ID"] = "facebook-test-app";
    process.env["FACEBOOK_APP_SECRET"] = "facebook-test-secret";
});

import { createApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import { sessionIdFor } from "../../src/auth/session.js";
import { sendMail } from "../../src/mail/mailer.js";
import { db } from "../../src/prisma/db.js";

vi.mock("../../src/mail/mailer.js", () => ({
    sendMail: vi.fn().mockResolvedValue(undefined),
}));

const app = createApp();
const mail = vi.mocked(sendMail);
// what the browser sends, so CSRF checks pass
const origin = process.env["PUBLIC_URL"]!;
const password = "Correct horse battery staple!";
const passwordHash = await hashPassword(password);
const MINUTE = 60 * 1000;
const userIds = new Set<number>();
let ip: string;
let ipSequence = 0;

beforeAll(() => {
    nock.disableNetConnect();
    nock.enableNetConnect(/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/);
});
beforeEach(() => {
    ip = `203.0.113.${++ipSequence}`;
    mail.mockClear();
});
afterEach(async () => {
    nock.cleanAll();
    for (const id of userIds) await db.orm.public.User.where({ id }).delete();
    userIds.clear();
});
afterAll(async () => {
    await db.close();
    nock.enableNetConnect();
});

type RequestOptions = { cookie?: string; method?: string; body?: unknown };

function request(
    path: string,
    { cookie, method = "GET", body }: RequestOptions = {},
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
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

type AccountSeed = {
    withPassword?: boolean;
    verified?: boolean;
    links?: { provider: string; providerUserId?: string }[];
};

async function account({
    withPassword = false,
    verified = true,
    links = [],
}: AccountSeed = {}) {
    const user = await db.orm.public.User.create({
        email: `linking-${randomUUID()}@example.com`,
        passwordHash: withPassword ? passwordHash : null,
        emailVerifiedAt: verified ? new Date().toISOString() : null,
    });
    userIds.add(user.id);
    for (const link of links) {
        await db.orm.public.OAuthAccount.create({
            provider: link.provider,
            providerUserId:
                link.providerUserId ?? `${link.provider}-${randomUUID()}`,
            userId: user.id,
            email: user.email,
        });
    }
    return user;
}

// A session row; `age` makes it look opened that long ago
async function session(userId: number, age = 0) {
    const token = randomBytes(32).toString("base64url");
    const id = sessionIdFor(token);
    await db.orm.public.Session.create({
        id,
        userId,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * MINUTE).toISOString(),
        createdAt: new Date(Date.now() - age).toISOString(),
    });
    return { id, cookie: `session=${token}` };
}

function sessionCookie(response: Response) {
    return response.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith("session="))
        ?.split(";")[0];
}

function mockGoogle(
    profile: { sub: string; email: string },
    emailVerified = true,
) {
    nock("https://oauth2.googleapis.com")
        .post("/token")
        .reply(200, { access_token: "google-token" });
    nock("https://openidconnect.googleapis.com")
        .get("/v1/userinfo")
        .reply(200, {
            ...profile,
            email_verified: emailVerified,
            name: "Alice",
        });
}

function mockFacebook(profile: { id: string; email: string }) {
    nock("https://graph.facebook.com")
        .get("/v23.0/oauth/access_token")
        .query(true)
        .reply(200, { access_token: "facebook-token" })
        .get("/v23.0/me")
        .query(true)
        .reply(200, { ...profile, name: "Alice" });
}

function startLink(provider: string, cookie: string, currentPassword = "") {
    return request(`auth/oauth/${provider}/link`, {
        method: "POST",
        cookie,
        body: { currentPassword },
    });
}

// The provider sends the browser back with a code and the state it was given
async function callback(start: Response, provider: string, cookie?: string) {
    const { url } = await start.json();
    const state = new URL(url).searchParams.get("state");
    const stateCookie = start.headers
        .getSetCookie()
        .find((c) => c.startsWith("oauth_state="))!
        .split(";")[0];
    const response = await request(
        `auth/oauth/${provider}/callback?code=test-code&state=${state}`,
        { cookie: [stateCookie, cookie].filter(Boolean).join("; ") },
    );
    expect(response.status).toBe(302);
    return response;
}

async function link(
    provider: "google" | "facebook",
    cookie: string,
    currentPassword = "",
) {
    const start = await startLink(provider, cookie, currentPassword);
    expect(start.status).toBe(200);
    const response = await callback(start, provider, cookie);
    return response.headers.get("location")!;
}

// A plain sign-in with the provider, as from the login page
async function signIn(provider: "google" | "facebook") {
    const start = await request(`auth/oauth/${provider}`);
    const state = new URL(start.headers.get("location")!).searchParams.get(
        "state",
    );
    const stateCookie = start.headers.get("set-cookie")!.split(";")[0];
    const response = await request(
        `auth/oauth/${provider}/callback?code=test-code&state=${state}`,
        { cookie: stateCookie },
    );
    return {
        location: response.headers.get("location")!,
        cookie: sessionCookie(response),
    };
}

function links(userId: number) {
    return db.orm.public.OAuthAccount.where({ userId }).all();
}

function sessionIds(userId: number) {
    return db.orm.public.Session.where({ userId })
        .all()
        .then((rows) => rows.map((s) => s.id));
}

function mailTo(email: string, subject: RegExp) {
    return mail.mock.calls
        .map(([m]) => m)
        .filter((m) => m.to === email && subject.test(m.subject));
}

describe("setting a password on a social-only account", () => {
    it("emails a reset link that sets the password and unlocks email changes", async () => {
        const user = await account({ links: [{ provider: "google" }] });
        const current = await session(user.id);
        const other = await session(user.id);

        const sent = await request("auth/password/setup", {
            method: "POST",
            cookie: current.cookie,
        });
        expect(sent.status).toBe(204);
        const [setup] = mailTo(user.email, /^Set a password/);
        expect(setup).toBeDefined();
        // so an owner can spot a login that isn't theirs
        expect(setup!.text).toContain(
            `It can already be logged in to with: Google (${user.email}).`,
        );
        const token = setup!.text.match(
            /\/reset-password\?purpose=set&token=([\w-]+)/,
        )?.[1];
        expect(token).toBeTruthy();
        // the same token table as a password reset, no new kind of token
        expect(
            await db.orm.public.PasswordReset.where({ userId: user.id }).all(),
        ).toHaveLength(1);

        const confirmed = await request("auth/password-reset/confirm", {
            method: "POST",
            body: { token, newPassword: password },
        });
        expect(confirmed.status).toBe(200);
        const newCookie = sessionCookie(confirmed)!;
        // like a reset, every earlier session is signed out
        const ids = await sessionIds(user.id);
        expect(ids).not.toContain(current.id);
        expect(ids).not.toContain(other.id);
        expect(ids).toHaveLength(1);
        expect(mailTo(user.email, /password was set/)).toHaveLength(1);
        // the link works once
        expect(
            (
                await request("auth/password-reset/confirm", {
                    method: "POST",
                    body: { token, newPassword: "Another password!" },
                })
            ).status,
        ).toBe(400);

        const login = await request("auth/login", {
            method: "POST",
            body: { email: user.email, password },
        });
        expect(login.status).toBe(200);

        const newEmail = `linking-${randomUUID()}@example.com`;
        const changed = await request("auth/profile", {
            method: "POST",
            cookie: newCookie,
            body: { email: newEmail, username: "", currentPassword: password },
        });
        expect(changed.status).toBe(200);
        expect((await changed.json()).user).toMatchObject({
            email: newEmail,
            emailVerified: false,
        });
    });

    it("doesn't send a password reset notice for a forgotten password", async () => {
        const user = await account({ withPassword: true });
        await request("auth/password-reset", {
            method: "POST",
            body: { email: user.email },
        });
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());
        const token = mail.mock.calls[0]![0].text.match(/token=([\w-]+)/)![1];
        const confirmed = await request("auth/password-reset/confirm", {
            method: "POST",
            body: { token, newPassword: "A brand new password!" },
        });
        expect(confirmed.status).toBe(200);
        expect(mailTo(user.email, /password was set/)).toHaveLength(0);
    });

    it("keeps an earlier link working when another is asked for", async () => {
        const user = await account({ links: [{ provider: "google" }] });
        const { cookie } = await session(user.id);
        for (let i = 0; i < 2; i++) {
            const sent = await request("auth/password/setup", {
                method: "POST",
                cookie,
            });
            expect(sent.status).toBe(204);
        }
        const [first, second] = mailTo(user.email, /^Set a password/).map(
            (m) => m.text.match(/token=([\w-]+)/)![1],
        );
        expect(first).not.toBe(second);
        const confirmed = await request("auth/password-reset/confirm", {
            method: "POST",
            body: { token: first, newPassword: password },
        });
        expect(confirmed.status).toBe(200);
        // using one link ends the others
        const again = await request("auth/password-reset/confirm", {
            method: "POST",
            body: { token: second, newPassword: "Another password!" },
        });
        expect(again.status).toBe(400);
    });

    it("refuses accounts that have a password", async () => {
        const user = await account({ withPassword: true });
        const { cookie } = await session(user.id);
        const response = await request("auth/password/setup", {
            method: "POST",
            cookie,
        });
        expect(response.status).toBe(409);
        expect(mail).not.toHaveBeenCalled();
    });

    it("refuses an unverified address", async () => {
        const user = await account({
            verified: false,
            links: [{ provider: "facebook" }],
        });
        const { cookie } = await session(user.id);
        const response = await request("auth/password/setup", {
            method: "POST",
            cookie,
        });
        expect(response.status).toBe(403);
        expect(
            await db.orm.public.PasswordReset.where({ userId: user.id }).all(),
        ).toHaveLength(0);
    });

    // An owner whose only login was dropped at verification must always be
    // able to get back in, so the login page offers the set-password link
    it("sends a set-password link from the forgotten-password form to a verified social-only account", async () => {
        const user = await account({ links: [{ provider: "google" }] });
        const response = await request("auth/password-reset", {
            method: "POST",
            body: { email: user.email },
        });
        expect(response.status).toBe(204);
        expect(
            await db.orm.public.PasswordReset.where({ userId: user.id }).all(),
        ).toHaveLength(1);
        await vi.waitFor(() =>
            expect(mail).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    to: user.email,
                    subject: "Set a password for PulseBoard",
                    text: expect.stringContaining(
                        `It can already be logged in to with: Google (${user.email})`,
                    ),
                }),
            ),
        );
    });

    it("sends an unverified social-only account a verification link instead", async () => {
        const user = await account({
            verified: false,
            links: [{ provider: "facebook" }],
        });
        const response = await request("auth/password-reset", {
            method: "POST",
            body: { email: user.email },
        });
        expect(response.status).toBe(204);
        expect(
            await db.orm.public.PasswordReset.where({ userId: user.id }).all(),
        ).toHaveLength(0);
        await vi.waitFor(() =>
            expect(mail).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    to: user.email,
                    subject: "Verify your PulseBoard email address",
                }),
            ),
        );
    });

    it("limits how many links one account can ask for", async () => {
        const user = await account({ links: [{ provider: "google" }] });
        const { cookie } = await session(user.id);
        const statuses = [];
        for (let i = 0; i < 4; i++) {
            statuses.push(
                (
                    await request("auth/password/setup", {
                        method: "POST",
                        cookie,
                    })
                ).status,
            );
        }
        expect(statuses).toEqual([204, 204, 204, 429]);
    });

    it("still keeps social-only accounts from changing their email", async () => {
        const user = await account({ links: [{ provider: "google" }] });
        const { cookie } = await session(user.id);
        const response = await request("auth/profile", {
            method: "POST",
            cookie,
            body: {
                email: `linking-${randomUUID()}@example.com`,
                username: "",
            },
        });
        expect(response.status).toBe(400);
    });
});

describe("listing connected accounts", () => {
    it("lists only the signed-in user's logins", async () => {
        const user = await account({ links: [{ provider: "google" }] });
        await account({ links: [{ provider: "facebook" }] });
        const { cookie } = await session(user.id);

        const response = await request("auth/connected-accounts", { cookie });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const body = await response.json();
        expect(body).toMatchObject({
            hasPassword: false,
            providers: ["google", "facebook"],
        });
        expect(body.accounts).toEqual([
            {
                id: expect.any(Number),
                provider: "google",
                email: user.email,
                createdAt: expect.any(String),
            },
        ]);
    });

    it("requires a session", async () => {
        expect((await request("auth/connected-accounts")).status).toBe(401);
    });
});

describe("linking a provider", () => {
    it("attaches the provider account to the signed-in user, not the one with its email", async () => {
        const user = await account({ withPassword: true });
        const other = await account({ withPassword: true });
        const { cookie } = await session(user.id);
        const sub = `g-${randomUUID()}`;
        // the Google address belongs to another account, and must not matter
        mockGoogle({ sub, email: other.email });

        const location = await link("google", cookie, password);

        expect(location).toBe("/settings?linked=google");
        expect(await links(user.id)).toMatchObject([
            { provider: "google", providerUserId: sub, email: other.email },
        ]);
        expect(await links(other.id)).toHaveLength(0);
        // this session stays; linking adds a login, it doesn't end any
        expect((await request("auth/me", { cookie })).status).toBe(200);
        expect(mailTo(user.email, /Google was connected/)).toHaveLength(1);
        expect(mailTo(other.email, /./)).toHaveLength(0);

        // the new login signs in to this account
        mockGoogle({ sub, email: other.email });
        const signedIn = await signIn("google");
        const me = await request("auth/me", { cookie: signedIn.cookie });
        expect((await me.json()).user.id).toBe(user.id);
    });

    it("never lets an address Google didn't verify verify the account later", async () => {
        const attacker = await account({ withPassword: true });
        const victimEmail = `linking-${randomUUID()}@example.com`;
        const { cookie } = await session(attacker.id);
        const sub = `g-${randomUUID()}`;
        mockGoogle({ sub, email: victimEmail }, false);
        expect(await link("google", cookie, password)).toBe(
            "/settings?linked=google",
        );
        expect(await links(attacker.id)).toMatchObject([{ email: null }]);

        const changed = await request("auth/profile", {
            method: "POST",
            cookie,
            body: {
                email: victimEmail,
                username: "",
                currentPassword: password,
            },
        });
        expect(changed.status).toBe(200);
        mockGoogle({ sub, email: victimEmail }, false);
        await signIn("google");

        const user = await db.orm.public.User.where({
            id: attacker.id,
        }).first();
        expect(user).toMatchObject({
            email: victimEmail,
            emailVerifiedAt: null,
        });
    });

    it("links Facebook by its ID, so it signs in even though its email is never trusted", async () => {
        const user = await account({ links: [{ provider: "google" }] });
        const { cookie } = await session(user.id);
        const id = `fb-${randomUUID()}`;
        mockFacebook({ id, email: user.email });

        expect(await link("facebook", cookie)).toBe(
            "/settings?linked=facebook",
        );
        mockFacebook({ id, email: user.email });
        const signedIn = await signIn("facebook");
        expect(signedIn.location).toBe("/buy");
        const me = await request("auth/me", { cookie: signedIn.cookie });
        expect((await me.json()).user.id).toBe(user.id);
    });

    it("still refuses a Facebook sign-in by email without a link", async () => {
        const user = await account({ withPassword: true });
        mockFacebook({ id: `fb-${randomUUID()}`, email: user.email });
        const { location, cookie } = await signIn("facebook");
        expect(location).toBe(
            "/login?oauth_error=email_taken&provider=facebook",
        );
        expect(cookie).toBeUndefined();
        expect(await links(user.id)).toHaveLength(0);
    });

    it("asks a password account for its password", async () => {
        const user = await account({ withPassword: true });
        const { cookie } = await session(user.id);
        for (const currentPassword of ["", "Wrong password!"]) {
            const response = await startLink("google", cookie, currentPassword);
            expect(response.status).toBe(400);
            expect(response.headers.get("set-cookie")).toBeNull();
        }
    });

    it("asks a social-only account to have signed in within 10 minutes", async () => {
        const user = await account({ links: [{ provider: "google" }] });
        const stale = await session(user.id, 11 * MINUTE);
        expect((await startLink("facebook", stale.cookie)).status).toBe(403);
        const fresh = await session(user.id, 2 * MINUTE);
        expect((await startLink("facebook", fresh.cookie)).status).toBe(200);
    });

    it("requires a verified email address", async () => {
        const user = await account({
            verified: false,
            links: [{ provider: "facebook" }],
        });
        const { cookie } = await session(user.id);
        expect((await startLink("google", cookie)).status).toBe(403);
    });

    it("refuses a second login with the same provider", async () => {
        const user = await account({
            withPassword: true,
            links: [{ provider: "google" }],
        });
        const { cookie } = await session(user.id);
        expect((await startLink("google", cookie, password)).status).toBe(409);
    });

    it("won't take a provider account that signs in to another account", async () => {
        const sub = `g-${randomUUID()}`;
        const owner = await account({
            links: [{ provider: "google", providerUserId: sub }],
        });
        const user = await account({ withPassword: true });
        const { cookie } = await session(user.id);
        mockGoogle({ sub, email: owner.email });

        expect(await link("google", cookie, password)).toBe(
            "/settings?link_error=linked_elsewhere&provider=google",
        );
        expect(await links(user.id)).toHaveLength(0);
        expect(await links(owner.id)).toMatchObject([{ providerUserId: sub }]);
        expect(mail).not.toHaveBeenCalled();
    });

    it("treats linking the same provider account again as done", async () => {
        const sub = `g-${randomUUID()}`;
        const user = await account({ withPassword: true });
        const { cookie } = await session(user.id);
        const start = await startLink("google", cookie, password);
        // linked meanwhile, e.g. from another tab
        await db.orm.public.OAuthAccount.create({
            provider: "google",
            providerUserId: sub,
            userId: user.id,
            email: null,
        });
        mockGoogle({ sub, email: user.email });
        const response = await callback(start, "google", cookie);
        expect(response.headers.get("location")).toBe(
            "/settings?linked=google",
        );
        expect(await links(user.id)).toHaveLength(1);
        expect(mail).not.toHaveBeenCalled();
    });

    it("only finishes in the session that started it", async () => {
        const user = await account({ withPassword: true });
        const attacker = await account({ withPassword: true });
        const { cookie } = await session(user.id);
        const { cookie: attackerCookie } = await session(attacker.id);
        const start = await startLink("google", cookie, password);

        for (const other of [attackerCookie, undefined]) {
            const response = await callback(start.clone(), "google", other);
            expect(response.headers.get("location")).toBe(
                "/settings?link_error=expired&provider=google",
            );
        }
        expect(await links(user.id)).toHaveLength(0);
        expect(await links(attacker.id)).toHaveLength(0);
    });

    it("doesn't link from a sign-in started on the login page", async () => {
        const user = await account({ withPassword: true });
        const { cookie } = await session(user.id);
        const email = `linking-${randomUUID()}@example.com`;
        mockGoogle({ sub: `g-${randomUUID()}`, email });

        const start = await request("auth/oauth/google", { cookie });
        const state = new URL(start.headers.get("location")!).searchParams.get(
            "state",
        );
        const stateCookie = start.headers.get("set-cookie")!.split(";")[0];
        const response = await request(
            `auth/oauth/google/callback?code=test-code&state=${state}`,
            { cookie: `${stateCookie}; ${cookie}` },
        );

        expect(response.headers.get("location")).toBe("/overview");
        expect(await links(user.id)).toHaveLength(0);
        const created = await db.orm.public.User.where({ email }).first();
        userIds.add(created!.id);
        expect(await links(created!.id)).toHaveLength(1);
    });

    it.each([
        ["error=access_denied", "cancelled"],
        ["code=test-code&state=wrong", "expired"],
    ])(
        "goes back to the settings with only a code: %s",
        async (query, code) => {
            const user = await account({ withPassword: true });
            const { cookie } = await session(user.id);
            const start = await startLink("google", cookie, password);
            const stateCookie = start.headers
                .getSetCookie()
                .find((c) => c.startsWith("oauth_state="))!
                .split(";")[0];
            const response = await request(
                `auth/oauth/google/callback?${query}`,
                { cookie: `${stateCookie}; ${cookie}` },
            );
            expect(response.headers.get("location")).toBe(
                `/settings?link_error=${code}&provider=google`,
            );
        },
    );

    it("reports a failed provider request as a generic failure", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const user = await account({ withPassword: true });
        const { cookie } = await session(user.id);
        nock("https://oauth2.googleapis.com").post("/token").reply(500, {});
        expect(await link("google", cookie, password)).toBe(
            "/settings?link_error=failed&provider=google",
        );
    });

    it("rejects unknown providers and requests without a session", async () => {
        const user = await account({ withPassword: true });
        const { cookie } = await session(user.id);
        expect((await startLink("constructor", cookie, password)).status).toBe(
            404,
        );
        expect(
            (
                await request("auth/oauth/google/link", {
                    method: "POST",
                    body: { currentPassword: password },
                })
            ).status,
        ).toBe(401);
    });

    it("refuses a link started from another site", async () => {
        const user = await account({ withPassword: true });
        const { cookie } = await session(user.id);
        const response = await app.request("/api/auth/oauth/google/link", {
            method: "POST",
            headers: {
                origin: "https://evil.example",
                "content-type": "application/x-www-form-urlencoded",
                cookie,
            },
            body: `currentPassword=${encodeURIComponent(password)}`,
        });
        expect(response.status).toBe(403);
    });
});

describe("unlinking a provider", () => {
    it("removes the login, signs out other devices and emails the owner", async () => {
        const user = await account({
            withPassword: true,
            links: [{ provider: "google" }],
        });
        const current = await session(user.id);
        const other = await session(user.id);
        const [google] = await links(user.id);

        const response = await request(
            `auth/connected-accounts/${google!.id}`,
            {
                method: "DELETE",
                cookie: current.cookie,
                body: { currentPassword: password },
            },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ revoked: 1 });
        expect(await links(user.id)).toHaveLength(0);
        expect(await sessionIds(user.id)).toEqual([current.id]);
        expect(
            (await request("auth/me", { cookie: other.cookie })).status,
        ).toBe(401);
        expect(mailTo(user.email, /Google was disconnected/)).toHaveLength(1);
    });

    it("stays disconnected: Google with the account's own address doesn't link again", async () => {
        const sub = `g-${randomUUID()}`;
        const user = await account({
            withPassword: true,
            links: [{ provider: "google", providerUserId: sub }],
        });
        const { cookie } = await session(user.id);
        const [google] = await links(user.id);
        const unlinked = await request(
            `auth/connected-accounts/${google!.id}`,
            { method: "DELETE", cookie, body: { currentPassword: password } },
        );
        expect(unlinked.status).toBe(200);

        mockGoogle({ sub, email: user.email });
        const signedIn = await signIn("google");

        expect(signedIn.location).toBe(
            "/login?oauth_error=email_taken&provider=google",
        );
        expect(signedIn.cookie).toBeUndefined();
        expect(await links(user.id)).toHaveLength(0);
        expect((await request("auth/me", { cookie })).status).toBe(200);
    });

    it("asks for the password, or a fresh sign-in without one", async () => {
        const withPassword = await account({
            withPassword: true,
            links: [{ provider: "google" }],
        });
        const { cookie } = await session(withPassword.id);
        const [google] = await links(withPassword.id);
        for (const body of [
            undefined,
            { currentPassword: "Wrong password!" },
        ]) {
            const response = await request(
                `auth/connected-accounts/${google!.id}`,
                { method: "DELETE", cookie, body },
            );
            expect(response.status).toBe(400);
        }

        const social = await account({
            links: [{ provider: "google" }, { provider: "facebook" }],
        });
        const stale = await session(social.id, 11 * MINUTE);
        const [first] = await links(social.id);
        const response = await request(`auth/connected-accounts/${first!.id}`, {
            method: "DELETE",
            cookie: stale.cookie,
        });
        expect(response.status).toBe(403);
        expect(await links(withPassword.id)).toHaveLength(1);
        expect(await links(social.id)).toHaveLength(2);
        expect(mail).not.toHaveBeenCalled();
    });

    it("lets a social-only account remove one of two providers", async () => {
        const user = await account({
            links: [{ provider: "google" }, { provider: "facebook" }],
        });
        const { cookie } = await session(user.id);
        const facebook = (await links(user.id)).find(
            (l) => l.provider === "facebook",
        )!;
        const response = await request(
            `auth/connected-accounts/${facebook.id}`,
            { method: "DELETE", cookie },
        );
        expect(response.status).toBe(200);
        expect(await links(user.id)).toMatchObject([{ provider: "google" }]);
    });

    it("never removes the last way to log in", async () => {
        const user = await account({ links: [{ provider: "google" }] });
        const current = await session(user.id);
        const other = await session(user.id);
        const [google] = await links(user.id);

        const response = await request(
            `auth/connected-accounts/${google!.id}`,
            { method: "DELETE", cookie: current.cookie },
        );

        expect(response.status).toBe(409);
        expect(await links(user.id)).toHaveLength(1);
        expect(await sessionIds(user.id)).toHaveLength(2);
        expect(other).toBeDefined();
        expect(mail).not.toHaveBeenCalled();
    });

    it("doesn't count a login with a provider that is no longer enabled", async () => {
        const user = await account({
            links: [{ provider: "google" }, { provider: "github" }],
        });
        const { cookie } = await session(user.id);
        const google = (await links(user.id)).find(
            (l) => l.provider === "google",
        )!;
        const response = await request(`auth/connected-accounts/${google.id}`, {
            method: "DELETE",
            cookie,
        });
        expect(response.status).toBe(409);
    });

    it("keeps at least one login when two are removed at once", async () => {
        const user = await account({
            links: [{ provider: "google" }, { provider: "facebook" }],
        });
        const { cookie } = await session(user.id);
        const responses = await Promise.all(
            (await links(user.id)).map((l) =>
                request(`auth/connected-accounts/${l.id}`, {
                    method: "DELETE",
                    cookie,
                }),
            ),
        );
        expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(await links(user.id)).toHaveLength(1);
    });

    it("can't remove another user's login", async () => {
        const victim = await account({
            withPassword: true,
            links: [{ provider: "google" }],
        });
        const user = await account({ withPassword: true });
        const { cookie } = await session(user.id);
        const [google] = await links(victim.id);
        const response = await request(
            `auth/connected-accounts/${google!.id}`,
            { method: "DELETE", cookie, body: { currentPassword: password } },
        );
        expect(response.status).toBe(404);
        expect(await links(victim.id)).toHaveLength(1);
    });

    it.each(["0", "abc", "1e3", "99999999999"])(
        "answers not found for the id %s",
        async (id) => {
            const user = await account({ withPassword: true });
            const { cookie } = await session(user.id);
            const response = await request(`auth/connected-accounts/${id}`, {
                method: "DELETE",
                cookie,
            });
            expect(response.status).toBe(404);
        },
    );
});
