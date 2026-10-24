import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { db } from "../../src/prisma/db.js";

const app = createApp();
const origin = process.env["PUBLIC_URL"]!;
const foreign = "https://evil.example";
const userIds = new Set<number>();

afterEach(async () => {
    for (const id of userIds) await db.orm.public.User.where({ id }).delete();
    userIds.clear();
});
afterAll(async () => {
    await db.close();
});

const logout = (headers: Record<string, string>) =>
    app.request("/api/auth/logout", { method: "POST", headers });

describe("csrf", () => {
    it("rejects cross-origin form posts", async () => {
        const form = new FormData();
        form.set("file", new File(["a,b\n"], "x.csv", { type: "text/csv" }));
        const upload = await app.request("/api/datasets", {
            method: "POST",
            headers: { origin: foreign },
            body: form,
        });
        expect(upload.status).toBe(403);

        expect((await logout({ origin: foreign })).status).toBe(403);
        expect((await logout({ "sec-fetch-site": "cross-site" })).status).toBe(
            403,
        );
        const remove = await app.request("/api/datasets/1", {
            method: "DELETE",
            headers: { origin: foreign },
        });
        expect(remove.status).toBe(403);
    });

    it("accepts same-origin posts", async () => {
        expect((await logout({ origin })).status).toBe(204);
        expect((await logout({ "sec-fetch-site": "same-origin" })).status).toBe(
            204,
        );
    });

    it("does not open JSON endpoints to other origins", async () => {
        const response = await app.request("/api/auth/login", {
            method: "OPTIONS",
            headers: {
                origin: foreign,
                "access-control-request-method": "POST",
                "access-control-request-headers": "content-type",
            },
        });
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
});

describe("stripe webhook", () => {
    const secret = process.env["STRIPE_WEBHOOK_SECRET"]!;
    const stripe = new Stripe(process.env["STRIPE_SECRET_KEY"]!);

    async function unlicensedUser() {
        const user = await db.orm.public.User.create({
            email: `security-${randomUUID()}@example.com`,
            emailVerifiedAt: new Date().toISOString(),
        });
        userIds.add(user.id);
        return user.id;
    }

    function completedCheckout(userId: number) {
        return JSON.stringify({
            id: `evt_${randomUUID()}`,
            object: "event",
            type: "checkout.session.completed",
            data: {
                object: {
                    id: `cs_test_${randomUUID()}`,
                    object: "checkout.session",
                    mode: "payment",
                    payment_status: "paid",
                    client_reference_id: String(userId),
                    metadata: { plan: "lifetime" },
                    subscription: null,
                },
            },
        });
    }

    const deliver = (payload: string, headers: Record<string, string>) =>
        app.request("/api/billing/webhook", {
            method: "POST",
            headers: {
                "content-type": "application/json; charset=utf-8",
                origin: foreign,
                "sec-fetch-site": "cross-site",
                ...headers,
            },
            body: payload,
        });

    const licenseOf = async (id: number) =>
        (await db.orm.public.User.where({ id }).first())?.licensePlan;

    it("grants the license for a signed cross-origin event", async () => {
        const userId = await unlicensedUser();
        const payload = completedCheckout(userId);
        const signature = await stripe.webhooks.generateTestHeaderStringAsync({
            payload,
            secret,
        });

        const response = await deliver(payload, {
            "stripe-signature": signature,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ received: true });
        expect(await licenseOf(userId)).toBe("lifetime");
    });

    it("still requires a valid signature", async () => {
        const userId = await unlicensedUser();
        const payload = completedCheckout(userId);
        const signature = await stripe.webhooks.generateTestHeaderStringAsync({
            payload: completedCheckout(userId + 1),
            secret,
        });

        const attempts: Record<string, string>[] = [
            { "stripe-signature": signature },
            {},
            // form-like content type would trip csrf() if the route weren't exempt
            { "stripe-signature": signature, "content-type": "text/plain" },
        ];
        for (const headers of attempts) {
            const response = await deliver(payload, headers);
            expect(response.status).toBe(400);
            expect(await response.text()).toBe("Invalid signature");
        }
        expect(await licenseOf(userId)).toBeNull();
    });
});

describe("secure headers", () => {
    it.each(["/health", "/api/auth/me"])("are set on %s", async (path) => {
        const { headers } = await app.request(path);
        expect(headers.get("content-security-policy")).toBe(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
        );
        expect(headers.get("strict-transport-security")).toBeNull();
        expect(headers.get("x-content-type-options")).toBe("nosniff");
        expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
        expect(headers.get("referrer-policy")).toBe("no-referrer");
        expect(headers.get("cross-origin-opener-policy")).toBe("same-origin");
    });
});
