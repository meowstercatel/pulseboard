import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { db } from "../../src/prisma/db.js";

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});
afterAll(async () => {
    await db.close();
});

it("answers unknown API paths with JSON", async () => {
    const response = await createApp().request("/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
});

it("no longer greets with Hello Hono", async () => {
    const response = await createApp().request("/");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Hello Hono");
});

it("serves the built 404 page for unknown pages", async () => {
    const root = mkdtempSync(join(tmpdir(), "pulseboard-404-"));
    writeFileSync(join(root, "index.html"), "<p>home</p>");
    writeFileSync(join(root, "404.html"), "<h2>Page not found</h2>");
    vi.stubEnv("STATIC_DIR", root);
    const app = createApp();
    const missing = await app.request("/no-such-page");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await missing.text()).toBe("<h2>Page not found</h2>");
    expect(
        (await app.request("/api/nope")).headers.get("content-type"),
    ).toMatch(/^application\/json/);
    expect(await (await app.request("/")).text()).toBe("<p>home</p>");
});

it("logs unexpected errors and hides the details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp();
    app.get("/api/boom", () => {
        throw new Error("database password is hunter2");
    });
    app.get("/boom", () => {
        throw new Error("database password is hunter2");
    });

    const api = await app.request("/api/boom");
    expect(api.status).toBe(500);
    expect(await api.json()).toEqual({
        error: "Something went wrong. Try again later",
    });
    const page = await app.request("/boom");
    expect(page.status).toBe(500);
    expect(await page.text()).not.toContain("hunter2");
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[0]?.[0])).toContain("GET /api/boom");
});
