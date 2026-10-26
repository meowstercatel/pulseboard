// Plans, prices and currency, shown on the landing page and on /buy. Checkout
// charges the Stripe prices in STRIPE_PRICE_SUBSCRIPTION/_LIFETIME, and the
// Terms of Service state the prices too, so change them together.

export type PlanId = "subscription" | "lifetime";

export type Plan = {
    id: PlanId;
    name: string;
    amount: number;
    period: string;
    note: string;
    features: string[];
};

export const currency = "PLN";

export const plans: Plan[] = [
    {
        id: "subscription",
        name: "Subscription",
        amount: 19,
        period: "/ month",
        note: "Renews monthly. Cancel anytime.",
        features: [
            "All PulseBoard features",
            "Ongoing updates",
            "Email support",
        ],
    },
    {
        id: "lifetime",
        name: "Lifetime license",
        amount: 199,
        period: "one-time payment",
        note: "Pay once for lifetime access.",
        features: [
            "All PulseBoard features",
            "Lifetime updates",
            "Priority support",
        ],
    },
];

export const price = (plan: Plan) => `${plan.amount} ${currency}`;
