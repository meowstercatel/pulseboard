import { expect, test, type APIRequestContext } from "./fixtures";
import { plans } from "../../frontend/src/lib/pricing";
import { disallowed, publicPages } from "../../frontend/src/lib/seo";

// Read as served, before any script runs: crawlers that don't execute
// JavaScript see the same, and protected pages would otherwise redirect.
async function head(request: APIRequestContext, path: string) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(path === "/no-such-page" ? 404 : 200);
    const html = await res.text();
    const tags = [...html.matchAll(/<(meta|link)\s([^>]*)>/g)].map(
        ([, tag, attrs]) => ({
            tag,
            ...Object.fromEntries(
                [...attrs!.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [
                    k,
                    v,
                ]),
            ),
        }),
    ) as Record<string, string>[];
    const meta = (key: string) =>
        tags.find(
            (t) => t["tag"] === "meta" && (t["name"] ?? t["property"]) === key,
        )?.["content"];
    const links = (rel: string) => tags.filter((t) => t["rel"] === rel);
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
    return { html, meta, links, title };
}

test("robots.txt keeps crawlers out of the app and points to the sitemap", async ({
    request,
}) => {
    const res = await request.get("/robots.txt");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/plain");
    const lines = (await res.text()).split("\n");
    expect(lines).toContain("User-agent: *");
    expect(lines).toContain("Disallow: /api/");
    for (const path of disallowed) expect(lines).toContain(`Disallow: ${path}`);
    const sitemap = lines.find((l) => l.startsWith("Sitemap: "))!.slice(9);
    expect(new URL(sitemap).pathname).toBe("/sitemap.xml");
});

test("the sitemap lists exactly the public pages", async ({ request }) => {
    const index = await request.get("/sitemap.xml");
    expect(index.status()).toBe(200);
    expect(index.headers()["content-type"]).toContain("xml");
    const [, chunk] = (await index.text()).match(/<loc>([^<]+)<\/loc>/)!;
    const sitemap = await request.get(new URL(chunk!).pathname);
    expect(sitemap.status()).toBe(200);
    const xml = await sitemap.text();
    const urls = [...xml.matchAll(/<url><loc>([^<]+)<\/loc>/g)].map(
        ([, loc]) => new URL(loc!).pathname,
    );
    expect(urls.sort()).toEqual(publicPages.map((p) => p.path).sort());
    // English and Polish legal pages name each other
    expect(xml).toMatch(
        /<loc>[^<]*\/pl\/terms<\/loc><xhtml:link rel="alternate" hreflang="en" href="[^"]*\/terms"\/>/,
    );
});

for (const page of publicPages) {
    test(`${page.path} has a title, description, canonical and share tags`, async ({
        request,
    }) => {
        const { meta, links, title } = await head(request, page.path);
        expect(title).toBeTruthy();
        expect(meta("description")).toBeTruthy();
        expect(meta("robots")).toBeUndefined();
        const canonical = links("canonical")[0]?.["href"];
        expect(new URL(canonical!).pathname).toBe(page.path);
        expect(meta("og:url")).toBe(canonical);
        expect(meta("og:title")).toBe(title);
        expect(meta("og:description")).toBe(meta("description"));
        expect(new URL(meta("og:image")!).pathname).toBe("/og.png");
        expect(meta("twitter:card")).toBe("summary_large_image");
        expect(meta("viewport")).toBe("width=device-width, initial-scale=1");

        const alternates = Object.fromEntries(
            links("alternate").map((l) => [
                l["hreflang"],
                new URL(l["href"]!).pathname,
            ]),
        );
        expect(alternates).toEqual(
            page.alternates
                ? { ...page.alternates, "x-default": page.alternates.en }
                : {},
        );
    });
}

test("the landing page describes the product with current prices", async ({
    request,
}) => {
    const { html } = await head(request, "/");
    const json = html.match(
        /<script type="application\/ld\+json">([^<]*)<\/script>/,
    )?.[1];
    const data = JSON.parse(json!);
    expect(data["@type"]).toBe("SoftwareApplication");
    expect(data.offers.map((o: { price: string }) => o.price)).toEqual(
        plans.map((p) => p.amount.toFixed(2)),
    );
});

const appPages = [
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password",
    "/verify-email",
    "/buy",
    "/buy/success",
    "/overview",
    "/history",
    "/forecast",
    "/datasets",
    "/settings",
    "/no-such-page",
];

for (const path of appPages) {
    test(`${path} is noindex and has no canonical`, async ({ request }) => {
        const { meta, links } = await head(request, path);
        expect(meta("robots")).toBe("noindex");
        expect(links("canonical")).toEqual([]);
    });
}

test("icons, manifest and share image are served", async ({ request }) => {
    const { links, meta } = await head(request, "/");
    expect(meta("theme-color")).toBe("#ffffff");
    expect(links("apple-touch-icon")[0]?.["href"]).toBe(
        "/apple-touch-icon.png",
    );
    expect(links("manifest")[0]?.["href"]).toBe("/site.webmanifest");

    const manifest = await request.get("/site.webmanifest");
    expect(manifest.headers()["content-type"]).toContain("manifest+json");
    const { icons } = await manifest.json();
    for (const icon of [{ src: "/apple-touch-icon.png" }, ...icons]) {
        const res = await request.get(icon.src);
        expect(res.headers()["content-type"], icon.src).toBe("image/png");
    }

    // the favicons are the same blue "P" as the icons above, not Astro's
    expect(links("icon").map((l) => l["href"])).toEqual([
        "/favicon.svg",
        "/favicon.ico",
    ]);
    const svg = await request.get("/favicon.svg");
    expect(svg.headers()["content-type"]).toContain("image/svg+xml");
    expect(await svg.text()).toContain('fill="#0f62fe"');
    const ico = await (await request.get("/favicon.ico")).body();
    // ICONDIR: reserved 0, type 1 (icon), then the number of images
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    expect(ico.readUInt16LE(4)).toBeGreaterThan(0);

    // PNG width and height are big-endian at bytes 16 and 20
    const png = await (await request.get("/og.png")).body();
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
});
