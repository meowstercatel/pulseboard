import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { staticFiles } from "../../src/static.js";

const root = mkdtempSync(join(tmpdir(), "pulseboard-static-"));
mkdirSync(join(root, "_astro"));
writeFileSync(join(root, "index.html"), "<p>hi</p>");
writeFileSync(join(root, "index.html.br"), "br-bytes");
writeFileSync(join(root, "_astro", "app.abc123.js"), "console.log(1)");
writeFileSync(join(root, "_astro", "app.abc123.js.gz"), "gz-bytes");
const app = new Hono()
    .use("/*", staticFiles(root))
    .get("/api/ping", (c) => c.text("pong"));

it("caches hashed assets forever and revalidates HTML", async () => {
    const asset = await app.request("/_astro/app.abc123.js");
    expect(asset.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
    );
    const page = await app.request("/");
    expect(page.headers.get("cache-control")).toBe("no-cache");
});

it("serves the precompressed copy the client accepts", async () => {
    const br = await app.request("/", {
        headers: { "accept-encoding": "gzip, deflate, br" },
    });
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("content-type")).toMatch(/^text\/html/);
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    expect(await br.text()).toBe("br-bytes");

    const gz = await app.request("/_astro/app.abc123.js", {
        headers: { "accept-encoding": "gzip" },
    });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(await gz.text()).toBe("gz-bytes");

    const plain = await app.request("/");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe("<p>hi</p>");
});

it("leaves missing files to the next handler", async () => {
    expect((await app.request("/_astro/missing.js")).status).toBe(404);
    const api = await app.request("/api/ping");
    expect(await api.text()).toBe("pong");
    expect(api.headers.get("cache-control")).toBeNull();
});
