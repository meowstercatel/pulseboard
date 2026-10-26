// Plans, prices and currency, shown on the landing page and on /buy. Checkout
// charges the Stripe prices in STRIPE_PRICE_SUBSCRIPTION/_YEARLY/_LIFETIME
// (created by scripts/stripe-prices.mjs), and the Terms of Service state the
// prices too, so change them together.

// "subscription" is the monthly plan
export type PlanId = "subscription" | "yearly" | "lifetime";

export type Plan = {
    id: PlanId;
    name: string;
    amount: number;
    period: string;
    note: string;
    features: string[];
};

export const currency = "USD";

// New accounts get this many days of full access, no card needed
export const trialDays = 14;

export const plans: Plan[] = [
    {
        id: "subscription",
        name: "Monthly",
        amount: 5,
        period: "/ month",
        note: "Renews monthly. Cancel anytime.",
        features: [
            "All PulseBoard features",
            "Ongoing updates",
            "Email support",
        ],
    },
    {
        id: "yearly",
        name: "Yearly",
        amount: 50,
        period: "/ year",
        note: "Renews yearly. Two months free compared with monthly.",
        features: [
            "All PulseBoard features",
            "Ongoing updates",
            "Email support",
        ],
    },
    {
        id: "lifetime",
        name: "Lifetime license",
        amount: 99,
        period: "one-time payment",
        note: "Pay once for lifetime access.",
        features: [
            "All PulseBoard features",
            "Lifetime updates",
            "Priority support",
        ],
    },
];

const format = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
});

// e.g. "$5"
export const price = (plan: Plan) => format.format(plan.amount);

export const planById = (id: PlanId): Plan => {
    const plan = plans.find((p) => p.id === id);
    if (!plan) throw new Error(`No plan ${id}`);
    return plan;
};
