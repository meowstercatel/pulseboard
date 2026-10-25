import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { checkPublicUrl, publicUrl } from "../../src/auth/publicUrl.js";

afterEach(() => {
    vi.unstubAllEnvs();
});

function linkFor(url: string) {
    const app = new Hono();
    app.get("/", (c) => c.text(publicUrl(c, "/verify-email?token=abc")));
    return app.request(url);
}

it.each([
    ["", "http://internal.test/verify-email?token=abc"],
    [
        "https://pulseboard.example",
        "https://pulseboard.example/verify-email?token=abc",
    ],
    [
        "https://pulseboard.example/",
        "https://pulseboard.example/verify-email?token=abc",
    ],
])("builds links with PUBLIC_URL=%s", async (origin, expected) => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PUBLIC_URL", origin);
    expect(await (await linkFor("http://internal.test/")).text()).toBe(
        expected,
    );
});

it("never falls back to the request host in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_URL", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await linkFor("http://evil.example/")).status).toBe(500);
});

it("refuses to start in production without a valid PUBLIC_URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_URL", "");
    expect(() => checkPublicUrl()).toThrow("PUBLIC_URL must be set");
    for (const value of [
        "pulseboard.example",
        "pulseboard.example:443",
        "localhost:3000",
        "ftp://pulseboard.example",
    ]) {
        vi.stubEnv("PUBLIC_URL", value);
        expect(() => checkPublicUrl()).toThrow("not a valid URL");
    }
    vi.stubEnv("PUBLIC_URL", "https://pulseboard.example/");
    expect(() => checkPublicUrl()).not.toThrow();
});

it("starts without PUBLIC_URL outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PUBLIC_URL", "");
    expect(() => checkPublicUrl()).not.toThrow();
});
