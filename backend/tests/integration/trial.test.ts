// The 14-day free trial: when it starts, what it unlocks, when it ends and the
// reminder emails. Also the yearly plan and receipts at checkout.
import { randomBytes, randomUUID } from "node:crypto";
import nock from "nock";
import Stripe from "stripe";
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

import { mockStripe } from "../../../tests/stripe.mjs";
import { createApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import { sessionIdFor } from "../../src/auth/session.js";
import { DAY_MS, TRIAL_DAYS } from "../../src/billing/trial.js";
import {
    claimReminder,
    sendTrialReminders,
} from "../../src/billing/trialReminders.js";
import { sendMail } from "../../src/mail/mailer.js";
import { db } from "../../src/prisma/db.js";

vi.mock("../../src/mail/mailer.js", () => ({
    sendMail: vi.fn().mockResolvedValue(undefined),
}));

const app = createApp();
const stripeApi = mockStripe();
const stripe = new Stripe(process.env["STRIPE_SECRET_KEY"]!);
const webhookSecret = process.env["STRIPE_WEBHOOK_SECRET"]!;
const mail = vi.mocked(sendMail);
const password = "Correct horse battery staple!";
const passwordHash = await hashPassword(password);
const userIds = new Set<number>();
let ip: string;
let ipSequence = 0;

beforeEach(() => {
    ip = `198.18.0.${++ipSequence}`;
    mail.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
    for (const id of userIds) await db.orm.public.User.where({ id }).delete();
    userIds.clear();
    stripeApi.sessions.clear();
    stripeApi.checkoutParams.clear();
    stripeApi.customerUpdates.length = 0;
});
afterAll(async () => {
    stripeApi.close();
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

const hoursFromNow = (hours: number) =>
    new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

const userRow = async (id: number) =>
    (await db.orm.public.User.where({ id }).first())!;

const lastToken = () => {
    const text = mail.mock.calls.at(-1)?.[0].text;
    const token = text?.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    return token!;
};

// Seeded directly, signed in with a session cookie
async function account(fields: {
    verified?: boolean;
    licensePlan?: string | null;
    trialEligible?: boolean;
    trialEndsAt?: string | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    subscriptionStatus?: string | null;
}) {
    const { verified = true, ...rest } = fields;
    const user = await db.orm.public.User.create({
        email: `trial-${randomUUID()}@example.com`,
        passwordHash,
        emailVerifiedAt: verified ? new Date().toISOString() : null,
    });
    userIds.add(user.id);
    if (Object.keys(rest).length) {
        await db.orm.public.User.where({ id: user.id }).update(rest);
    }
    const token = randomBytes(32).toString("base64url");
    await db.orm.public.Session.create({
        id: sessionIdFor(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    return { id: user.id, email: user.email, cookie: `session=${token}` };
}

// Registers through the API: an unverified account, eligible for the trial
async function register() {
    const email = `trial-${randomUUID()}@example.com`;
    expect((await request("auth/register", { email, password })).status).toBe(
        202,
    );
    const user = (await db.orm.public.User.where({ email }).first())!;
    userIds.add(user.id);
    return user;
}

function expectFullTrial(trialEndsAt: string | null, startedAt: number) {
    expect(trialEndsAt).not.toBeNull();
    const length = new Date(trialEndsAt!).getTime() - startedAt;
    expect(length).toBeGreaterThanOrEqual(TRIAL_DAYS * DAY_MS - 1000);
    expect(length).toBeLessThanOrEqual(TRIAL_DAYS * DAY_MS + 60_000);
}

describe("trial start", () => {
    it("starts when the emailed link verifies the address, not at registration", async () => {
        const user = await register();
        expect(user.trialEligible).toBe(true);
        expect(user.trialEndsAt).toBeNull();

        const before = Date.now();
        const response = await request("auth/verify-email", {
            token: lastToken(),
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expectFullTrial(body.user.trialEndsAt, before);
        expect((await userRow(user.id)).trialEndsAt).toBe(
            body.user.trialEndsAt,
        );

        // /me tells the frontend, which sends the user to /overview
        const cookie = response.headers.get("set-cookie")!.split(";")[0];
        const me = await (await request("auth/me", undefined, cookie)).json();
        expect(me.user.trialEndsAt).toBe(body.user.trialEndsAt);
    });

    it("isn't restarted by verifying a changed email address", async () => {
        const user = await register();
        const verified = await request("auth/verify-email", {
            token: lastToken(),
        });
        const cookie = verified.headers.get("set-cookie")!.split(";")[0];
        const { trialEndsAt } = await userRow(user.id);

        const changed = await request(
            "auth/profile",
            {
                email: `trial-${randomUUID()}@example.com`,
                username: "",
                currentPassword: password,
            },
            cookie,
        );
        expect(changed.status).toBe(200);
        expect((await userRow(user.id)).emailVerifiedAt).toBeNull();
        expect(
            (await request("auth/verify-email", { token: lastToken() })).status,
        ).toBe(200);
        const after = await userRow(user.id);
        expect(after.emailVerifiedAt).not.toBeNull();
        expect(after.trialEndsAt).toBe(trialEndsAt);
    });

    it("is never given to accounts from before the trial", async () => {
        const user = await register();
        // what the migration sets on existing rows
        await db.orm.public.User.where({ id: user.id }).update({
            trialEligible: false,
        });
        const response = await request("auth/verify-email", {
            token: lastToken(),
        });
        expect(response.status).toBe(200);
        expect((await response.json()).user.trialEndsAt).toBeNull();
        expect((await userRow(user.id)).trialEndsAt).toBeNull();
    });

    it("starts when a password reset link verifies the address", async () => {
        const user = await register();
        expect(
            (await request("auth/password-reset", { email: user.email }))
                .status,
        ).toBe(204);
        const before = Date.now();
        const response = await request("auth/password-reset/confirm", {
            token: lastToken(),
            newPassword: "Another correct horse battery!",
        });
        expect(response.status).toBe(200);
        expectFullTrial((await response.json()).user.trialEndsAt, before);
    });

    it("starts for a Google sign-up and for a Google sign-in that verifies an account", async () => {
        const signIn = async (email: string) => {
            nock("https://oauth2.googleapis.com")
                .post("/token")
                .reply(200, { access_token: "google-token" });
            nock("https://openidconnect.googleapis.com")
                .get("/v1/userinfo")
                .reply(200, {
                    sub: `g-${randomUUID()}`,
                    email,
                    email_verified: true,
                    name: "Alice",
                });
            const start = await request("auth/oauth/google");
            const state = new URL(
                start.headers.get("location")!,
            ).searchParams.get("state");
            const stateCookie = start.headers.get("set-cookie")!.split(";")[0];
            const response = await request(
                `auth/oauth/google/callback?code=test-code&state=${state}`,
                undefined,
                stateCookie,
            );
            expect(response.status).toBe(302);
            return response.headers.get("location");
        };

        const before = Date.now();
        const email = `trial-${randomUUID()}@example.com`;
        expect(await signIn(email)).toBe("/overview");
        const created = (await db.orm.public.User.where({ email }).first())!;
        userIds.add(created.id);
        expectFullTrial(created.trialEndsAt, before);

        const unverified = await register();
        expect(await signIn(unverified.email)).toBe("/overview");
        expectFullTrial((await userRow(unverified.id)).trialEndsAt, before);
    });

    it("can't be set or extended through the account API", async () => {
        const user = await account({ trialEndsAt: hoursFromNow(1) });
        const { trialEndsAt } = await userRow(user.id);
        const later = hoursFromNow(24 * 365);
        for (const [path, body] of [
            [
                "auth/profile",
                {
                    email: user.email,
                    username: "x",
                    trialEndsAt: later,
                    trialEligible: true,
                    licensePlan: "lifetime",
                },
            ],
            ["auth/verify-email/resend", { trialEndsAt: later }],
        ] as const) {
            await request(path, body, user.cookie);
        }
        const after = await userRow(user.id);
        expect(after.trialEndsAt).toBe(trialEndsAt);
        expect(after.licensePlan).toBeNull();
    });
});

describe("trial access", () => {
    const datasets = (cookie: string) => request("datasets", undefined, cookie);

    it("unlocks the paid API while it runs", async () => {
        const user = await account({ trialEndsAt: hoursFromNow(1) });
        expect((await datasets(user.cookie)).status).toBe(200);
    });

    it("locks it again once the trial has ended", async () => {
        const user = await account({ trialEndsAt: hoursFromNow(-0.01) });
        const response = await datasets(user.cookie);
        expect(response.status).toBe(402);
        expect(await response.json()).toEqual({ error: "No active license" });
    });

    it("still needs a verified email address", async () => {
        const user = await account({
            verified: false,
            trialEndsAt: hoursFromNow(1),
        });
        expect((await datasets(user.cookie)).status).toBe(403);
    });

    it("doesn't affect a paid license", async () => {
        const user = await account({
            licensePlan: "lifetime",
            trialEndsAt: hoursFromNow(-48),
        });
        expect((await datasets(user.cookie)).status).toBe(200);
    });

    it("lets a trial user buy any plan", async () => {
        const user = await account({ trialEndsAt: hoursFromNow(1) });
        for (const plan of ["subscription", "yearly", "lifetime"]) {
            const response = await request(
                "billing/checkout",
                { plan, withdrawalWaiver: true },
                user.cookie,
            );
            expect(response.status, plan).toBe(200);
        }
    });
});

describe("trial reminders", () => {
    const sentTo = (email: string) =>
        mail.mock.calls.map(([m]) => m).filter((m) => m.to === email);

    it("emails three days before the end, once", async () => {
        const user = await account({ trialEndsAt: hoursFromNow(60) });
        await sendTrialReminders();
        await sendTrialReminders();
        const sent = sentTo(user.email);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.subject).toBe("Your PulseBoard trial ends in 3 days");
        expect(sent[0]!.text).toContain("/buy");
        expect((await userRow(user.id)).trialRemindersSent).toBe(1);
    });

    it("emails on the last day, once, after the three-day reminder", async () => {
        const user = await account({ trialEndsAt: hoursFromNow(60) });
        await sendTrialReminders();
        // a day and a half later
        await db.orm.public.User.where({ id: user.id }).update({
            trialEndsAt: hoursFromNow(20),
        });
        await sendTrialReminders();
        await sendTrialReminders();
        expect(sentTo(user.email).map((m) => m.subject)).toEqual([
            "Your PulseBoard trial ends in 3 days",
            "Your PulseBoard trial ends today",
        ]);
        expect((await userRow(user.id)).trialRemindersSent).toBe(2);
    });

    it("only sends the last-day reminder if the three-day one was missed", async () => {
        const user = await account({ trialEndsAt: hoursFromNow(5) });
        await sendTrialReminders();
        expect(sentTo(user.email).map((m) => m.subject)).toEqual([
            "Your PulseBoard trial ends today",
        ]);
    });

    it("sends each reminder once when several instances run at the same time", async () => {
        const user = await account({ trialEndsAt: hoursFromNow(60) });
        await Promise.all([
            sendTrialReminders(),
            sendTrialReminders(),
            sendTrialReminders(),
        ]);
        expect(sentTo(user.email)).toHaveLength(1);
    });

    it("lets only one of several instances that saw the same account claim its reminder", async () => {
        const user = await account({ trialEndsAt: hoursFromNow(60) });
        // each instance read trialRemindersSent = 0 before any of them wrote
        const claims = await Promise.all([
            claimReminder(user.id, 0, 1),
            claimReminder(user.id, 0, 1),
            claimReminder(user.id, 0, 1),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        // and a run after that has nothing left to send
        await sendTrialReminders();
        expect(sentTo(user.email)).toHaveLength(0);
    });

    it("tries again on the next run if sending failed", async () => {
        const user = await account({ trialEndsAt: hoursFromNow(60) });
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        mail.mockRejectedValue(new Error("SMTP down"));
        await sendTrialReminders();
        expect((await userRow(user.id)).trialRemindersSent).toBe(0);
        error.mockRestore();

        mail.mockReset().mockResolvedValue(undefined);
        await sendTrialReminders();
        expect(sentTo(user.email)).toHaveLength(1);
        expect((await userRow(user.id)).trialRemindersSent).toBe(1);
    });

    it("skips paid, ended, far-off, unverified and trial-less accounts", async () => {
        const users = await Promise.all([
            account({ trialEndsAt: hoursFromNow(60), licensePlan: "lifetime" }),
            account({ trialEndsAt: hoursFromNow(-1) }),
            account({ trialEndsAt: hoursFromNow(24 * 10) }),
            account({ trialEndsAt: hoursFromNow(60), verified: false }),
            account({ trialEndsAt: null }),
        ]);
        await sendTrialReminders();
        for (const user of users) expect(sentTo(user.email)).toHaveLength(0);
    });
});

describe("plans at checkout", () => {
    const licenseOf = async (id: number) => (await userRow(id)).licensePlan;

    async function checkout(plan: string, cookie: string) {
        const response = await request(
            "billing/checkout",
            { plan, withdrawalWaiver: true },
            cookie,
        );
        if (response.status !== 200) return { status: response.status };
        const sessionId = new URL((await response.json()).url).searchParams.get(
            "session_id",
        )!;
        return {
            status: 200,
            params: stripeApi.checkoutParams.get(sessionId)!,
        };
    }

    async function deliver(object: Record<string, unknown>, type: string) {
        const payload = JSON.stringify({
            id: `evt_${randomUUID()}`,
            object: "event",
            type,
            data: { object },
        });
        const signature = await stripe.webhooks.generateTestHeaderStringAsync({
            payload,
            secret: webhookSecret,
        });
        const response = await app.request("/api/billing/webhook", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "stripe-signature": signature,
            },
            body: payload,
        });
        expect(response.status).toBe(200);
    }

    it("starts the yearly plan as a subscription at the yearly price", async () => {
        const user = await account({});
        const { status, params } = await checkout("yearly", user.cookie);
        expect(status).toBe(200);
        expect(params.get("mode")).toBe("subscription");
        expect(params.get("line_items[0][price]")).toBe("price_test_yearly");
        expect(params.get("metadata[plan]")).toBe("yearly");
        // subscription receipts come from the Stripe account's email settings
        expect(params.get("payment_intent_data[receipt_email]")).toBeNull();

        const monthly = await checkout("subscription", user.cookie);
        expect(monthly.params!.get("line_items[0][price]")).toBe(
            "price_test_subscription",
        );
    });

    it("asks Stripe to email a receipt for a lifetime payment", async () => {
        const user = await account({});
        const { params } = await checkout("lifetime", user.cookie);
        expect(params!.get("mode")).toBe("payment");
        expect(params!.get("line_items[0][price]")).toBe("price_test_lifetime");
        expect(params!.get("payment_intent_data[receipt_email]")).toBe(
            user.email,
        );
    });

    it("keeps an existing Stripe customer's email current", async () => {
        const customer = `cus_trial_${randomUUID()}`;
        const user = await account({ stripeCustomerId: customer });
        await checkout("yearly", user.cookie);
        expect(stripeApi.customerUpdates).toHaveLength(1);
        expect(stripeApi.customerUpdates[0]!.id).toBe(customer);
        expect(stripeApi.customerUpdates[0]!.fields.get("email")).toBe(
            user.email,
        );
    });

    it("refuses a second subscription; switching happens in the portal", async () => {
        const user = await account({ licensePlan: "subscription" });
        expect((await checkout("subscription", user.cookie)).status).toBe(409);
        expect((await checkout("yearly", user.cookie)).status).toBe(409);
        expect((await checkout("lifetime", user.cookie)).status).toBe(200);
    });

    it("grants a yearly subscription from the webhook, and a lifetime purchase cancels it", async () => {
        const customer = `cus_trial_${randomUUID()}`;
        const user = await account({
            stripeCustomerId: customer,
            trialEndsAt: hoursFromNow(48),
        });
        const subscription = `sub_${randomUUID()}`;
        const retrieved = nock("https://api.stripe.com")
            .get(`/v1/subscriptions/${subscription}`)
            .reply(200, {
                id: subscription,
                object: "subscription",
                customer,
                status: "active",
                items: {
                    object: "list",
                    data: [
                        {
                            price: {
                                id: "price_test_yearly",
                                recurring: { interval: "year" },
                            },
                        },
                    ],
                },
            });
        await deliver(
            {
                id: `cs_test_${randomUUID()}`,
                object: "checkout.session",
                mode: "subscription",
                payment_status: "paid",
                subscription,
                customer,
                client_reference_id: String(user.id),
                metadata: { plan: "yearly" },
            },
            "checkout.session.completed",
        );
        expect(retrieved.isDone()).toBe(true);
        let row = await userRow(user.id);
        expect(row.licensePlan).toBe("subscription");
        expect(row.stripeSubscriptionId).toBe(subscription);
        expect(row.subscriptionStatus).toBe("active");

        const cancelled = nock("https://api.stripe.com")
            .delete(`/v1/subscriptions/${subscription}`)
            .reply(200, {
                id: subscription,
                object: "subscription",
                status: "canceled",
            });
        await deliver(
            {
                id: `cs_test_${randomUUID()}`,
                object: "checkout.session",
                mode: "payment",
                payment_status: "paid",
                subscription: null,
                customer,
                client_reference_id: String(user.id),
                metadata: { plan: "lifetime" },
            },
            "checkout.session.completed",
        );
        expect(cancelled.isDone()).toBe(true);
        expect(await licenseOf(user.id)).toBe("lifetime");
    });
});
