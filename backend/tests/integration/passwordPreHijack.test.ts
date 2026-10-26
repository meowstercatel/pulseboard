// Password pre-hijack: an intruder registers with email + password using the
// owner's address. The account stays unverified until the owner opens the
// link in their inbox, and the intruder's password must not survive that.
import { randomBytes, randomUUID } from "node:crypto";
import {
    afterAll,
    afterEach,
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
});

import { createApp } from "../../src/app.js";
import { sessionIdFor } from "../../src/auth/session.js";
import { DAY_MS, TRIAL_DAYS } from "../../src/billing/trial.js";
import { sendMail } from "../../src/mail/mailer.js";
import { db } from "../../src/prisma/db.js";

vi.mock("../../src/mail/mailer.js", () => ({
    sendMail: vi.fn().mockResolvedValue(undefined),
}));

const app = createApp();
const mail = vi.mocked(sendMail);
// the intruder's password, set at registration
const password = "The intruder's own password!";
const ownersPassword = "The address owner's password!";
const userIds = new Set<number>();
let ip: string;
let ipSequence = 0;

beforeEach(() => {
    ip = `203.0.113.${++ipSequence}`;
    mail.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
    for (const id of userIds) await db.orm.public.User.where({ id }).delete();
    userIds.clear();
});
afterAll(async () => {
    await db.close();
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

const userRow = async (id: number) =>
    (await db.orm.public.User.where({ id }).first())!;

function lastMail() {
    const sent = mail.mock.calls.at(-1)?.[0];
    expect(sent).toBeTruthy();
    return sent!;
}

function linkToken(text: string, path: string) {
    const token = text.match(
        new RegExp(`${path}\\?(?:purpose=set&)?token=([\\w-]+)`),
    )?.[1];
    expect(token).toBeTruthy();
    return token!;
}

// The intruder registers the owner's address and logs in with their
// password; the verification link goes to the owner's inbox
async function intruderSignUp() {
    const email = `prehijack-${randomUUID()}@example.com`;
    expect((await request("auth/register", { email, password })).status).toBe(
        202,
    );
    const user = (await db.orm.public.User.where({ email }).first())!;
    userIds.add(user.id);
    const token = linkToken(lastMail().text, "/verify-email");
    const login = await request("auth/login", { email, password });
    expect(login.status).toBe(200);
    return { email, id: user.id, token, intruder: sessionCookie(login)! };
}

const verify = (token: string, extra: object = {}, cookie?: string) =>
    request("auth/verify-email", { token, ...extra }, cookie);
const notMine = (token: string, cookie?: string) =>
    request("auth/verify-email/not-mine", { token }, cookie);
const me = (cookie: string | undefined) =>
    request("auth/me", undefined, cookie);

function expectFullTrial(trialEndsAt: string | null, startedAt: number) {
    expect(trialEndsAt).not.toBeNull();
    const length = new Date(trialEndsAt!).getTime() - startedAt;
    expect(length).toBeGreaterThanOrEqual(TRIAL_DAYS * DAY_MS - 1000);
    expect(length).toBeLessThanOrEqual(TRIAL_DAYS * DAY_MS + 60_000);
}

describe("the owner opening the link of an account someone else registered", () => {
    // The reproduction: on staging the owner's click verified the account
    // and signed them in, while the intruder's password kept working
    it("doesn't hand the owner an account the intruder's password still opens", async () => {
        const { email, id, token, intruder } = await intruderSignUp();

        const response = await verify(token);

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
            error: "Enter the account's password to finish verifying",
            confirm: "password",
            email,
        });
        expect(sessionCookie(response)).toBeUndefined();
        expect((await userRow(id)).emailVerifiedAt).toBeNull();
        // nothing changed, so the owner can still choose what to do
        expect((await me(intruder)).status).toBe(200);
        expect(
            await db.orm.public.EmailVerification.where({ userId: id }).all(),
        ).toHaveLength(1);

        expect((await notMine(token)).status).toBe(200);
        expect((await me(intruder)).status).toBe(401);
        expect((await request("auth/login", { email, password })).status).toBe(
            401,
        );
    });

    it("doesn't count another account's session as the account's own", async () => {
        const { token } = await intruderSignUp();
        const other = await intruderSignUp();

        const response = await verify(token, {}, other.intruder);

        expect(response.status).toBe(403);
        // and the other account stays signed in
        expect((await me(other.intruder)).status).toBe(200);
    });

    it("rejects an invalid or used link before asking for anything", async () => {
        const { token } = await intruderSignUp();
        expect((await verify("not-a-token")).status).toBe(400);
        expect((await verify("not-a-token", { password })).status).toBe(400);
        expect((await notMine("not-a-token")).status).toBe(400);
        expect((await notMine(token)).status).toBe(200);
        expect((await verify(token)).status).toBe(400);
        expect((await verify(token, { password })).status).toBe(400);
        expect((await notMine(token)).status).toBe(400);
    });

    // a reset link verifies the address too, without using up this link
    it("treats a link as used once a reset verified the address", async () => {
        const { email, id, token } = await intruderSignUp();
        mail.mockClear();
        await request("auth/password-reset", { email });
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());
        expect(
            (
                await request("auth/password-reset/confirm", {
                    token: linkToken(lastMail().text, "/reset-password"),
                    newPassword: ownersPassword,
                })
            ).status,
        ).toBe(200);

        expect((await verify(token)).status).toBe(400);
        expect((await verify(token, { password: ownersPassword })).status).toBe(
            400,
        );
        expect((await notMine(token)).status).toBe(400);
        expect((await userRow(id)).passwordHash).not.toBeNull();
    });

    it.each([
        { password: 12345678 },
        { password: "x".repeat(257) },
        { password: null },
    ])("rejects a malformed password: %j", async (extra) => {
        const { token } = await intruderSignUp();
        expect((await verify(token, extra)).status).toBe(400);
    });
});

describe("verifying with the account's password", () => {
    it("verifies and signs in with the right password, and only with it", async () => {
        const { id, token, intruder } = await intruderSignUp();

        const wrong = await verify(token, { password: "not the password" });
        expect(wrong.status).toBe(401);
        expect(await wrong.json()).toEqual({ error: "Wrong password" });
        expect(sessionCookie(wrong)).toBeUndefined();
        expect((await userRow(id)).emailVerifiedAt).toBeNull();

        const before = Date.now();
        const response = await verify(token, { password });

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({
            user: { id, emailVerified: true },
            removedLogins: [],
            needsPassword: false,
        });
        // the trial starts here, once
        expectFullTrial(body.user.trialEndsAt, before);
        const cookie = sessionCookie(response)!;
        expect((await me(cookie)).status).toBe(200);
        // whoever else was signed in isn't any more, as before
        expect((await me(intruder)).status).toBe(401);
        expect(
            await db.orm.public.Session.where({ userId: id }).all(),
        ).toHaveLength(1);
        // the link is used up, so it can't verify or restart anything again
        expect((await verify(token, { password })).status).toBe(400);
        expect((await userRow(id)).trialEndsAt).toBe(body.user.trialEndsAt);
    });

    it("needs no password from the account's own session, as before", async () => {
        const { id, token, intruder: own } = await intruderSignUp();

        const response = await verify(token, {}, own);

        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect((await me(own)).status).toBe(200);
        expect((await userRow(id)).trialEndsAt).not.toBeNull();
    });

    it("needs no password for an account without one, as before", async () => {
        const email = `prehijack-${randomUUID()}@example.com`;
        const user = await db.orm.public.User.create({
            email,
            passwordHash: null,
        });
        userIds.add(user.id);
        await request("auth/password-reset", { email });
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());

        const response = await verify(
            linkToken(lastMail().text, "/verify-email"),
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ needsPassword: true });
        expect(sessionCookie(response)).toBeTruthy();
    });

    it("wants the password the account has now", async () => {
        const { id, token, intruder } = await intruderSignUp();
        const changed = await request(
            "auth/password",
            { currentPassword: password, newPassword: "Changed in between!" },
            intruder,
        );
        expect(changed.status).toBe(200);

        const response = await verify(token, { password });

        expect(response.status).toBe(401);
        expect((await userRow(id)).emailVerifiedAt).toBeNull();
    });

    it("limits password guesses like a login, and shares the limit with it", async () => {
        const { email, id, token } = await intruderSignUp();
        // the intruder's own login reset the per-IP count; ten wrong guesses
        // from one IP use it up
        for (let i = 0; i < 10; i++) {
            expect(
                (await verify(token, { password: `guess ${i}!!` })).status,
            ).toBe(401);
        }

        const limited = await verify(token, { password });
        expect(limited.status).toBe(429);
        expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
        expect((await userRow(id)).emailVerifiedAt).toBeNull();
        // the login form doesn't get a fresh allowance for the same account
        expect((await request("auth/login", { email, password })).status).toBe(
            429,
        );
        // another IP still can
        ip = `203.0.113.${++ipSequence}`;
        expect((await verify(token, { password })).status).toBe(200);
    });
});

describe("I didn't create this account", () => {
    it("verifies the address, signs everyone out and replaces the password with the owner's", async () => {
        const { email, id, token, intruder } = await intruderSignUp();
        // a second device of the intruder's
        const second = sessionCookie(
            await request("auth/login", { email, password }),
        );
        const before = Date.now();
        mail.mockClear();

        const response = await notMine(token);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ email, emailSent: true });
        // nobody is signed in: the owner chooses a password first
        expect(sessionCookie(response)).toBeUndefined();
        expect(await db.orm.public.Session.where({ userId: id }).all()).toEqual(
            [],
        );
        expect((await me(intruder)).status).toBe(401);
        expect((await me(second)).status).toBe(401);
        const row = await userRow(id);
        expect(row.emailVerifiedAt).not.toBeNull();
        expect(row.passwordHash).toBeNull();
        expectFullTrial(row.trialEndsAt, before);
        expect((await request("auth/login", { email, password })).status).toBe(
            401,
        );

        // a set-password link, with the address after the # for password managers
        const sent = lastMail();
        expect(sent).toMatchObject({
            to: email,
            subject: "Choose a password for PulseBoard",
        });
        expect(sent.text).toContain(
            `/reset-password?purpose=set&token=${linkToken(sent.text, "/reset-password")}#email=${encodeURIComponent(email)}`,
        );
        const confirm = await request("auth/password-reset/confirm", {
            token: linkToken(sent.text, "/reset-password"),
            newPassword: ownersPassword,
        });
        expect(confirm.status).toBe(200);
        // setting it doesn't restart the trial
        expect((await confirm.json()).user.trialEndsAt).toBe(row.trialEndsAt);
        expect((await userRow(id)).trialEndsAt).toBe(row.trialEndsAt);
        expect(
            (await request("auth/login", { email, password: ownersPassword }))
                .status,
        ).toBe(200);
        expect((await request("auth/login", { email, password })).status).toBe(
            401,
        );
    });

    it("removes the logins that don't prove the address, like a Facebook sign-up's", async () => {
        const { email, id, token } = await intruderSignUp();
        const proven = `g-${randomUUID()}`;
        await db.orm.public.OAuthAccount.create({
            provider: "google",
            providerUserId: proven,
            userId: id,
            email,
        });
        await db.orm.public.OAuthAccount.create({
            provider: "google",
            providerUserId: `g-${randomUUID()}`,
            userId: id,
            email: `intruder-${randomUUID()}@example.com`,
        });
        await db.orm.public.OAuthAccount.create({
            provider: "facebook",
            providerUserId: `fb-${randomUUID()}`,
            userId: id,
            email,
        });

        expect((await notMine(token)).status).toBe(200);

        expect(
            await db.orm.public.OAuthAccount.where({ userId: id }).all(),
        ).toMatchObject([{ provider: "google", providerUserId: proven }]);
    });

    it("cancels earlier password links, so only the new one works", async () => {
        const { email, id, token } = await intruderSignUp();
        mail.mockClear();
        await request("auth/password-reset", { email });
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());
        const earlier = linkToken(lastMail().text, "/reset-password");

        expect((await notMine(token)).status).toBe(200);

        expect(
            await db.orm.public.PasswordReset.where({ userId: id }).all(),
        ).toHaveLength(1);
        expect(
            (
                await request("auth/password-reset/confirm", {
                    token: earlier,
                    newPassword: ownersPassword,
                })
            ).status,
        ).toBe(400);
    });

    it("doesn't restart a trial the account already used", async () => {
        // the intruder verified their own address, then moved the account to
        // the owner's: its trial started back then
        const intruder = await intruderSignUp();
        await verify(intruder.token, { password });
        const { trialEndsAt } = await userRow(intruder.id);
        expect(trialEndsAt).not.toBeNull();
        const email = `prehijack-${randomUUID()}@example.com`;
        const cookie = sessionCookie(
            await request("auth/login", { email: intruder.email, password }),
        );
        expect(
            (
                await request(
                    "auth/profile",
                    { email, username: "", currentPassword: password },
                    cookie,
                )
            ).status,
        ).toBe(200);

        expect(
            (await notMine(linkToken(lastMail().text, "/verify-email"))).status,
        ).toBe(200);

        expect((await userRow(intruder.id)).trialEndsAt).toBe(trialEndsAt);
    });

    it("still secures the account if the email can't be sent, and forgot-password sends another", async () => {
        const { email, id, token, intruder } = await intruderSignUp();
        mail.mockRejectedValueOnce(new Error("SMTP down"));
        vi.spyOn(console, "error").mockImplementation(() => {});

        const response = await notMine(token);

        expect(await response.json()).toEqual({ email, emailSent: false });
        expect((await me(intruder)).status).toBe(401);
        expect((await userRow(id)).passwordHash).toBeNull();
        mail.mockClear();
        await request("auth/password-reset", { email });
        await vi.waitFor(() =>
            expect(mail).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    to: email,
                    subject: "Set a password for PulseBoard",
                }),
            ),
        );
    });

    it("signs the clicker out only if their session was the account's", async () => {
        const { token, intruder: own } = await intruderSignUp();
        const response = await notMine(token, own);
        expect(response.headers.get("set-cookie")).toMatch(/^session=;/);

        const other = await intruderSignUp();
        const next = await intruderSignUp();
        const kept = await notMine(next.token, other.intruder);
        expect(kept.headers.get("set-cookie")).toBeNull();
        expect((await me(other.intruder)).status).toBe(200);
    });

    // A password login checks the old password, then opens its session. One
    // that checked it before the owner's click must not open a session after.
    it("doesn't let a login that started before it sign in after it", async () => {
        const { email, id, token } = await intruderSignUp();

        // the login is still hashing when the owner's click lands
        const login = request("auth/login", { email, password });
        await new Promise((r) => setTimeout(r, 20));
        const disowned = await notMine(token);
        const loggedIn = await login;

        expect(disowned.status).toBe(200);
        const cookie = sessionCookie(loggedIn);
        if (loggedIn.status === 200) {
            // it got in first, so its session went with the rest
            expect((await me(cookie)).status).toBe(401);
        } else {
            expect(loggedIn.status).toBe(401);
        }
        expect(await db.orm.public.Session.where({ userId: id }).all()).toEqual(
            [],
        );
    });
});

describe("seeded sessions", () => {
    // an expired session of the account isn't its own
    it("asks for the password when the account's session has expired", async () => {
        const { id, token } = await intruderSignUp();
        const raw = randomBytes(32).toString("base64url");
        await db.orm.public.Session.create({
            id: sessionIdFor(raw),
            userId: id,
            expiresAt: new Date(Date.now() - 1000).toISOString(),
        });
        expect((await verify(token, {}, `session=${raw}`)).status).toBe(403);
    });
});
