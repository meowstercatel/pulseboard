import { randomUUID } from "node:crypto";
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
import { sendMail } from "../../src/mail/mailer.js";
import { db } from "../../src/prisma/db.js";

vi.mock("../../src/mail/mailer.js", () => ({
    sendMail: vi.fn().mockResolvedValue(undefined),
}));

const app = createApp();
const mail = vi.mocked(sendMail);
const password = "Correct horse battery staple!";
const userIds = new Set<number>();
let ip: string;
let ipSequence = 0;

beforeAll(() => {
    nock.disableNetConnect();
    nock.enableNetConnect(/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/);
});
beforeEach(() => {
    ip = `198.51.100.${++ipSequence}`;
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

function request(path: string, body?: unknown, cookie?: string) {
    return app.request(`/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            "content-type": "application/json",
            "x-forwarded-for": ip,
            ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

function sessionCookie(response: Response) {
    return response.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith("session="))
        ?.split(";")[0];
}

async function register(verified: boolean) {
    const email = `oauth-${randomUUID()}@example.com`;
    expect((await request("auth/register", { email, password })).status).toBe(
        202,
    );
    const response = await request("auth/login", { email, password });
    expect(response.status).toBe(200);
    const { user } = await response.json();
    userIds.add(user.id);
    if (verified) {
        await db.orm.public.User.where({ id: user.id }).update({
            emailVerifiedAt: new Date().toISOString(),
        });
    }
    return { email, id: user.id as number, cookie: sessionCookie(response)! };
}

function mockGoogle(profile: { sub: string; email: string }) {
    nock("https://oauth2.googleapis.com")
        .post("/token")
        .reply(200, { access_token: "google-token" });
    nock("https://openidconnect.googleapis.com")
        .get("/v1/userinfo")
        .reply(200, { ...profile, email_verified: true, name: "Alice" });
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

// Runs the browser's round trip: start, provider redirect, callback
async function signIn(provider: "google" | "facebook", next?: string) {
    const start = await request(
        `auth/oauth/${provider}` +
            (next === undefined ? "" : `?${new URLSearchParams({ next })}`),
    );
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get(
        "state",
    );
    const stateCookie = start.headers.get("set-cookie")!.split(";")[0];
    const response = await request(
        `auth/oauth/${provider}/callback?code=test-code&state=${state}`,
        undefined,
        stateCookie,
    );
    expect(response.status).toBe(302);
    expect(nock.isDone()).toBe(true);
    return {
        location: response.headers.get("location")!,
        cookie: sessionCookie(response),
    };
}

function loginWithPassword(email: string) {
    return request("auth/login", { email, password });
}

function oauthAccounts(userId: number) {
    return db.orm.public.OAuthAccount.where({ userId }).all();
}

async function trackUserByEmail(email: string) {
    const user = await db.orm.public.User.where({ email }).first();
    if (user) userIds.add(user.id);
    return user;
}

describe("Google sign-in", () => {
    it("takes over an unverified password account by clearing its password and sessions", async () => {
        const { email, id, cookie: oldCookie } = await register(false);
        mockGoogle({ sub: `g-${randomUUID()}`, email });

        const { location, cookie } = await signIn("google");

        expect(location).toBe("/overview");
        expect(cookie).toBeTruthy();
        const user = await db.orm.public.User.where({ id }).first();
        expect(user!.emailVerifiedAt).not.toBeNull();
        expect(user!.passwordHash).toBeNull();
        expect((await loginWithPassword(email)).status).toBe(401);
        expect((await request("auth/me", undefined, oldCookie)).status).toBe(
            401,
        );
        expect(
            await db.orm.public.Session.where({ userId: id }).all(),
        ).toHaveLength(1);
        expect((await request("auth/me", undefined, cookie)).status).toBe(200);
        expect(await oauthAccounts(id)).toHaveLength(1);
    });

    it("doesn't link a verified password account by email; its owner connects Google in the settings", async () => {
        const { email, id, cookie: oldCookie } = await register(true);
        mockGoogle({ sub: `g-${randomUUID()}`, email });

        const { location, cookie } = await signIn("google");

        expect(location).toBe("/login?oauth_error=email_taken&provider=google");
        expect(cookie).toBeUndefined();
        expect(await oauthAccounts(id)).toHaveLength(0);
        expect((await request("auth/me", undefined, oldCookie)).status).toBe(
            200,
        );
        expect((await loginWithPassword(email)).status).toBe(200);
    });

    it("still links a verified account without a password by email", async () => {
        const email = `oauth-${randomUUID()}@example.com`;
        const facebookId = `fb-${randomUUID()}`;
        mockFacebook({ id: facebookId, email });
        await signIn("facebook");
        const user = (await trackUserByEmail(email))!;
        await db.orm.public.User.where({ id: user.id }).update({
            emailVerifiedAt: new Date().toISOString(),
        });
        mockGoogle({ sub: `g-${randomUUID()}`, email });

        const { cookie } = await signIn("google");

        const me = await request("auth/me", undefined, cookie);
        expect((await me.json()).user.id).toBe(user.id);
        expect(
            (await oauthAccounts(user.id)).map((a) => a.provider).sort(),
        ).toEqual(["facebook", "google"]);
    });

    it("drops links the previous holder made with another address", async () => {
        const {
            email: attackerEmail,
            id,
            cookie: attackerCookie,
        } = await register(true);
        const attackerSub = `g-${randomUUID()}`;
        // connected from the settings
        await db.orm.public.OAuthAccount.create({
            provider: "google",
            providerUserId: attackerSub,
            userId: id,
            email: attackerEmail,
        });
        const victimEmail = `oauth-${randomUUID()}@example.com`;
        const changed = await request(
            "auth/profile",
            { email: victimEmail, username: "", currentPassword: password },
            attackerCookie,
        );
        expect(changed.status).toBe(200);

        mockGoogle({ sub: `g-${randomUUID()}`, email: victimEmail });
        await signIn("google");
        expect(await oauthAccounts(id)).toMatchObject([
            { provider: "google", email: victimEmail },
        ]);

        mockGoogle({ sub: attackerSub, email: attackerEmail });
        const { cookie } = await signIn("google");
        const me = await request("auth/me", undefined, cookie);
        const { user } = await me.json();
        userIds.add(user.id);
        expect(user).toMatchObject({ email: attackerEmail });
        expect(user.id).not.toBe(id);
    });

    it("clears the password and sessions when a link made before verification verifies the account", async () => {
        const { email, id, cookie: oldCookie } = await register(false);
        const sub = `g-${randomUUID()}`;
        await db.orm.public.OAuthAccount.create({
            provider: "google",
            providerUserId: sub,
            userId: id,
            email,
        });
        mockGoogle({ sub, email });

        const { location, cookie } = await signIn("google");

        expect(location).toBe("/overview");
        const user = await db.orm.public.User.where({ id }).first();
        expect(user!.emailVerifiedAt).not.toBeNull();
        expect(user!.passwordHash).toBeNull();
        expect((await loginWithPassword(email)).status).toBe(401);
        expect((await request("auth/me", undefined, oldCookie)).status).toBe(
            401,
        );
        expect(
            await db.orm.public.Session.where({ userId: id }).all(),
        ).toHaveLength(1);
        expect((await request("auth/me", undefined, cookie)).status).toBe(200);
    });
});

describe("Facebook sign-in", () => {
    it.each([
        ["a verified", true, false],
        ["an unverified", false, false],
        ["another Facebook ID's", true, true],
    ])("refuses to link %s account by email", async (_, verified, linked) => {
        const { email, id, cookie: oldCookie } = await register(verified);
        if (linked) {
            await db.orm.public.OAuthAccount.create({
                provider: "facebook",
                providerUserId: `fb-${randomUUID()}`,
                userId: id,
                email,
            });
        }
        const before = await oauthAccounts(id);
        mockFacebook({ id: `fb-${randomUUID()}`, email });

        const { location, cookie } = await signIn("facebook");

        expect(location).toBe(
            "/login?oauth_error=email_taken&provider=facebook",
        );
        expect(cookie).toBeUndefined();
        expect(await oauthAccounts(id)).toEqual(before);
        expect(
            await db.orm.public.Session.where({ userId: id }).all(),
        ).toHaveLength(1);
        expect((await request("auth/me", undefined, oldCookie)).status).toBe(
            200,
        );
        expect((await loginWithPassword(email)).status).toBe(200);
    });

    it("creates a new account for a new email", async () => {
        const email = `oauth-${randomUUID()}@example.com`;
        const facebookId = `fb-${randomUUID()}`;
        mockFacebook({ id: facebookId, email });

        const { location, cookie } = await signIn("facebook");

        expect(location).toBe("/buy");
        const user = await trackUserByEmail(email);
        expect(user).toMatchObject({ username: "Alice", passwordHash: null });
        // Facebook doesn't prove the address: verified by email, like a sign-up
        expect(user!.emailVerifiedAt).toBeNull();
        expect(mail).toHaveBeenCalledOnce();
        expect(mail.mock.calls[0]![0]).toMatchObject({ to: email });
        expect(await oauthAccounts(user!.id)).toMatchObject([
            { provider: "facebook", providerUserId: facebookId, email },
        ]);
        const me = await request("auth/me", undefined, cookie);
        expect((await me.json()).user).toMatchObject({
            id: user!.id,
            email,
            emailVerified: false,
        });
    });

    it("signs in an account already linked to the Facebook ID", async () => {
        const email = `oauth-${randomUUID()}@example.com`;
        const facebookId = `fb-${randomUUID()}`;
        mockFacebook({ id: facebookId, email });
        await signIn("facebook");
        const user = await trackUserByEmail(email);

        mockFacebook({ id: facebookId, email });
        const { location, cookie } = await signIn("facebook");

        expect(location).toBe("/buy");
        const me = await request("auth/me", undefined, cookie);
        expect((await me.json()).user).toMatchObject({
            id: user!.id,
            email,
            emailVerified: false,
        });
        expect(await oauthAccounts(user!.id)).toHaveLength(1);
        // only the sign-up sends a link
        expect(mail).toHaveBeenCalledOnce();
    });

    it("loses an account it made with someone else's address to their Google sign-in", async () => {
        const email = `oauth-${randomUUID()}@example.com`;
        const facebookId = `fb-${randomUUID()}`;
        mockFacebook({ id: facebookId, email });
        const { cookie: facebookCookie } = await signIn("facebook");
        const { id } = (await trackUserByEmail(email))!;

        mockGoogle({ sub: `g-${randomUUID()}`, email });
        const { cookie } = await signIn("google");

        const me = await request("auth/me", undefined, cookie);
        expect((await me.json()).user).toMatchObject({
            id,
            emailVerified: true,
        });
        expect(await oauthAccounts(id)).toMatchObject([{ provider: "google" }]);
        expect(
            (await request("auth/me", undefined, facebookCookie)).status,
        ).toBe(401);

        mockFacebook({ id: facebookId, email });
        const again = await signIn("facebook");
        expect(again.location).toBe(
            "/login?oauth_error=email_taken&provider=facebook",
        );
        expect(again.cookie).toBeUndefined();
    });
});

describe("provider names", () => {
    it.each(["constructor", "__proto__", "toString"])(
        "treats %s as an unknown provider",
        async (name) => {
            expect((await request(`auth/oauth/${name}`)).status).toBe(404);
            expect(
                (await request(`auth/oauth/${name}/callback?code=x&state=y`))
                    .status,
            ).toBe(404);
        },
    );
});

describe("sign-in errors", () => {
    it.each([
        ["error=access_denied", "cancelled"],
        ["code=x&state=y", "expired"],
    ])(
        "redirects with a code instead of a message: %s",
        async (query, code) => {
            const response = await request(
                `auth/oauth/google/callback?${query}`,
            );
            expect(response.status).toBe(302);
            expect(response.headers.get("location")).toBe(
                `/login?oauth_error=${code}&provider=google`,
            );
        },
    );

    it("reports a failed provider request as a generic failure", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        nock("https://oauth2.googleapis.com").post("/token").reply(500, {});
        const { location } = await signIn("google");
        expect(location).toBe("/login?oauth_error=failed&provider=google");
    });
});

describe("returning to the requested page", () => {
    it("sends a verified user to the page they asked for", async () => {
        const email = `oauth-${randomUUID()}@example.com`;
        mockGoogle({ sub: `g-${randomUUID()}`, email });

        const { location } = await signIn("google", "/history?dataset=2");
        await trackUserByEmail(email);

        expect(location).toBe("/history?dataset=2");
    });

    it.each(["//evil.example", "/\\evil.example", "https://evil.example"])(
        "ignores the off-site page %s",
        async (next) => {
            const email = `oauth-${randomUUID()}@example.com`;
            mockGoogle({ sub: `g-${randomUUID()}`, email });

            const { location } = await signIn("google", next);
            await trackUserByEmail(email);

            expect(location).toBe("/overview");
        },
    );

    it("sends an unverified Facebook sign-up to verify first", async () => {
        const email = `oauth-${randomUUID()}@example.com`;
        mockFacebook({ id: `f-${randomUUID()}`, email });

        const { location } = await signIn("facebook", "/history");
        await trackUserByEmail(email);

        expect(location).toBe("/buy");
    });

    it("keeps the page when the sign-in fails, with only a code", async () => {
        const start = await request(
            `auth/oauth/google?${new URLSearchParams({ next: "/history?range=7d" })}`,
        );
        const stateCookie = start.headers.get("set-cookie")!.split(";")[0];
        const response = await request(
            "auth/oauth/google/callback?error=access_denied",
            undefined,
            stateCookie,
        );
        expect(response.headers.get("location")).toBe(
            "/login?oauth_error=cancelled&provider=google&next=%2Fhistory%3Frange%3D7d",
        );
    });

    it("doesn't pass on an off-site page planted in the state cookie", async () => {
        const planted = Buffer.from("//evil.example").toString("base64url");
        const response = await request(
            "auth/oauth/google/callback?error=access_denied",
            undefined,
            `oauth_state=google.state.verifier.${planted}`,
        );
        expect(response.headers.get("location")).toBe(
            "/login?oauth_error=cancelled&provider=google",
        );
    });
});

describe("Facebook pre-hijack through the verification link", () => {
    const newPassword = "The address owner's own password!";

    function lastLink(path: string) {
        const text = mail.mock.calls.at(-1)?.[0].text;
        const token = text?.match(
            new RegExp(`${path}\\?(?:purpose=set&)?token=([\\w-]+)`),
        )?.[1];
        expect(token).toBeTruthy();
        return token!;
    }

    // An intruder signs up with Facebook using the owner's address: the
    // account is unverified, has no password, and its verification link goes
    // to the owner's inbox
    async function facebookSignUp() {
        const email = `oauth-${randomUUID()}@example.com`;
        const facebookId = `fb-${randomUUID()}`;
        mockFacebook({ id: facebookId, email });
        const { cookie } = await signIn("facebook");
        const user = (await trackUserByEmail(email))!;
        expect(user).toMatchObject({
            passwordHash: null,
            emailVerifiedAt: null,
        });
        return { email, facebookId, id: user.id, intruder: cookie! };
    }

    it("removes the Facebook login and every session when the owner verifies from their own browser", async () => {
        const { email, facebookId, id, intruder } = await facebookSignUp();
        const token = lastLink("/verify-email");

        const response = await request("auth/verify-email", { token });

        expect(response.status).toBe(200);
        // the owner is signed in, the intruder isn't, and can't get back in
        const owner = sessionCookie(response)!;
        expect((await request("auth/me", undefined, owner)).status).toBe(200);
        expect((await request("auth/me", undefined, intruder)).status).toBe(
            401,
        );
        expect(await oauthAccounts(id)).toEqual([]);
        expect(
            await db.orm.public.Session.where({ userId: id }).all(),
        ).toHaveLength(1);
        mockFacebook({ id: facebookId, email });
        const again = await signIn("facebook");
        expect(again.location).toBe(
            "/login?oauth_error=email_taken&provider=facebook",
        );
        expect(again.cookie).toBeUndefined();
        expect(await response.json()).toMatchObject({
            user: { id, emailVerified: true },
            removedLogins: ["Facebook"],
            needsPassword: true,
        });
    });

    it("leaves the owner a way to log in after signing out: a password set from the login page", async () => {
        const { email, id } = await facebookSignUp();
        const verified = await request("auth/verify-email", {
            token: lastLink("/verify-email"),
        });
        await request("auth/logout", {}, sessionCookie(verified));

        mail.mockClear();
        expect((await request("auth/password-reset", { email })).status).toBe(
            204,
        );
        expect(mail).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                to: email,
                subject: "Set a password for PulseBoard",
            }),
        );
        const confirm = await request("auth/password-reset/confirm", {
            token: lastLink("/reset-password"),
            newPassword,
        });
        expect(confirm.status).toBe(200);
        expect((await confirm.json()).user).toMatchObject({ id });
        expect(
            (await request("auth/login", { email, password: newPassword }))
                .status,
        ).toBe(200);
    });

    it("does the same with a link the intruder resent", async () => {
        const { id, intruder } = await facebookSignUp();
        expect(
            (await request("auth/verify-email/resend", {}, intruder)).status,
        ).toBe(204);

        const response = await request("auth/verify-email", {
            token: lastLink("/verify-email"),
        });

        expect(response.status).toBe(200);
        expect(await oauthAccounts(id)).toEqual([]);
        expect((await request("auth/me", undefined, intruder)).status).toBe(
            401,
        );
    });

    it("keeps the Facebook login when the account's own session opens the link", async () => {
        const { id, intruder: own } = await facebookSignUp();

        const response = await request(
            "auth/verify-email",
            { token: lastLink("/verify-email") },
            own,
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            removedLogins: [],
            needsPassword: false,
        });
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(await oauthAccounts(id)).toMatchObject([
            { provider: "facebook" },
        ]);
        expect((await request("auth/me", undefined, own)).status).toBe(200);
    });

    it("doesn't count another account's session as the account's own", async () => {
        const other = await register(true);
        const { id } = await facebookSignUp();

        const response = await request(
            "auth/verify-email",
            { token: lastLink("/verify-email") },
            other.cookie,
        );

        expect(response.status).toBe(200);
        expect(await oauthAccounts(id)).toEqual([]);
        expect((await request("auth/me", undefined, other.cookie)).status).toBe(
            401,
        );
    });

    it("keeps only Google logins that proved this address", async () => {
        const { email, id } = await facebookSignUp();
        const proven = `g-${randomUUID()}`;
        await db.orm.public.OAuthAccount.create({
            provider: "google",
            providerUserId: proven,
            userId: id,
            email,
        });
        for (const stored of [null, `other-${randomUUID()}@example.com`]) {
            await db.orm.public.OAuthAccount.create({
                provider: "google",
                providerUserId: `g-${randomUUID()}`,
                userId: id,
                email: stored,
            });
        }

        const response = await request("auth/verify-email", {
            token: lastLink("/verify-email"),
        });

        const body = await response.json();
        expect(body.removedLogins.sort()).toEqual(["Facebook", "Google"]);
        // the remaining Google login still signs in
        expect(body.needsPassword).toBe(false);
        expect(await oauthAccounts(id)).toMatchObject([
            { provider: "google", providerUserId: proven, email },
        ]);
    });

    it("leaves a password account's logins alone, as before", async () => {
        const { email, id, cookie } = await register(false);
        await db.orm.public.OAuthAccount.create({
            provider: "facebook",
            providerUserId: `fb-${randomUUID()}`,
            userId: id,
            email,
        });

        const response = await request("auth/verify-email", {
            token: lastLink("/verify-email"),
        });

        expect(await response.json()).toMatchObject({
            removedLogins: [],
            needsPassword: false,
        });
        expect(await oauthAccounts(id)).toHaveLength(1);
        expect((await request("auth/me", undefined, cookie)).status).toBe(401);
        expect((await loginWithPassword(email)).status).toBe(200);
    });

    it("doesn't let a password sign-up over the Facebook account change it", async () => {
        const { email, id } = await facebookSignUp();
        const token = lastLink("/verify-email");
        mail.mockClear();

        expect(
            (await request("auth/register", { email, password })).status,
        ).toBe(202);

        expect(mail).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                to: email,
                subject: expect.not.stringContaining("Verify"),
            }),
        );
        expect(await db.orm.public.User.where({ id }).first()).toMatchObject({
            passwordHash: null,
            emailVerifiedAt: null,
        });
        expect((await loginWithPassword(email)).status).toBe(401);
        // and the owner's link still claims it
        await request("auth/verify-email", { token });
        expect(await oauthAccounts(id)).toEqual([]);
    });

    it("doesn't let another account move onto the Facebook account's address", async () => {
        const { email, id } = await facebookSignUp();
        const other = await register(true);

        const response = await request(
            "auth/profile",
            { email, username: "", currentPassword: password },
            other.cookie,
        );

        expect(response.status).toBe(409);
        expect(await db.orm.public.User.where({ id }).first()).toMatchObject({
            email,
            emailVerifiedAt: null,
        });
        expect(
            await db.orm.public.User.where({ id: other.id }).first(),
        ).toMatchObject({ email: other.email });
    });

    it("sends the owner a new verification link from the forgotten-password form", async () => {
        const { email, id, intruder } = await facebookSignUp();
        mail.mockClear();
        // the intruder has resent theirs, cancelling earlier ones
        await request("auth/verify-email/resend", {}, intruder);

        expect((await request("auth/password-reset", { email })).status).toBe(
            204,
        );

        await vi.waitFor(() =>
            expect(mail).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    to: email,
                    subject: "Verify your PulseBoard email address",
                }),
            ),
        );
        expect(
            await db.orm.public.PasswordReset.where({ userId: id }).all(),
        ).toEqual([]);
        const fresh = await request("auth/verify-email", {
            token: lastLink("/verify-email"),
        });
        expect(fresh.status).toBe(200);
        expect(await oauthAccounts(id)).toEqual([]);
        expect((await request("auth/me", undefined, intruder)).status).toBe(
            401,
        );
    });

    // An intruder can also get here with a password: verify their own
    // account, set a password, connect Facebook, then change the address to
    // the owner's. A reset by the owner replaces the password; the Facebook
    // login has to go with it.
    it("drops the intruder's Facebook login when the owner resets the password of an unverified account", async () => {
        const intruder = await register(true);
        const facebookId = `fb-${randomUUID()}`;
        await db.orm.public.OAuthAccount.create({
            provider: "facebook",
            providerUserId: facebookId,
            userId: intruder.id,
            email: intruder.email,
        });
        const email = `oauth-${randomUUID()}@example.com`;
        expect(
            (
                await request(
                    "auth/profile",
                    { email, username: "", currentPassword: password },
                    intruder.cookie,
                )
            ).status,
        ).toBe(200);

        mail.mockClear();
        await request("auth/password-reset", { email });
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());
        const reset = await request("auth/password-reset/confirm", {
            token: lastLink("/reset-password"),
            newPassword,
        });

        expect(reset.status).toBe(200);
        expect(await oauthAccounts(intruder.id)).toEqual([]);
        expect(
            (await request("auth/me", undefined, intruder.cookie)).status,
        ).toBe(401);
        // their Facebook now only gets them a new account at their own address
        mockFacebook({ id: facebookId, email: intruder.email });
        const again = await signIn("facebook");
        await trackUserByEmail(intruder.email);
        const me = await request("auth/me", undefined, again.cookie);
        const { user } = await me.json();
        expect(user.email).toBe(intruder.email);
        expect(user.id).not.toBe(intruder.id);
        expect((await loginWithPassword(email)).status).toBe(401);
    });

    it("keeps a verified account's logins when its password is reset", async () => {
        const { email, id } = await register(true);
        await db.orm.public.OAuthAccount.create({
            provider: "facebook",
            providerUserId: `fb-${randomUUID()}`,
            userId: id,
            email,
        });
        mail.mockClear();
        await request("auth/password-reset", { email });
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());

        await request("auth/password-reset/confirm", {
            token: lastLink("/reset-password"),
            newPassword,
        });

        expect(await oauthAccounts(id)).toHaveLength(1);
    });
    it("doesn't let anyone who knows the address cancel the owner's pending link", async () => {
        const { email, id } = await facebookSignUp();
        const owners = lastLink("/verify-email");

        for (let i = 0; i < 3; i++) {
            await request("auth/password-reset", { email });
        }
        await vi.waitFor(() => expect(mail).toHaveBeenCalledTimes(4));

        const response = await request("auth/verify-email", { token: owners });
        expect(response.status).toBe(200);
        expect(await oauthAccounts(id)).toEqual([]);
        // and verifying used up every other link
        expect(
            await db.orm.public.EmailVerification.where({ userId: id }).all(),
        ).toEqual([]);
    });

    it("tells the owner about logins a reset removed", async () => {
        const { email, id, cookie } = await register(true);
        await db.orm.public.OAuthAccount.create({
            provider: "google",
            providerUserId: `g-${randomUUID()}`,
            userId: id,
            email,
        });
        const moved = `oauth-${randomUUID()}@example.com`;
        await request(
            "auth/profile",
            { email: moved, username: "", currentPassword: password },
            cookie,
        );
        mail.mockClear();
        await request("auth/password-reset", { email: moved });
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());

        await request("auth/password-reset/confirm", {
            token: lastLink("/reset-password"),
            newPassword,
        });

        expect(await oauthAccounts(id)).toEqual([]);
        await vi.waitFor(() =>
            expect(mail).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    to: moved,
                    subject:
                        "Google was disconnected from your PulseBoard account",
                }),
            ),
        );
    });

    it("reports a failed session write as a sign-in error, without a session cookie", async () => {
        const { email, facebookId } = await facebookSignUp();
        const transaction = vi
            .spyOn(db, "transaction")
            .mockRejectedValueOnce(new Error("deadlock detected"));
        const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            mockFacebook({ id: facebookId, email });
            const { location, cookie } = await signIn("facebook");
            expect(location).toBe(
                "/login?oauth_error=failed&provider=facebook",
            );
            expect(cookie).toBe("session=");
        } finally {
            transaction.mockRestore();
            quiet.mockRestore();
        }
    });
});
