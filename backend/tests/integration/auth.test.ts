import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { createApp } from "../../src/app.js";
import { sessionIdFor } from "../../src/auth/session.js";
import { db } from "../../src/prisma/db.js";
import { sendMail } from "../../src/mail/mailer.js";
import { mockStripe } from "../../../tests/stripe.mjs";

vi.mock("../../src/mail/mailer.js", () => ({
    sendMail: vi.fn().mockResolvedValue(undefined),
}));

const app = createApp();
const stripe = mockStripe();
const mail = vi.mocked(sendMail);
const password = "Correct horse battery staple!";
const userIds = new Set<number>();
let ip: string;
let ipSequence = 0;

beforeEach(() => {
    // Every test gets separate limiter keys; requests within a test share them.
    ip = `192.0.2.${++ipSequence}`;
    mail.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
    for (const id of userIds) await db.orm.public.User.where({ id }).delete();
    userIds.clear();
    stripe.sessions.clear();
});
afterAll(async () => {
    await db.close();
    stripe.close();
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
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toMatch(/^session=.+;/);
    return cookie!.split(";")[0];
}

async function trackUserByEmail(email: string) {
    const row = await db.orm.public.User.where({ email }).first();
    if (row) userIds.add(row.id);
    return row;
}

// Registers, then logs in with the password: an unverified account with a session
async function register() {
    const email = `api-${randomUUID()}@example.com`;
    const response = await request("auth/register", {
        email,
        password,
        username: " Alice ",
    });
    await trackUserByEmail(email);
    expect(response.status).toBe(202);
    const login = await request("auth/login", { email, password });
    expect(login.status).toBe(200);
    const { user } = await login.json();
    return { email, user, response, cookie: sessionCookie(login) };
}

function lastToken() {
    const text = mail.mock.calls.at(-1)?.[0].text;
    const token = text?.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    return token!;
}

describe("registration and sessions", () => {
    it("creates an account and sends verification without signing in", async () => {
        const email = `api-${randomUUID()}@example.com`;
        const response = await request("auth/register", {
            email,
            password,
            username: " Alice ",
        });
        expect(response.status).toBe(202);
        expect(response.headers.get("set-cookie")).toBeNull();
        const row = await trackUserByEmail(email);
        expect(row).toMatchObject({ username: "Alice", emailVerifiedAt: null });
        expect(mail).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                to: email,
                subject: "Verify your PulseBoard email address",
            }),
        );
    });

    it("signs in with the verification link and sets a private session cookie", async () => {
        const email = `api-${randomUUID()}@example.com`;
        await request("auth/register", { email, password, username: "Alice" });
        await trackUserByEmail(email);
        const response = await request("auth/verify-email", {
            token: lastToken(),
        });
        expect(response.status).toBe(200);
        const { user } = await response.json();
        expect(user).toEqual({
            id: expect.any(Number),
            email,
            username: "Alice",
            licensePlan: null,
            emailVerified: true,
        });
        expect(response.headers.get("set-cookie")).toContain("HttpOnly");
        expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
        const cookie = sessionCookie(response);
        const row = await db.orm.public.User.where({ id: user.id }).first();
        expect(row?.passwordHash).toMatch(/^scrypt\$/);
        expect(row?.passwordHash).not.toContain(password);
        const token = cookie.slice("session=".length);
        const sessions = await db.orm.public.Session.where({
            userId: user.id,
        }).all();
        expect(sessions.map((session) => session.id)).toEqual([
            sessionIdFor(token),
        ]);
        expect(JSON.stringify(sessions)).not.toContain(token);
        const me = await request("auth/me", undefined, cookie);
        expect(me.status).toBe(200);
        expect(await me.json()).toEqual({ user });
    });

    it.each([
        { email: "invalid", password },
        { email: "a@example.com,b@example.com", password },
        { email: "alice@example.com", password: "short" },
        { email: "alice@example.com", password: "x".repeat(257) },
        { email: "alice@example.com" },
    ])("rejects invalid credentials: %j", async (body) => {
        expect((await request("auth/register", body)).status).toBe(400);
        expect(mail).not.toHaveBeenCalled();
    });

    it("answers the same for a taken email and mails its owner instead", async () => {
        const { email, user } = await register();
        mail.mockClear();
        const freshEmail = `api-${randomUUID()}@example.com`;
        const fresh = await request("auth/register", {
            email: freshEmail,
            password,
        });
        await trackUserByEmail(freshEmail);
        const duplicate = await request("auth/register", {
            email: ` ${email.toUpperCase()} `,
            password: "The intruder's password!",
        });
        expect(duplicate.status).toBe(fresh.status);
        expect(await duplicate.text()).toBe(await fresh.text());
        expect(duplicate.headers.get("set-cookie")).toBeNull();
        expect(mail).toHaveBeenLastCalledWith(
            expect.objectContaining({
                to: email,
                subject: "You already have a PulseBoard account",
            }),
        );
        expect(mail.mock.calls.at(-1)?.[0].text).toContain("/forgot-password");
        // the existing account is untouched
        expect((await request("auth/login", { email, password })).status).toBe(
            200,
        );
        expect(await db.orm.public.User.where({ email }).all()).toHaveLength(1);
        expect(
            (await db.orm.public.User.where({ id: user.id }).first())
                ?.passwordHash,
        ).toBeTruthy();
    });

    it("caps the emails to an existing address without changing the answer", async () => {
        const { email } = await register();
        mail.mockClear();
        for (let attempt = 0; attempt < 5; attempt++) {
            ip = `198.51.100.${attempt + 1}`;
            expect(
                (await request("auth/register", { email, password })).status,
            ).toBe(202);
        }
        expect(mail).toHaveBeenCalledTimes(3);
    });

    it("logs in, logs out and rejects the revoked cookie", async () => {
        const { email } = await register();
        const response = await request("auth/login", {
            email: email.toUpperCase(),
            password,
        });
        expect(response.status).toBe(200);
        const cookie = sessionCookie(response);
        expect((await request("auth/me", undefined, cookie)).status).toBe(200);
        const logout = await request("auth/logout", {}, cookie);
        expect(logout.status).toBe(204);
        expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
        expect((await request("auth/me", undefined, cookie)).status).toBe(401);
    });

    it("returns the same error for wrong passwords and missing accounts", async () => {
        const { email } = await register();
        const wrong = await request("auth/login", {
            email,
            password: "incorrect password",
        });
        const missing = await request("auth/login", {
            email: `missing-${randomUUID()}@example.com`,
            password,
        });
        expect(wrong.status).toBe(401);
        expect(missing.status).toBe(401);
        expect(await wrong.json()).toEqual(await missing.json());
        expect(wrong.headers.get("set-cookie")).toBeNull();
    });

    it("rejects missing, unknown and expired sessions", async () => {
        const { cookie } = await register();
        const id = sessionIdFor(cookie.slice("session=".length));
        // a leaked database row can't be replayed as a cookie
        expect(
            (await request("auth/me", undefined, `session=${id}`)).status,
        ).toBe(401);
        await db.orm.public.Session.where({ id }).update({
            expiresAt: new Date(Date.now() - 1000).toISOString(),
        });
        for (const value of [undefined, "session=unknown", cookie]) {
            expect((await request("auth/me", undefined, value)).status).toBe(
                401,
            );
        }
        expect(await db.orm.public.Session.where({ id }).first()).toBeNull();
    });

    it("rate limits logins per account and IP without locking out other IPs", async () => {
        const { email } = await register();
        for (let attempt = 0; attempt < 10; attempt++) {
            expect(
                (await request("auth/login", { email, password: "wrong" }))
                    .status,
            ).toBe(401);
        }
        const blocked = await request("auth/login", { email, password });
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

        ip = "198.51.100.1";
        expect((await request("auth/login", { email, password })).status).toBe(
            200,
        );
    });

    it("doesn't count successful logins against the account", async () => {
        const { email } = await register();
        for (let attempt = 0; attempt < 12; attempt++) {
            expect(
                (await request("auth/login", { email, password })).status,
            ).toBe(200);
        }
    });

    it("rate limits failed logins per account spread across many IPs", async () => {
        const { email } = await register();
        // the per-account limit counts failures from every IP
        await Promise.all(
            Array.from({ length: 100 }, (_, attempt) =>
                app.request("/api/auth/login", {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-forwarded-for": `198.51.${Math.floor(attempt / 10)}.${attempt % 10}`,
                    },
                    body: JSON.stringify({ email, password: "wrong" }),
                }),
            ),
        );
        ip = "203.0.113.1";
        const blocked = await request("auth/login", { email, password });
        expect(blocked.status).toBe(429);
    }, 60_000);

    it("upgrades a hash with older scrypt parameters on the next login", async () => {
        const { email, user } = await register();
        const salt = randomBytes(16);
        const legacy = `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 64).toString("hex")}`;
        await db.orm.public.User.where({ id: user.id }).update({
            passwordHash: legacy,
        });

        expect(
            (await request("auth/login", { email, password: "wrong password" }))
                .status,
        ).toBe(401);
        expect(
            (await db.orm.public.User.where({ id: user.id }).first())
                ?.passwordHash,
        ).toBe(legacy);

        expect((await request("auth/login", { email, password })).status).toBe(
            200,
        );
        const upgraded = (
            await db.orm.public.User.where({ id: user.id }).first()
        )?.passwordHash;
        expect(upgraded).toMatch(/^scrypt\$ln=17,r=8,p=1\$/);
        expect((await request("auth/login", { email, password })).status).toBe(
            200,
        );
    });

    it("changes the password and revokes other sessions while retaining this device", async () => {
        const { email, cookie } = await register();
        const other = sessionCookie(
            await request("auth/login", { email, password }),
        );
        const newPassword = "A different secure password!";
        expect(
            (
                await request(
                    "auth/password",
                    { currentPassword: "wrong password", newPassword },
                    cookie,
                )
            ).status,
        ).toBe(400);
        expect((await request("auth/me", undefined, other)).status).toBe(200);
        expect(
            (
                await request(
                    "auth/password",
                    { currentPassword: password, newPassword },
                    cookie,
                )
            ).status,
        ).toBe(200);
        expect((await request("auth/me", undefined, cookie)).status).toBe(200);
        expect((await request("auth/me", undefined, other)).status).toBe(401);
        expect((await request("auth/login", { email, password })).status).toBe(
            401,
        );
        expect(
            (await request("auth/login", { email, password: newPassword }))
                .status,
        ).toBe(200);
    });

    it("keeps registration usable when sending email fails", async () => {
        mail.mockRejectedValueOnce(new Error("SMTP unavailable"));
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { cookie } = await register();
        expect(
            (await request("auth/verify-email/resend", {}, cookie)).status,
        ).toBe(204);
        expect(mail).toHaveBeenCalledTimes(2);
    });
});

describe("email verification and licenses", () => {
    it("keeps an unverified account restricted after password login", async () => {
        const { email } = await register();
        const response = await request("auth/login", { email, password });
        expect(response.status).toBe(200);
        expect((await response.json()).user.emailVerified).toBe(false);
        const cookie = sessionCookie(response);
        expect(
            (await request("billing/checkout", { plan: "lifetime" }, cookie))
                .status,
        ).toBe(403);
        expect(
            (await request("datasets/1/hosts", undefined, cookie)).status,
        ).toBe(403);
        expect(
            (await request("auth/verify-email/resend", {}, cookie)).status,
        ).toBe(204);
    });
    it("accepts a token only once and makes the account verified", async () => {
        const { cookie, user } = await register();
        const token = lastToken();
        expect((await request("auth/verify-email", { token })).status).toBe(
            200,
        );
        expect((await request("auth/verify-email", { token })).status).toBe(
            400,
        );
        const me = await (await request("auth/me", undefined, cookie)).json();
        expect(me.user.emailVerified).toBe(true);
        expect(
            await db.orm.public.Session.where({ userId: user.id }).all(),
        ).toHaveLength(2);
    });

    it("keeps the session when the account's own owner opens the link", async () => {
        const { cookie, user } = await register();
        const response = await request(
            "auth/verify-email",
            { token: lastToken() },
            cookie,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(
            await db.orm.public.Session.where({ userId: user.id }).all(),
        ).toHaveLength(1);
    });

    it("signs out another account when its link is opened", async () => {
        const first = await register();
        const second = await register();
        const response = await request(
            "auth/verify-email",
            { token: lastToken() },
            first.cookie,
        );
        expect((await response.json()).user.id).toBe(second.user.id);
        expect((await request("auth/me", undefined, first.cookie)).status).toBe(
            401,
        );
        // the old cookie is cleared, then replaced
        const cookie = response.headers.getSetCookie().at(-1)!.split(";")[0];
        const me = await request("auth/me", undefined, cookie);
        expect((await me.json()).user.id).toBe(second.user.id);
    });

    it("invalidates the earlier token when a new email is sent", async () => {
        const { cookie } = await register();
        const oldToken = lastToken();
        expect(
            (await request("auth/verify-email/resend", {}, cookie)).status,
        ).toBe(204);
        const token = lastToken();
        expect(token).not.toBe(oldToken);
        expect(
            (await request("auth/verify-email", { token: oldToken })).status,
        ).toBe(400);
        expect((await request("auth/verify-email", { token })).status).toBe(
            200,
        );
    });

    it("rejects expired tokens", async () => {
        const { user } = await register();
        const token = lastToken();
        await db.orm.public.EmailVerification.where({ userId: user.id }).update(
            { expiresAt: new Date(Date.now() - 1000).toISOString() },
        );
        expect((await request("auth/verify-email", { token })).status).toBe(
            400,
        );
        expect(
            (await db.orm.public.User.where({ id: user.id }).first())
                ?.emailVerifiedAt,
        ).toBeNull();
    });

    it("requires verification of the new address after an email change", async () => {
        const { cookie } = await register();
        const oldToken = lastToken();
        const email = `changed-${randomUUID()}@example.com`;
        const changed = await request(
            "auth/profile",
            { email, username: "Alice", currentPassword: password },
            cookie,
        );
        expect(changed.status).toBe(200);
        expect((await changed.json()).user.emailVerified).toBe(false);
        expect(mail.mock.calls.at(-1)?.[0].to).toBe(email);
        expect(
            (await request("auth/verify-email", { token: oldToken })).status,
        ).toBe(400);
        expect(
            (await request("auth/verify-email", { token: lastToken() })).status,
        ).toBe(200);
    });

    it("signs out other devices when the email changes", async () => {
        const { email, cookie } = await register();
        const other = sessionCookie(
            await request("auth/login", { email, password }),
        );
        expect(
            (await request("auth/profile", { email, username: "Bob" }, cookie))
                .status,
        ).toBe(200);
        expect((await request("auth/me", undefined, other)).status).toBe(200);

        const changed = await request(
            "auth/profile",
            {
                email: `api-${randomUUID()}@example.com`,
                username: "Bob",
                currentPassword: password,
            },
            cookie,
        );
        expect(changed.status).toBe(200);
        expect((await request("auth/me", undefined, cookie)).status).toBe(200);
        expect((await request("auth/me", undefined, other)).status).toBe(401);
    });

    it("guards checkout and grants a lifetime license only after confirmation", async () => {
        expect(
            (await request("billing/checkout", { plan: "lifetime" })).status,
        ).toBe(401);
        const { cookie, user } = await register();
        expect(
            (await request("billing/checkout", { plan: "lifetime" }, cookie))
                .status,
        ).toBe(403);
        await request("auth/verify-email", { token: lastToken() });
        expect(
            (await request("billing/checkout", { plan: "unknown" }, cookie))
                .status,
        ).toBe(400);
        const checkout = await request(
            "billing/checkout",
            { plan: "lifetime", withdrawalWaiver: true },
            cookie,
        );
        expect(checkout.status).toBe(200);
        const { url } = await checkout.json();
        const sessionId = new URL(url).searchParams.get("session_id");
        expect(
            (await db.orm.public.User.where({ id: user.id }).first())
                ?.licensePlan,
        ).toBeNull();
        expect(
            (await request("billing/confirm", { sessionId }, cookie)).status,
        ).toBe(200);
        expect(
            (await request("billing/confirm", { sessionId }, cookie)).status,
        ).toBe(200);
        expect(
            (await db.orm.public.User.where({ id: user.id }).first())
                ?.licensePlan,
        ).toBe("lifetime");
        expect(
            (
                await request(
                    "billing/checkout",
                    { plan: "subscription", withdrawalWaiver: true },
                    cookie,
                )
            ).status,
        ).toBe(409);
    });

    it("refuses checkout without the withdrawal waiver", async () => {
        const { cookie, user } = await register();
        await request("auth/verify-email", { token: lastToken() });
        for (const body of [
            { plan: "lifetime" },
            { plan: "lifetime", withdrawalWaiver: "true" },
        ]) {
            const response = await request("billing/checkout", body, cookie);
            expect(response.status).toBe(400);
            expect((await response.json()).error).toEqual(expect.any(String));
        }
        expect(
            (await db.orm.public.User.where({ id: user.id }).first())
                ?.withdrawalWaiverAt,
        ).toBeNull();
    });

    it("rejects another account's checkout and does not grant an unpaid license", async () => {
        const { cookie, user } = await register();
        await request("auth/verify-email", { token: lastToken() });
        const checkout = await request(
            "billing/checkout",
            { plan: "lifetime", withdrawalWaiver: true },
            cookie,
        );
        expect(checkout.status).toBe(200);
        const { url } = await checkout.json();
        const sessionId = new URL(url).searchParams.get("session_id");
        const other = await register();
        expect(
            (await request("billing/confirm", { sessionId }, other.cookie))
                .status,
        ).toBe(400);
        stripe.sessions.get(sessionId).payment_status = "unpaid";
        const pending = await request("billing/confirm", { sessionId }, cookie);
        expect(pending.status).toBe(200);
        expect(await pending.json()).toEqual({ paymentStatus: "unpaid" });
        expect(
            (await db.orm.public.User.where({ id: user.id }).first())
                ?.licensePlan,
        ).toBeNull();
    });

    it("requires confirmation and cascades account deletion to sessions and verification tokens", async () => {
        const { user, cookie } = await register();
        expect(
            (
                await request(
                    "auth/delete-account",
                    { confirmation: "no" },
                    cookie,
                )
            ).status,
        ).toBe(400);
        for (const currentPassword of [undefined, "wrong password!"]) {
            const response = await request(
                "auth/delete-account",
                { confirmation: "delete my account", currentPassword },
                cookie,
            );
            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({
                error: "Current password is incorrect",
            });
        }
        expect((await request("auth/me", undefined, cookie)).status).toBe(200);
        expect(
            (
                await request(
                    "auth/delete-account",
                    {
                        confirmation: "delete my account",
                        currentPassword: password,
                    },
                    cookie,
                )
            ).status,
        ).toBe(204);
        expect(
            await db.orm.public.User.where({ id: user.id }).first(),
        ).toBeNull();
        expect(
            await db.orm.public.Session.where({ userId: user.id }).first(),
        ).toBeNull();
        expect(
            await db.orm.public.EmailVerification.where({
                userId: user.id,
            }).first(),
        ).toBeNull();
        expect((await request("auth/me", undefined, cookie)).status).toBe(401);
    });

    it("asks social-only accounts to sign in again before deleting", async () => {
        const { user, cookie } = await register();
        await db.orm.public.User.where({ id: user.id }).update({
            passwordHash: null,
        });
        const signedInAt = (minutesAgo: number) =>
            db.orm.public.Session.where({ userId: user.id }).updateAll({
                createdAt: new Date(
                    Date.now() - minutesAgo * 60_000,
                ).toISOString(),
            });
        const confirm = { confirmation: "delete my account" };

        await signedInAt(11);
        const stale = await request("auth/delete-account", confirm, cookie);
        expect(stale.status).toBe(403);
        expect((await stale.json()).error).toContain("Sign in again");
        expect(
            await db.orm.public.User.where({ id: user.id }).first(),
        ).not.toBeNull();

        await signedInAt(1);
        expect(
            (await request("auth/delete-account", confirm, cookie)).status,
        ).toBe(204);
        expect(
            await db.orm.public.User.where({ id: user.id }).first(),
        ).toBeNull();
    });
});

describe("password reset", () => {
    const newPassword = "A brand new secure password!";

    async function requestReset(email: string) {
        const response = await request("auth/password-reset", { email });
        expect(response.status).toBe(204);
        return lastToken();
    }

    it("answers the same for unknown, social-only and password accounts", async () => {
        const { email } = await register();
        const social = await db.orm.public.User.create({
            email: `social-${randomUUID()}@example.com`,
            username: null,
            passwordHash: null,
        });
        userIds.add(social.id);
        mail.mockClear();
        for (const address of [
            `missing-${randomUUID()}@example.com`,
            social.email,
        ]) {
            const response = await request("auth/password-reset", {
                email: address,
            });
            expect(response.status).toBe(204);
        }
        expect(mail).not.toHaveBeenCalled();
        const response = await request("auth/password-reset", {
            email: ` ${email.toUpperCase()} `,
        });
        expect(response.status).toBe(204);
        expect(mail).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                to: email,
                subject: "Reset your PulseBoard password",
                html: expect.stringContaining("/reset-password?token="),
            }),
        );
    });

    it("sets the new password once, signs out everywhere and logs this browser in", async () => {
        const { email, cookie, user } = await register();
        const token = await requestReset(email);
        expect(
            (
                await request("auth/password-reset/confirm", {
                    token,
                    newPassword: "short",
                })
            ).status,
        ).toBe(400);
        const response = await request("auth/password-reset/confirm", {
            token,
            newPassword,
        });
        expect(response.status).toBe(200);
        expect((await response.json()).user).toMatchObject({
            id: user.id,
            emailVerified: true,
        });
        const fresh = sessionCookie(response);
        expect((await request("auth/me", undefined, fresh)).status).toBe(200);
        expect((await request("auth/me", undefined, cookie)).status).toBe(401);
        expect((await request("auth/login", { email, password })).status).toBe(
            401,
        );
        expect(
            (await request("auth/login", { email, password: newPassword }))
                .status,
        ).toBe(200);
        expect(
            (
                await request("auth/password-reset/confirm", {
                    token,
                    newPassword: "Yet another password!",
                })
            ).status,
        ).toBe(400);
    });

    it("only accepts the newest, unexpired link", async () => {
        const { email, user } = await register();
        const oldToken = await requestReset(email);
        const token = await requestReset(email);
        expect(
            (
                await request("auth/password-reset/confirm", {
                    token: oldToken,
                    newPassword,
                })
            ).status,
        ).toBe(400);
        await db.orm.public.PasswordReset.where({ userId: user.id }).update({
            expiresAt: new Date(Date.now() - 1000).toISOString(),
        });
        expect(
            (
                await request("auth/password-reset/confirm", {
                    token,
                    newPassword,
                })
            ).status,
        ).toBe(400);
        expect((await request("auth/login", { email, password })).status).toBe(
            200,
        );
    });

    it("drops the link when the email changes, even if it changes back", async () => {
        const { email, cookie } = await register();
        const token = await requestReset(email);
        for (const address of [`changed-${randomUUID()}@example.com`, email]) {
            const changed = await request(
                "auth/profile",
                {
                    email: address,
                    username: "Alice",
                    currentPassword: password,
                },
                cookie,
            );
            expect(changed.status).toBe(200);
        }
        expect(
            (
                await request("auth/password-reset/confirm", {
                    token,
                    newPassword,
                })
            ).status,
        ).toBe(400);
    });

    it("drops the link when the password is changed in settings", async () => {
        const { email, cookie } = await register();
        const token = await requestReset(email);
        const changed = await request(
            "auth/password",
            { currentPassword: password, newPassword: "Changed in settings!" },
            cookie,
        );
        expect(changed.status).toBe(200);
        expect(
            (
                await request("auth/password-reset/confirm", {
                    token,
                    newPassword,
                })
            ).status,
        ).toBe(400);
    });

    it("never mails a link built from a forged Host header", async () => {
        const { email, cookie } = await register();
        mail.mockClear();
        try {
            vi.stubEnv("NODE_ENV", "production");
            vi.stubEnv("PUBLIC_URL", "https://pulseboard.example");
            const prodApp = createApp();
            const forged = (path: string, body: unknown) =>
                prodApp.request(`http://evil.example/api/${path}`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-forwarded-for": ip,
                        host: "evil.example",
                        cookie,
                    },
                    body: JSON.stringify(body),
                });
            expect(
                (await forged("auth/password-reset", { email })).status,
            ).toBe(204);
            expect((await forged("auth/verify-email/resend", {})).status).toBe(
                204,
            );
            expect(mail).toHaveBeenCalledTimes(2);
            for (const [message] of mail.mock.calls) {
                expect(message.text).toContain("https://pulseboard.example/");
                expect(message.text).not.toContain("evil.example");
                expect(message.html).not.toContain("evil.example");
            }
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("limits requests per address and IP, and caps emails per address without refusing", async () => {
        const { email } = await register();
        vi.spyOn(console, "error").mockImplementation(() => {});
        mail.mockClear().mockRejectedValueOnce(new Error("SMTP unavailable"));
        for (let attempt = 0; attempt < 3; attempt++) {
            expect(
                (await request("auth/password-reset", { email })).status,
            ).toBe(204);
        }
        const blocked = await request("auth/password-reset", { email });
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(mail).toHaveBeenCalledTimes(3);

        ip = `203.0.113.${ipSequence}`;
        for (let attempt = 0; attempt < 3; attempt++) {
            expect(
                (await request("auth/password-reset", { email })).status,
            ).toBe(204);
        }
        expect(mail).toHaveBeenCalledTimes(5);
    });

    it("cascades account deletion to reset links", async () => {
        const { email, user, cookie } = await register();
        await requestReset(email);
        await request(
            "auth/delete-account",
            { confirmation: "delete my account", currentPassword: password },
            cookie,
        );
        expect(
            await db.orm.public.PasswordReset.where({
                userId: user.id,
            }).first(),
        ).toBeNull();
    });
});
