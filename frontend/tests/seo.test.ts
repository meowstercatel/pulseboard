import { describe, expect, it } from "vitest";
import { currency, plans } from "../src/lib/pricing";
import {
    disallowed,
    normalizePath,
    publicPage,
    publicPages,
    siteUrl,
    softwareApplication,
} from "../src/lib/seo";

describe("public pages", () => {
    it("link each language version to the others both ways", () => {
        for (const page of publicPages) {
            if (!page.alternates) continue;
            expect(page.alternates[page.lang]).toBe(page.path);
            for (const path of Object.values(page.alternates)) {
                expect(publicPage(path)?.alternates).toEqual(page.alternates);
            }
        }
    });

    it("are never blocked in robots.txt", () => {
        for (const page of publicPages) {
            for (const path of disallowed) {
                expect(page.path.startsWith(path)).toBe(false);
            }
        }
    });

    it("match however the static server is asked for them", () => {
        expect(publicPage("/terms/")?.path).toBe("/terms");
        expect(publicPage("/pl/terms/index.html")?.path).toBe("/pl/terms");
        expect(normalizePath("/index.html")).toBe("/");
        expect(publicPage("/login")).toBeUndefined();
        expect(publicPage("/buy")).toBeUndefined();
    });
});

describe("siteUrl", () => {
    it("keeps only the origin of PUBLIC_URL", () => {
        expect(siteUrl("https://pulseboard.example/")).toBe(
            "https://pulseboard.example",
        );
        expect(siteUrl(undefined)).toBe("http://localhost:4321");
        expect(siteUrl("")).toBe("http://localhost:4321");
    });
});

describe("softwareApplication", () => {
    const data = softwareApplication("https://pulseboard.example", "About.");

    it("offers every plan at its price from lib/pricing", () => {
        expect(data.offers).toHaveLength(plans.length);
        plans.forEach((plan, i) => {
            expect(data.offers[i]).toMatchObject({
                "@type": "Offer",
                name: plan.name,
                price: plan.amount.toFixed(2),
                priceCurrency: currency,
            });
        });
    });

    // schema.org wants ISO 4217, so a display form like "US$" would be invalid
    it("uses an ISO 4217 currency code", () => {
        expect(currency).toMatch(/^[A-Z]{3}$/);
    });

    it("bills the subscriptions by their period and lifetime once", () => {
        const periods = {
            subscription: "P1M",
            yearly: "P1Y",
            lifetime: undefined,
        };
        plans.forEach((plan, i) => {
            expect(data.offers[i]?.priceSpecification?.billingDuration).toBe(
                periods[plan.id],
            );
        });
    });
});
