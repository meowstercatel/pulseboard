import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { publicUrl } from "../../src/auth/publicUrl.js";

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
    vi.stubEnv("PUBLIC_URL", origin);
    const app = new Hono();
    app.get("/", (c) => c.text(publicUrl(c, "/verify-email?token=abc")));
    expect(await (await app.request("http://internal.test/")).text()).toBe(
        expected,
    );
});
