#!/usr/bin/env node
// Sets up PulseBoard's USD prices and Customer Portal plan switching in Stripe.
// Safe to run again: it reuses what already matches and only adds what's
// missing. Prices can't be edited in Stripe, so a changed amount becomes a new
// price that takes over the lookup key; the old one stays active, so existing
// subscribers keep paying what they signed up for.
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-prices.mjs
//
// Refuses live keys unless --live is passed. Prints the GitHub variables to set.
import { createRequire } from "node:module";

// the Stripe SDK is a backend dependency
const require = createRequire(
    new URL("../backend/package.json", import.meta.url),
);
const Stripe = require("stripe");

const PRODUCTS = {
    subscription: {
        id: "pulseboard_subscription",
        name: "PulseBoard subscription",
        description: "All PulseBoard features, billed monthly or yearly.",
    },
    lifetime: {
        id: "pulseboard_lifetime",
        name: "PulseBoard lifetime license",
        description: "All PulseBoard features for a one-time payment.",
    },
};

// Keep in sync with frontend/src/lib/pricing.ts and the Terms of Service.
// Amounts are in cents and include any taxes due.
const PRICES = [
    {
        variable: "STRIPE_PRICE_SUBSCRIPTION",
        lookupKey: "pulseboard_monthly_usd",
        product: PRODUCTS.subscription.id,
        nickname: "Monthly (USD)",
        unitAmount: 500,
        interval: "month",
    },
    {
        variable: "STRIPE_PRICE_YEARLY",
        lookupKey: "pulseboard_yearly_usd",
        product: PRODUCTS.subscription.id,
        nickname: "Yearly (USD)",
        unitAmount: 5000,
        interval: "year",
    },
    {
        variable: "STRIPE_PRICE_LIFETIME",
        lookupKey: "pulseboard_lifetime_usd",
        product: PRODUCTS.lifetime.id,
        nickname: "Lifetime (USD)",
        unitAmount: 9900,
        interval: null,
    },
];
const CURRENCY = "usd";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
    console.error(
        "Set STRIPE_SECRET_KEY to the sandbox secret key (sk_test_...)",
    );
    process.exit(1);
}
if (!/^(sk|rk)_test_/.test(key) && !process.argv.includes("--live")) {
    console.error("That isn't a test key. Pass --live to change live mode.");
    process.exit(1);
}
const stripe = new Stripe(key);

async function ensureProduct({ id, name, description }) {
    try {
        const product = await stripe.products.retrieve(id);
        if (!product.active) {
            await stripe.products.update(id, { active: true });
        }
        console.log(`Product ${id}: exists`);
    } catch (err) {
        if (err?.statusCode !== 404) throw err;
        await stripe.products.create({ id, name, description });
        console.log(`Product ${id}: created`);
    }
}

function matches(price, want) {
    return (
        price.active &&
        price.currency === CURRENCY &&
        price.unit_amount === want.unitAmount &&
        price.product === want.product &&
        price.tax_behavior === "inclusive" &&
        (price.recurring?.interval ?? null) === want.interval &&
        (want.interval === null || price.recurring?.interval_count === 1)
    );
}

async function ensurePrice(want) {
    const { data } = await stripe.prices.list({
        lookup_keys: [want.lookupKey],
        limit: 1,
    });
    const current = data[0];
    if (current && matches(current, want)) {
        console.log(`Price ${want.lookupKey}: ${current.id} exists`);
        return current.id;
    }
    const price = await stripe.prices.create({
        product: want.product,
        currency: CURRENCY,
        unit_amount: want.unitAmount,
        tax_behavior: "inclusive",
        nickname: want.nickname,
        lookup_key: want.lookupKey,
        // moves the key off a price with an old amount, which stays active
        transfer_lookup_key: true,
        ...(want.interval ? { recurring: { interval: want.interval } } : {}),
    });
    console.log(`Price ${want.lookupKey}: ${price.id} created`);
    return price.id;
}

// The portal session in backend/src/routes/billing.ts uses the default
// configuration, so that is the one that gets plan switching.
async function allowPlanSwitching(monthly, yearly) {
    const features = {
        subscription_update: {
            enabled: true,
            default_allowed_updates: ["price"],
            products: [
                {
                    product: PRODUCTS.subscription.id,
                    prices: [monthly, yearly],
                },
            ],
            // monthly -> yearly is charged right away, minus the unused month
            proration_behavior: "always_invoice",
            // yearly -> monthly waits for the paid year to end
            schedule_at_period_end: {
                conditions: [{ type: "shortening_interval" }],
            },
        },
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
    };
    const { data } = await stripe.billingPortal.configurations.list({
        is_default: true,
        active: true,
        limit: 1,
    });
    if (data[0]) {
        await stripe.billingPortal.configurations.update(data[0].id, {
            features,
        });
        console.log(`Customer Portal ${data[0].id} (default): updated`);
        return;
    }
    console.error(
        "No default Customer Portal configuration. Save the portal settings once in the Stripe Dashboard (Settings > Billing > Customer portal), then run this again.",
    );
    process.exitCode = 1;
}

// Payment methods that only take PLN drop out of a USD Checkout. This
// opens (and then expires) a throwaway session to check cards are still offered.
async function checkCards(lifetimePrice) {
    const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: lifetimePrice, quantity: 1 }],
        success_url: "https://example.com/success",
    });
    await stripe.checkout.sessions.expire(session.id);
    const methods = session.payment_method_types;
    console.log(`Checkout payment methods in USD: ${methods.join(", ")}`);
    if (!methods.includes("card")) {
        console.error(
            "Cards aren't offered in a USD Checkout. Check Settings > Payments > Payment methods in the Stripe Dashboard.",
        );
        process.exitCode = 1;
    }
}

for (const product of Object.values(PRODUCTS)) await ensureProduct(product);
const ids = {};
for (const price of PRICES) ids[price.variable] = await ensurePrice(price);
await allowPlanSwitching(
    ids.STRIPE_PRICE_SUBSCRIPTION,
    ids.STRIPE_PRICE_YEARLY,
);
await checkCards(ids.STRIPE_PRICE_LIFETIME);

console.log("\nGitHub variables (production and staging share the sandbox):");
for (const env of ["production", "staging"]) {
    for (const [name, id] of Object.entries(ids)) {
        console.log(`gh variable set ${name} --env ${env} --body ${id}`);
    }
}
