import { describe, expect, it } from "vitest";
import { limits } from "../src/lib/limits";
import { planById, plans } from "../src/lib/pricing";

describe("pricing", () => {
    it("finds plans by id, whatever their order", () => {
        for (const plan of plans) expect(planById(plan.id)).toBe(plan);
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
