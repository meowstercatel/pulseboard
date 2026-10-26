import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
    RateLimiter,
    clientIp,
    isProxyAddress,
    limitByIp,
} from "../../src/auth/rateLimit.js";

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

    it("takes back a single hit within the window", () => {
        const limiter = new RateLimiter(2, 1000);
        limiter.hit("alice");
        limiter.hit("alice");
        limiter.undo("alice");
        expect(limiter.retryAfter("alice")).toBe(0);
        limiter.undo("alice");
        limiter.undo("alice");
        limiter.hit("alice");
        limiter.hit("alice");
        expect(limiter.retryAfter("alice")).toBe(1);
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

describe("clientIp", () => {
    const app = new Hono();
    app.get("/", (c) => c.text(clientIp(c)));
    // what @hono/node-server passes for a real connection
    const ipFor = async (peer: string | undefined, forwarded?: string) => {
        const env = peer
            ? { incoming: { socket: { remoteAddress: peer } } }
            : undefined;
        const headers: Record<string, string> = forwarded
            ? { "x-forwarded-for": forwarded }
            : {};
        return (await app.request("/", { headers }, env)).text();
    };

    it("ignores X-Forwarded-For without TRUST_PROXY", async () => {
        expect(await ipFor("127.0.0.1", "198.51.100.7")).toBe("127.0.0.1");
    });

    it("takes the address the proxy appended", async () => {
        vi.stubEnv("TRUST_PROXY", "true");
        for (const proxy of [
            "127.0.0.1",
            "::1",
            "172.18.0.1",
            "::ffff:172.18.0.1",
            "10.1.2.3",
            "192.168.1.10",
            "fd00::1",
        ]) {
            expect(await ipFor(proxy, "6.6.6.6, 198.51.100.7")).toBe(
                "198.51.100.7",
            );
        }
        expect(await ipFor("172.18.0.1")).toBe("172.18.0.1");
        expect(await ipFor("172.18.0.1", " ")).toBe("172.18.0.1");
    });

    it("ignores X-Forwarded-For from clients that bypass the proxy", async () => {
        vi.stubEnv("TRUST_PROXY", "true");
        expect(await ipFor("203.0.113.9", "198.51.100.7")).toBe("203.0.113.9");
        expect(await ipFor("2001:db8::1", "198.51.100.7")).toBe("2001:db8::1");
        expect(await ipFor("::ffff:203.0.113.9", "198.51.100.7")).toBe(
            "203.0.113.9",
        );
    });

    it("ignores X-Forwarded-For when a closed socket has no address", async () => {
        vi.stubEnv("TRUST_PROXY", "true");
        const response = await app.request(
            "/",
            { headers: { "x-forwarded-for": "198.51.100.7" } },
            { incoming: { socket: {} } },
        );
        expect(await response.text()).toBe("unknown");
    });

    it("recognizes only loopback and private networks as proxies", () => {
        expect(isProxyAddress("172.16.0.1")).toBe(true);
        expect(isProxyAddress("172.31.255.255")).toBe(true);
        expect(isProxyAddress("172.32.0.1")).toBe(false);
        expect(isProxyAddress("192.169.0.1")).toBe(false);
        expect(isProxyAddress("fe80::1")).toBe(false);
        expect(isProxyAddress("not an address")).toBe(false);
    });
});
