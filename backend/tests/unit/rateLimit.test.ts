import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { RateLimiter, limitByIp } from "../../src/auth/rateLimit.js";

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("RateLimiter", () => {
    it("blocks at the limit and opens exactly at the window boundary", () => {
        const limiter = new RateLimiter(2, 1000);
        limiter.hit("alice");
        expect(limiter.retryAfter("alice")).toBe(0);
        limiter.hit("alice");
        expect(limiter.retryAfter("alice")).toBe(1);
        vi.advanceTimersByTime(999);
        expect(limiter.retryAfter("alice")).toBe(1);
        vi.advanceTimersByTime(1);
        expect(limiter.retryAfter("alice")).toBe(0);
        limiter.hit("alice");
        expect(limiter.retryAfter("alice")).toBe(0);
    });

    it("isolates keys and resets only the requested key", () => {
        const limiter = new RateLimiter(1, 60_000);
        limiter.hit("alice");
        expect(limiter.retryAfter("bob")).toBe(0);
        limiter.hit("bob");
        limiter.reset("alice");
        expect(limiter.retryAfter("alice")).toBe(0);
        expect(limiter.retryAfter("bob")).toBe(60);
    });

    it("returns 429 and Retry-After through the middleware", async () => {
        vi.stubEnv("TRUST_PROXY", "true");
        const app = new Hono();
        app.get("/", limitByIp(new RateLimiter(1, 1500)), (c) => c.text("ok"));
        const request = () =>
            app.request("/", { headers: { "x-forwarded-for": "192.0.2.1" } });
        expect((await request()).status).toBe(200);
        const blocked = await request();
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get("Retry-After")).toBe("2");
        vi.advanceTimersByTime(1500);
        expect((await request()).status).toBe(200);
    });
});
