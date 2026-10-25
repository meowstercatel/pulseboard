// Two users, A and B: nothing B sends may read, change or delete A's data.
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
import { db } from "../../src/prisma/db.js";

vi.mock("../../src/mail/mailer.js", () => ({
    sendMail: vi.fn().mockResolvedValue(undefined),
}));

const app = createApp();
const stripeApi = mockStripe();
const stripe = new Stripe(process.env["STRIPE_SECRET_KEY"]!);
const webhookSecret = process.env["STRIPE_WEBHOOK_SECRET"]!;
// what the browser sends, so CSRF checks pass
const origin = process.env["PUBLIC_URL"]!;
const password = "Correct horse battery staple!";
const passwordHash = await hashPassword(password);
const userIds = new Set<number>();
let ip: string;
let ipSequence = 0;

beforeEach(() => {
    ip = `203.0.113.${++ipSequence}`;
});
afterEach(async () => {
    for (const id of userIds) await db.orm.public.User.where({ id }).delete();
    userIds.clear();
    stripeApi.sessions.clear();
});
afterAll(async () => {
    stripeApi.close();
    await db.close();
});

// Every route that takes a dataset id. `path` must be a request the owner can
// make, so anyone else's 404 comes from the ownership check, not validation.
// A new /:id/... route fails "lists every dataset id route" until it is added.
const DATASET_ROUTES: Record<string, { path: string; ownerStatus: number }> = {
    "GET /api/datasets/:id/hosts": { path: "hosts?q=web", ownerStatus: 200 },
    "GET /api/datasets/:id/metrics": {
        path: "metrics?host=web&range=all",
        ownerStatus: 200,
    },
    "GET /api/datasets/:id/stats": {
        path: "stats?host=web&range=all",
        ownerStatus: 200,
    },
    "GET /api/datasets/:id/history": {
        path: "history?host=web&range=all&bucket=1h",
        ownerStatus: 200,
    },
    // too little history to forecast, but past the ownership check
    "GET /api/datasets/:id/forecast": {
        path: "forecast?host=web&metric=cpuPercent&horizon=24h",
        ownerStatus: 422,
    },
    "DELETE /api/datasets/:id": { path: "", ownerStatus: 204 },
};

const NOT_FOUND = { error: "Dataset not found" };

// Ids that never name a dataset, whoever asks
const ODD_IDS = [
    "0",
    "-1",
    "2147483648",
    "99999999999",
    "abc",
    "1e1",
    "0x1",
    "1.0",
    "+1",
    "%201",
];

async function account({ licensed = true } = {}) {
    const now = new Date().toISOString();
    const email = `authz-${randomUUID()}@example.com`;
    const user = await db.orm.public.User.create({
        email,
        passwordHash,
        emailVerifiedAt: now,
        licensePlan: licensed ? "lifetime" : null,
        licensedAt: licensed ? now : null,
    });
    userIds.add(user.id);
    const customer = `cus_authz_${user.id}`;
    await db.orm.public.User.where({ id: user.id }).update({
        stripeCustomerId: customer,
    });
    const token = randomBytes(32).toString("base64url");
    await db.orm.public.Session.create({
        id: token,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    return { id: user.id, email, customer, cookie: `session=${token}` };
}
type Account = Awaited<ReturnType<typeof account>>;

async function dataset(ownerId: number) {
    const created = await db.orm.public.Dataset.create({
        ownerId,
        name: "Metrics",
        rowCount: 3,
    });
    for (const timestamp of [
        "2026-09-01T00:00:00Z",
        "2026-09-01T01:00:00Z",
        "2026-09-01T02:00:00Z",
    ]) {
        await db.orm.public.Metric.create({
            datasetId: created.id,
            host: "web",
            timestamp,
            cpuPercent: 20,
            ramPercent: 30,
            diskPercent: 40,
            netInMbps: 5.5,
            netOutMbps: 1.25,
        });
    }
    return created.id;
}

// Everything of a user's that another user could try to reach
async function snapshot(userId: number) {
    const user = await db.orm.public.User.where({ id: userId }).first();
    const datasets = await db.orm.public.Dataset.where({ ownerId: userId })
        .orderBy((d) => d.id.asc())
        .all();
    const metrics: Record<number, number> = {};
    for (const { id } of datasets) {
        metrics[id] = (
            await db.orm.public.Metric.where({ datasetId: id }).all()
        ).length;
    }
    const sessions = (
        await db.orm.public.Session.where({ userId })
            .orderBy((s) => s.id.asc())
            .all()
    ).map((s) => s.id);
    const oauthAccounts = await db.orm.public.OAuthAccount.where({
        userId,
    }).all();
    return { user, datasets, metrics, sessions, oauthAccounts };
}

function datasetRequest(
    route: string,
    cookie: string,
    id: number | string,
    path: string,
) {
    const method = route.split(" ")[0]!;
    return app.request(`/api/datasets/${id}${path ? `/${path}` : ""}`, {
        method,
        headers: { cookie, origin },
    });
}

function request(path: string, body?: unknown, cookie?: string) {
    return app.request(`/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            "content-type": "application/json",
            "x-forwarded-for": ip,
            origin,
            ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

async function expectNotFound(response: Response, label: string) {
    expect(response.status, label).toBe(404);
    expect(await response.json(), label).toEqual(NOT_FOUND);
}

describe("dataset id routes", () => {
    it("lists every dataset id route", () => {
        const routes = new Set(
            app.routes
                .filter(
                    (r) => /\/:id(\/|$)/.test(r.path) && !r.path.endsWith("*"),
                )
                .map((r) => `${r.method} ${r.path}`),
        );
        expect([...routes].sort()).toEqual(Object.keys(DATASET_ROUTES).sort());
    });

    describe.each(Object.entries(DATASET_ROUTES))(
        "%s",
        (route, { path, ownerStatus }) => {
            it("answers another user with the same 404 as a missing dataset", async () => {
                const a = await account();
                const b = await account();
                const target = await dataset(a.id);
                await dataset(b.id);
                const gone = await dataset(a.id);
                await db.orm.public.Dataset.where({ id: gone }).delete();
                const before = await snapshot(a.id);

                await expectNotFound(
                    await datasetRequest(route, b.cookie, target, path),
                    "A's dataset",
                );
                await expectNotFound(
                    await datasetRequest(route, b.cookie, `00${target}`, path),
                    "A's dataset with leading zeros",
                );
                await expectNotFound(
                    await datasetRequest(route, b.cookie, gone, path),
                    "deleted dataset",
                );
                expect(await snapshot(a.id)).toEqual(before);

                // the same request is fine for the owner
                expect(
                    (await datasetRequest(route, a.cookie, target, path))
                        .status,
                ).toBe(ownerStatus);
            });

            it("answers 404 for odd and deleted ids, even to the owner", async () => {
                const a = await account();
                const target = await dataset(a.id);
                const gone = await dataset(a.id);
                await db.orm.public.Dataset.where({ id: gone }).delete();
                const before = await snapshot(a.id);

                for (const id of [
                    ...ODD_IDS,
                    `0x${target.toString(16)}`,
                    `${target}.0`,
                    `${target}e0`,
                    String(gone),
                ]) {
                    await expectNotFound(
                        await datasetRequest(route, a.cookie, id, path),
                        id,
                    );
                }
                expect(await snapshot(a.id)).toEqual(before);
            });
        },
    );
});

describe("dataset list and upload", () => {
    function upload(cookie: string, extra: Record<string, string>) {
        const form = new FormData();
        form.set(
            "file",
            new File(
                [
                    "timestamp,host,cpu_percent,ram_percent,disk_percent,net_in_mbps,net_out_mbps\n" +
                        "2026-09-01T00:00:00Z,web,1,2,3,4,5\n",
                ],
                "metrics.csv",
                { type: "text/csv" },
            ),
        );
        for (const [key, value] of Object.entries(extra)) form.set(key, value);
        return app.request("/api/datasets", {
            method: "POST",
            headers: { cookie, origin },
            body: form,
        });
    }

    it("lists only the session user's datasets", async () => {
        const a = await account();
        const b = await account();
        await dataset(a.id);
        const own = await dataset(b.id);

        const response = await app.request(
            `/api/datasets?ownerId=${a.id}&userId=${a.id}`,
            { headers: { cookie: b.cookie } },
        );
        expect(response.status).toBe(200);
        const { datasets } = await response.json();
        expect(datasets.map((d: { id: number }) => d.id)).toEqual([own]);
    });

    it("saves an upload under the session user, whatever the form says", async () => {
        const a = await account();
        const b = await account();
        await dataset(a.id);
        const before = await snapshot(a.id);

        const response = await upload(b.cookie, {
            ownerId: String(a.id),
            userId: String(a.id),
            id: String(before.datasets[0]!.id),
        });
        expect(response.status).toBe(201);
        const { dataset: created } = await response.json();
        expect(
            (await db.orm.public.Dataset.where({ id: created.id }).first())
                ?.ownerId,
        ).toBe(b.id);
        expect(await snapshot(a.id)).toEqual(before);
    });
});

describe("account endpoints", () => {
    // ids a client might try to slip in; the handlers only use the session
    const foreignIds = (a: Account) => ({ id: a.id, userId: a.id });

    it("changes only the session user's profile", async () => {
        const a = await account();
        const b = await account();
        await dataset(a.id);
        const before = await snapshot(a.id);

        const response = await request(
            `auth/profile?id=${a.id}`,
            { ...foreignIds(a), email: b.email, username: "renamed" },
            b.cookie,
        );
        expect(response.status).toBe(200);
        expect((await response.json()).user).toMatchObject({
            id: b.id,
            username: "renamed",
        });
        expect(await snapshot(a.id)).toEqual(before);
    });

    it("refuses to take another user's email", async () => {
        const a = await account();
        const b = await account();
        const before = await snapshot(a.id);

        const response = await request(
            "auth/profile",
            { email: a.email, username: "", currentPassword: password },
            b.cookie,
        );
        expect(response.status).toBe(409);
        expect(await snapshot(a.id)).toEqual(before);
    });

    it("changes only the session user's password", async () => {
        const a = await account();
        const b = await account();
        const before = await snapshot(a.id);

        const response = await request(
            "auth/password",
            {
                ...foreignIds(a),
                currentPassword: password,
                newPassword: "A different long password",
            },
            b.cookie,
        );
        expect(response.status).toBe(200);
        expect((await response.json()).user.id).toBe(b.id);
        expect(await snapshot(a.id)).toEqual(before);
    });

    it("deletes only the session user's account", async () => {
        const a = await account();
        const b = await account();
        await dataset(a.id);
        const before = await snapshot(a.id);

        const response = await request(
            "auth/delete-account",
            { ...foreignIds(a), confirmation: "delete my account" },
            b.cookie,
        );
        expect(response.status).toBe(204);
        expect(await db.orm.public.User.where({ id: b.id }).first()).toBeNull();
        expect(await snapshot(a.id)).toEqual(before);
    });
});

describe("billing", () => {
    const licenseOf = async (id: number) =>
        (await db.orm.public.User.where({ id }).first())?.licensePlan ?? null;

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

    const lifetimeCheckout = (fields: Record<string, unknown>) => ({
        id: `cs_test_${randomUUID()}`,
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        subscription: null,
        client_reference_id: null,
        customer: null,
        ...fields,
    });

    it("rejects confirming another user's Checkout session", async () => {
        const a = await account({ licensed: false });
        const b = await account({ licensed: false });
        const checkout = await request(
            "billing/checkout",
            { plan: "lifetime", withdrawalWaiver: true },
            a.cookie,
        );
        expect(checkout.status).toBe(200);
        const sessionId = new URL((await checkout.json()).url).searchParams.get(
            "session_id",
        );
        const before = await snapshot(a.id);

        for (const id of [sessionId, `cs_test_${randomUUID()}`]) {
            const response = await request(
                "billing/confirm",
                { sessionId: id },
                b.cookie,
            );
            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({ error: "Invalid session" });
        }
        expect(await snapshot(a.id)).toEqual(before);
        expect(await licenseOf(b.id)).toBeNull();

        // the session itself is good: its owner can confirm it
        expect(
            (await request("billing/confirm", { sessionId }, a.cookie)).status,
        ).toBe(200);
        expect(await licenseOf(a.id)).toBe("lifetime");
        expect(await licenseOf(b.id)).toBeNull();
    });

    it("opens the portal for the session user's customer only", async () => {
        const a = await account();
        const b = await account();
        let customer: string | null = null;
        nock("https://api.stripe.com")
            .post("/v1/billing_portal/sessions")
            .reply(200, async (req: Request) => {
                customer = new URLSearchParams(await req.text()).get(
                    "customer",
                );
                return {
                    id: "bps_test",
                    object: "billing_portal.session",
                    url: "https://billing.stripe.com/p/session/test",
                };
            });

        const response = await request(
            "billing/portal",
            { customer: a.customer, userId: a.id },
            b.cookie,
        );
        expect(response.status).toBe(200);
        expect(customer).toBe(b.customer);
    });

    it("grants a lifetime webhook purchase to client_reference_id, never metadata.userId", async () => {
        const a = await account({ licensed: false });
        const b = await account({ licensed: false });

        await deliver(
            lifetimeCheckout({
                metadata: { plan: "lifetime", userId: String(b.id) },
            }),
            "checkout.session.completed",
        );
        expect(await licenseOf(a.id)).toBeNull();
        expect(await licenseOf(b.id)).toBeNull();

        await deliver(
            lifetimeCheckout({
                client_reference_id: String(a.id),
                customer: a.customer,
                metadata: { plan: "lifetime", userId: String(b.id) },
            }),
            "checkout.session.completed",
        );
        expect(await licenseOf(a.id)).toBe("lifetime");
        expect(await licenseOf(b.id)).toBeNull();
    });

    it("ignores a lifetime purchase whose customer isn't the referenced user's", async () => {
        const a = await account({ licensed: false });
        const b = await account({ licensed: false });

        // e.g. a Payment Link opened with ?client_reference_id=<A>
        for (const customer of [b.customer, `cus_${randomUUID()}`, null]) {
            await deliver(
                lifetimeCheckout({
                    client_reference_id: String(a.id),
                    customer,
                    metadata: { plan: "lifetime" },
                }),
                "checkout.session.completed",
            );
        }
        expect(await licenseOf(a.id)).toBeNull();
        expect(await licenseOf(b.id)).toBeNull();
    });

    it("gives a subscription to its Stripe customer, whatever the session references", async () => {
        const a = await account({ licensed: false });
        const b = await account({ licensed: false });
        const subscription = `sub_${randomUUID()}`;
        const retrieved = nock("https://api.stripe.com")
            .get(`/v1/subscriptions/${subscription}`)
            .twice()
            .reply(200, {
                id: subscription,
                object: "subscription",
                customer: a.customer,
                status: "active",
            });

        await deliver(
            {
                ...lifetimeCheckout({
                    client_reference_id: String(b.id),
                    metadata: { plan: "subscription", userId: String(b.id) },
                }),
                mode: "subscription",
                subscription,
            },
            "checkout.session.completed",
        );
        await deliver(
            { id: subscription, object: "subscription" },
            "customer.subscription.updated",
        );
        expect(retrieved.isDone()).toBe(true);
        expect(await licenseOf(a.id)).toBe("subscription");
        expect(await licenseOf(b.id)).toBeNull();
    });
});

describe("OAuth linking", () => {
    function mockGoogle(profile: { sub: string; email: string }) {
        return [
            nock("https://oauth2.googleapis.com")
                .post("/token")
                .reply(200, { access_token: "google-token" }),
            nock("https://openidconnect.googleapis.com")
                .get("/v1/userinfo")
                .reply(200, {
                    ...profile,
                    email_verified: true,
                    name: "Someone",
                }),
        ];
    }

    // The browser's round trip, optionally while already signed in
    async function signInWithGoogle(
        google: nock.Scope[],
        sessionCookie?: string,
    ) {
        const start = await request("auth/oauth/google", undefined);
        const state = new URL(start.headers.get("location")!).searchParams.get(
            "state",
        );
        const stateCookie = start.headers.get("set-cookie")!.split(";")[0];
        const response = await request(
            `auth/oauth/google/callback?code=test-code&state=${state}`,
            undefined,
            [stateCookie, sessionCookie].filter(Boolean).join("; "),
        );
        expect(response.status).toBe(302);
        expect(google.every((scope) => scope.isDone())).toBe(true);
        const cookie = response.headers
            .getSetCookie()
            .find((c) => c.startsWith("session="))!
            .split(";")[0]!;
        const me = await request("auth/me", undefined, cookie);
        return (await me.json()).user.id as number;
    }

    it("signs a linked Google account in to its owner even if it now has another user's email", async () => {
        const a = await account();
        const b = await account();
        const sub = `g-${randomUUID()}`;
        await db.orm.public.OAuthAccount.create({
            provider: "google",
            providerUserId: sub,
            userId: a.id,
            email: a.email,
        });
        const before = await snapshot(b.id);

        const google = mockGoogle({ sub, email: b.email });
        expect(await signInWithGoogle(google)).toBe(a.id);
        expect(await snapshot(b.id)).toEqual(before);
    });

    it("links by the provider's email, never to whoever is signed in", async () => {
        const a = await account();
        const b = await account();
        const sub = `g-${randomUUID()}`;
        const before = await snapshot(a.id);

        const google = mockGoogle({ sub, email: b.email });
        expect(await signInWithGoogle(google, a.cookie)).toBe(b.id);
        expect(await snapshot(a.id)).toEqual(before);
        expect(
            await db.orm.public.OAuthAccount.where({
                provider: "google",
                providerUserId: sub,
            }).first(),
        ).toMatchObject({ userId: b.id });
    });
});
