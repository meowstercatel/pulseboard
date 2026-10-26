import { describe, expect, it } from "vitest";
import { limits } from "../src/lib/limits";
import { planById, plans, price } from "../src/lib/pricing";

describe("pricing", () => {
    it("finds plans by id, whatever their order", () => {
        for (const plan of plans) expect(planById(plan.id)).toBe(plan);
    });

    // the Terms of Service and the Stripe prices (scripts/stripe-prices.mjs)
    // state the same amounts
    it("charges $5 a month, $50 a year or $99 once", () => {
        expect(plans.map((plan) => [plan.id, price(plan)])).toEqual([
            ["subscription", "$5"],
            ["yearly", "$50"],
            ["lifetime", "$99"],
        ]);
    });
});

describe("limits", () => {
    it("formats the backend limits for display", () => {
        expect(limits).toMatchObject({
            datasets: 5,
            fileSize: "25 MB",
            rows: "500,000",
            invalidShare: "5%",
        });
    });

    // samples/README.md: invalid-3-percent.csv imports, invalid-10-percent.csv doesn't
    it("judges the sample files like the backend does", () => {
        expect(limits.rejects(22, 672)).toBe(false);
        expect(limits.rejects(59, 672)).toBe(true);
    });
});
