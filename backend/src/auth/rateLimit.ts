import { getConnInfo } from "@hono/node-server/conninfo";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import type { Context, MiddlewareHandler } from "hono";

type Window = { count: number; resetAt: number };

// Fixed-window counters kept in memory. Fine for the single server process we
// run; would need a shared store (e.g. Postgres/Redis) if we ever scale out.
export class RateLimiter {
    private windows = new Map<string, Window>();

    constructor(
        readonly limit: number,
        readonly windowMs: number,
    ) {
        setInterval(() => this.sweep(), 60_000).unref();
    }

    // Seconds until the key may try again, or 0 if it's under the limit.
    retryAfter(key: string): number {
        const w = this.windows.get(key);
        if (!w || w.resetAt <= Date.now() || w.count < this.limit) return 0;
        return Math.ceil((w.resetAt - Date.now()) / 1000);
    }

    hit(key: string) {
        const now = Date.now();
        const w = this.windows.get(key);
        if (!w || w.resetAt <= now) {
            this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
        } else {
            w.count++;
        }
    }

    // Takes back one hit, e.g. for an attempt counted up front that succeeded
    undo(key: string) {
        const w = this.windows.get(key);
        if (w && w.resetAt > Date.now() && w.count > 0) w.count--;
    }

    reset(key: string) {
        this.windows.delete(key);
    }

    private sweep() {
        const now = Date.now();
        for (const [key, w] of this.windows) {
            if (w.resetAt <= now) this.windows.delete(key);
        }
    }
}

// Where a reverse proxy can connect from: this host or the Docker network
const proxyNetworks = new BlockList();
proxyNetworks.addSubnet("127.0.0.0", 8, "ipv4");
proxyNetworks.addSubnet("10.0.0.0", 8, "ipv4");
proxyNetworks.addSubnet("172.16.0.0", 12, "ipv4");
proxyNetworks.addSubnet("192.168.0.0", 16, "ipv4");
proxyNetworks.addAddress("::1", "ipv6");
proxyNetworks.addSubnet("fc00::", 7, "ipv6");

export function isProxyAddress(address: string): boolean {
    const plain = unmapped(address);
    if (isIPv4(plain)) return proxyNetworks.check(plain, "ipv4");
    return isIPv6(plain) && proxyNetworks.check(plain, "ipv6");
}

// undefined for requests made in-process with app.request(), as in tests
function socketAddress(c: Context): string | undefined {
    try {
        return getConnInfo(c).remote.address;
    } catch {
        return undefined;
    }
}

// Behind a reverse proxy the socket address is the proxy's, so with
// TRUST_PROXY=true we take the address the proxy appended to X-Forwarded-For.
// The header only counts when the connection comes from a private or loopback
// address, where the proxy sits; a client reaching the published port directly
// can't spoof it. Leave TRUST_PROXY unset when there is no proxy.
export function clientIp(c: Context): string {
    const peer = socketAddress(c);
    if (
        process.env["TRUST_PROXY"] === "true" &&
        (peer === undefined || isProxyAddress(peer))
    ) {
        const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1);
        if (forwarded?.trim()) return unmapped(forwarded.trim());
    }
    return peer ? unmapped(peer) : "unknown";
}

// "::ffff:192.0.2.1", how a dual-stack socket reports IPv4, as "192.0.2.1"
function unmapped(address: string): string {
    const v4 = address.replace(/^::ffff:/i, "");
    return isIPv4(v4) ? v4 : address;
}

export function tooManyRequests(c: Context, retryAfter: number) {
    c.header("Retry-After", String(retryAfter));
    const minutes = Math.ceil(retryAfter / 60);
    return c.json(
        {
            error: `Too many attempts, try again in ${minutes} minute${minutes === 1 ? "" : "s"}`,
        },
        429,
    );
}

// Counts every request from a client IP, whatever its outcome.
export function limitByIp(limiter: RateLimiter): MiddlewareHandler {
    return async (c, next) => {
        const ip = clientIp(c);
        const retryAfter = limiter.retryAfter(ip);
        if (retryAfter) return tooManyRequests(c, retryAfter);
        limiter.hit(ip);
        await next();
    };
}
