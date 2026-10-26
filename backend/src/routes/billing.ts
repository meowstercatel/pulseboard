import { Hono } from "hono";
import Stripe from "stripe";
import { requireVerifiedEmail } from "../auth/emailVerification.js";
import { publicUrl } from "../auth/publicUrl.js";
import { requireAuth, type AuthEnv, type AuthUser } from "../auth/session.js";
import { db } from "../prisma/db.js";

// "subscription" is the monthly plan; it and "yearly" are both Stripe
// subscriptions, stored as licensePlan "subscription"
const PLANS = ["subscription", "yearly", "lifetime"] as const;
type Plan = (typeof PLANS)[number];

const PRICE_ENV: Record<Plan, string> = {
    subscription: "STRIPE_PRICE_SUBSCRIPTION",
    yearly: "STRIPE_PRICE_YEARLY",
    lifetime: "STRIPE_PRICE_LIFETIME",
};

function isPlan(value: unknown): value is Plan {
    return PLANS.includes(value as Plan);
}

// Statuses that still give access. past_due keeps it while Stripe retries the card.
const LIVE_STATUSES: Stripe.Subscription.Status[] = [
    "active",
    "trialing",
    "past_due",
];

// Test keys (sk_test_...) and live keys (sk_live_...) go through the same code,
// the key alone decides which Stripe mode is used.
const stripeKey = process.env["STRIPE_SECRET_KEY"];
const stripe = stripeKey ? new Stripe(stripeKey) : null;

function priceFor(plan: Plan): string | undefined {
    return process.env[PRICE_ENV[plan]] || undefined;
}

function idOf(ref: string | { id: string } | null): string | null {
    return typeof ref === "string" ? ref : (ref?.id ?? null);
}

async function getOrCreateCustomer(
    stripe: Stripe,
    user: AuthUser,
): Promise<string> {
    const row = await db.orm.public.User.where({ id: user.id })
        .select("stripeCustomerId")
        .first();
    if (row?.stripeCustomerId) {
        // Stripe emails receipts to the customer's address, which may be one
        // the account has since changed away from
        await stripe.customers.update(row.stripeCustomerId, {
            email: user.email,
        });
        return row.stripeCustomerId;
    }

    // the idempotency key stops a double click from creating two customers
    const customer = await stripe.customers.create(
        { email: user.email, metadata: { userId: String(user.id) } },
        { idempotencyKey: `customer-${user.id}` },
    );
    await db.orm.public.User.where({ id: user.id }).update({
        stripeCustomerId: customer.id,
    });
    return customer.id;
}

// Copies a subscription's current state onto its user. Always re-fetched from
// Stripe, so webhook events arriving out of order can't leave stale data behind.
async function syncSubscription(stripe: Stripe, subscriptionId: string) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const customerId = idOf(sub.customer);
    if (!customerId) return;

    const user = await db.orm.public.User.where({
        stripeCustomerId: customerId,
    }).first();
    if (!user || user.licensePlan === "lifetime") return;

    const live = LIVE_STATUSES.includes(sub.status);
    // an old, ended subscription must not revoke access granted by a newer one
    if (
        !live &&
        user.stripeSubscriptionId &&
        user.stripeSubscriptionId !== sub.id
    ) {
        return;
    }

    await db.orm.public.User.where({ id: user.id }).update({
        stripeSubscriptionId: sub.id,
        subscriptionStatus: sub.status,
        licensePlan: live ? "subscription" : null,
        licensedAt: live
            ? (user.licensedAt ?? new Date().toISOString())
            : user.licensedAt,
    });
}

// Grants whatever a completed Checkout Session paid for. Called from the webhook
// and from /confirm, so it must be safe to run more than once.
async function fulfillCheckout(
    stripe: Stripe,
    session: Stripe.Checkout.Session,
) {
    if (session.payment_status === "unpaid") return; // e.g. a delayed payment method still processing

    const subscriptionId = idOf(session.subscription);
    if (session.mode === "subscription" && subscriptionId) {
        await syncSubscription(stripe, subscriptionId);
        return;
    }

    if (
        session.mode !== "payment" ||
        session.metadata?.["plan"] !== "lifetime"
    ) {
        return;
    }
    const userId = Number(session.client_reference_id);
    const user = await db.orm.public.User.where({ id: userId }).first();
    // /checkout always sets both; a session made any other way (e.g. a Payment
    // Link, whose URL can carry any client_reference_id) grants nothing
    if (
        !user ||
        user.licensePlan === "lifetime" ||
        !user.stripeCustomerId ||
        idOf(session.customer) !== user.stripeCustomerId
    ) {
        return;
    }

    await db.orm.public.User.where({ id: userId }).update({
        licensePlan: "lifetime",
        licensedAt: new Date().toISOString(),
    });

    // upgrading from a subscription: stop charging for it
    if (
        user.stripeSubscriptionId &&
        user.subscriptionStatus &&
        LIVE_STATUSES.includes(user.subscriptionStatus)
    ) {
        await stripe.subscriptions.cancel(user.stripeSubscriptionId);
    }
}

// Used when an account is deleted, so Stripe stops charging a user who no longer exists
export async function cancelSubscriptionOf(user: {
    stripeSubscriptionId: string | null;
    subscriptionStatus: string | null;
}) {
    if (
        !stripe ||
        !user.stripeSubscriptionId ||
        !user.subscriptionStatus ||
        !LIVE_STATUSES.includes(user.subscriptionStatus)
    ) {
        return;
    }
    await stripe.subscriptions.cancel(user.stripeSubscriptionId);
}

export const billing = new Hono<AuthEnv>();

billing.post("/checkout", requireAuth, requireVerifiedEmail, async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
        plan?: unknown;
        withdrawalWaiver?: unknown;
    } | null;
    const plan = body?.plan;
    if (!isPlan(plan)) return c.json({ error: "Unknown plan" }, 400);
    // Polish consumer law: digital content may only be delivered right away once the
    // buyer agrees to it and acknowledges losing the 14-day right of withdrawal
    if (body?.withdrawalWaiver !== true) {
        return c.json(
            {
                error: "You must agree to immediate delivery and waive the right of withdrawal",
            },
            400,
        );
    }

    const price = priceFor(plan);
    if (!stripe || !price) {
        return c.json({ error: "Payments are not configured" }, 503);
    }

    const user = c.get("user");
    if (user.licensePlan === "lifetime") {
        return c.json({ error: "You already have a lifetime license" }, 409);
    }
    // switching between monthly and yearly happens in the Customer Portal,
    // so a second subscription is never started
    if (plan !== "lifetime" && user.licensePlan === "subscription") {
        return c.json(
            {
                error: "You already have an active subscription. Switch between monthly and yearly with Manage subscription",
            },
            409,
        );
    }

    const withdrawalWaiverAt = new Date().toISOString();
    await db.orm.public.User.where({ id: user.id }).update({
        withdrawalWaiverAt,
    });

    const customer = await getOrCreateCustomer(stripe, user);
    const mode = plan === "lifetime" ? "payment" : "subscription";
    const session = await stripe.checkout.sessions.create({
        mode,
        customer,
        line_items: [{ price, quantity: 1 }],
        client_reference_id: String(user.id),
        metadata: { userId: String(user.id), plan, withdrawalWaiverAt },
        // Stripe's receipt for the one-off payment; subscription payments get
        // theirs from the account's "Successful payments" email setting
        ...(mode === "payment"
            ? { payment_intent_data: { receipt_email: user.email } }
            : {}),
        locale: "en",
        success_url: publicUrl(
            c,
            "/buy/success?session_id={CHECKOUT_SESSION_ID}",
        ),
        cancel_url: publicUrl(c, "/buy"),
    });
    if (!session.url) return c.json({ error: "Could not start checkout" }, 502);
    return c.json({ url: session.url });
});

// The success page calls this so the license shows up right away, even before
// (or without, in local dev) the webhook arriving. The webhook stays the source of truth.
billing.post("/confirm", requireAuth, async (c) => {
    if (!stripe) return c.json({ error: "Payments are not configured" }, 503);

    const body: unknown = await c.req.json().catch(() => null);
    const sessionId = (body as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId !== "string" || !sessionId.startsWith("cs_")) {
        return c.json({ error: "Invalid session" }, 400);
    }

    const session = await stripe.checkout.sessions
        .retrieve(sessionId)
        .catch(() => null);
    const user = c.get("user");
    if (!session || session.client_reference_id !== String(user.id)) {
        return c.json({ error: "Invalid session" }, 400);
    }

    await fulfillCheckout(stripe, session);
    return c.json({ paymentStatus: session.payment_status });
});

// Stripe's hosted page where subscribers cancel, change their card or switch
// between monthly and yearly (allowed in the portal configuration, see
// scripts/stripe-prices.mjs)
billing.post("/portal", requireAuth, async (c) => {
    if (!stripe) return c.json({ error: "Payments are not configured" }, 503);

    const row = await db.orm.public.User.where({ id: c.get("user").id })
        .select("stripeCustomerId")
        .first();
    if (!row?.stripeCustomerId) {
        return c.json({ error: "No billing account yet" }, 404);
    }

    const portal = await stripe.billingPortal.sessions.create({
        customer: row.stripeCustomerId,
        locale: "en",
        return_url: publicUrl(c, "/buy"),
    });
    return c.json({ url: portal.url });
});

// Not behind requireAuth: Stripe calls this, and the signature proves it.
billing.post("/webhook", async (c) => {
    const secret = process.env["STRIPE_WEBHOOK_SECRET"];
    if (!stripe || !secret) return c.text("Payments are not configured", 503);

    // the signature covers the exact bytes, so read the raw body, not JSON
    const raw = await c.req.text();
    let event: Stripe.Event;
    try {
        event = await stripe.webhooks.constructEventAsync(
            raw,
            c.req.header("stripe-signature") ?? "",
            secret,
        );
    } catch {
        return c.text("Invalid signature", 400);
    }

    switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
            await fulfillCheckout(stripe, event.data.object);
            break;
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
        case "customer.subscription.paused":
        case "customer.subscription.resumed":
            await syncSubscription(stripe, event.data.object.id);
            break;
    }
    // a thrown error above returns 500, and Stripe retries the event later
    return c.json({ received: true });
});
