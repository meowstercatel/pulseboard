import { getConnInfo } from "@hono/node-server/conninfo";
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

// Behind a reverse proxy the socket address is the proxy's, so with
// TRUST_PROXY=true we take the address the proxy appended to X-Forwarded-For.
// Leave it unset when the server is reachable directly, or clients could spoof it.
export function clientIp(c: Context): string {
    if (process.env["TRUST_PROXY"] === "true") {
        const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1);
        if (forwarded?.trim()) return forwarded.trim();
    }
    return getConnInfo(c).remote.address ?? "unknown";
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
