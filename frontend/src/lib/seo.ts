import { currency, plans } from "./pricing";

// The pages search engines may index, and the language versions of each. The
// sitemap lists exactly these; every other page is noindex (see HtmlTemplate).
// Paths have no trailing slash, like the links on the site.

export type PublicPage = {
    path: string;
    lang: "en" | "pl";
    // the same page in each language, including this one
    alternates?: Record<"en" | "pl", string>;
};

const terms = { en: "/terms", pl: "/pl/terms" };
const privacy = { en: "/privacy", pl: "/pl/privacy" };

export const publicPages: PublicPage[] = [
    { path: "/", lang: "en" },
    { path: "/samples", lang: "en" },
    { path: "/terms", lang: "en", alternates: terms },
    { path: "/pl/terms", lang: "pl", alternates: terms },
    { path: "/privacy", lang: "en", alternates: privacy },
    { path: "/pl/privacy", lang: "pl", alternates: privacy },
];

// "/terms/" and "/terms/index.html" are served too; they are the same page
export const normalizePath = (path: string) =>
    path.replace(/\/index\.html$/, "").replace(/\/+$/, "") || "/";

export const publicPage = (path: string) =>
    publicPages.find((page) => page.path === normalizePath(path));

// Pages for signed-in users and one-off links from emails. Crawlers are kept
// out of these in robots.txt; the ones linked from public pages (log in,
// register, pricing, forgot password) stay crawlable so the noindex on them
// is seen, as a URL blocked in robots.txt can still be indexed without it.
export const disallowed = [
    "/api/",
    "/overview",
    "/history",
    "/forecast",
    "/datasets",
    "/settings",
    "/buy/success",
    "/verify-email",
    "/reset-password",
];

// PUBLIC_URL is passed to the docker build, so canonical URLs, the sitemap and
// Open Graph links name the deployment they were built for. Local builds and
// tests fall back to the dev server.
export const siteUrl = (value: string | undefined) =>
    new URL(value || "http://localhost:4321").origin;

// schema.org description of the product for the landing page. Prices come from
// lib/pricing, so they change with the plans; currency must be an ISO 4217
// code there for this to stay valid.
export function softwareApplication(site: URL | string, description: string) {
    return {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "PulseBoard",
        description,
        url: new URL("/", site).href,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web browser",
        offers: plans.map((plan) => ({
            "@type": "Offer",
            name: plan.name,
            price: plan.amount.toFixed(2),
            priceCurrency: currency,
            url: new URL("/#pricing", site).href,
            ...(plan.id === "subscription" && {
                priceSpecification: {
                    "@type": "UnitPriceSpecification",
                    price: plan.amount.toFixed(2),
                    priceCurrency: currency,
                    billingDuration: "P1M",
                },
            }),
        })),
    };
}
