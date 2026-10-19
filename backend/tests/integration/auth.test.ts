import { randomUUID } from "node:crypto";
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

async function register() {
    const email = `api-${randomUUID()}@example.com`;
    const response = await request("auth/register", {
        email,
        password,
        username: " Alice ",
    });
    const { user } = await response.json();
    if (user) userIds.add(user.id);
    expect(response.status).toBe(201);
    return { email, user, response, cookie: sessionCookie(response) };
}

function lastToken() {
    const text = mail.mock.calls.at(-1)?.[0].text;
    const token = text?.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    return token!;
}

describe("registration and sessions", () => {
    it("creates an account, sends verification and sets a private session cookie", async () => {
        const { email, user, response, cookie } = await register();
        expect(user).toEqual({
            id: expect.any(Number),
            email,
            username: "Alice",
            licensePlan: null,
            emailVerified: false,
        });
        expect(response.headers.get("set-cookie")).toContain("HttpOnly");
        expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
        expect(mail).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ to: email }),
        );
        const row = await db.orm.public.User.where({ id: user.id }).first();
        expect(row?.passwordHash).toMatch(/^scrypt\$/);
        expect(row?.passwordHash).not.toContain(password);
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

    it("normalizes email before checking uniqueness", async () => {
        const { email } = await register();
        const duplicate = await request("auth/register", {
            email: ` ${email.toUpperCase()} `,
            password,
        });
        expect(duplicate.status).toBe(409);
        expect(mail).toHaveBeenCalledTimes(1);
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
        const id = cookie.slice("session=".length);
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

    it("rate limits failed logins per account even when the IP changes", async () => {
        const { email } = await register();
        for (let attempt = 0; attempt < 10; attempt++) {
            ip = `198.51.100.${attempt + 1}`;
            expect(
                (await request("auth/login", { email, password: "wrong" }))
                    .status,
            ).toBe(401);
        }
        const blocked = await request("auth/login", { email, password });
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
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
        expect((await request("auth/me", undefined, cookie)).status).toBe(200);
        expect(
            (await request("auth/verify-email/resend", {}, cookie)).status,
        ).toBe(204);
        expect(mail).toHaveBeenCalledTimes(2);
    });
});

describe("email verification and licenses", () => {
    it("accepts a token only once and makes the account verified", async () => {
        const { cookie } = await register();
        const token = lastToken();
        expect((await request("auth/verify-email", { token })).status).toBe(
            200,
        );
        expect((await request("auth/verify-email", { token })).status).toBe(
            400,
        );
        const me = await (await request("auth/me", undefined, cookie)).json();
        expect(me.user.emailVerified).toBe(true);
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
            { plan: "lifetime" },
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
                    { plan: "subscription" },
                    cookie,
                )
            ).status,
        ).toBe(409);
    });

    it("rejects another account's checkout and does not grant an unpaid license", async () => {
        const { cookie, user } = await register();
        await request("auth/verify-email", { token: lastToken() });
        const checkout = await request(
            "billing/checkout",
            { plan: "lifetime" },
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
        expect((await request("auth/me", undefined, cookie)).status).toBe(200);
        expect(
            (
                await request(
                    "auth/delete-account",
                    { confirmation: "delete my account" },
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
});
