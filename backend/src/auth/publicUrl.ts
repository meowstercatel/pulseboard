import type { Context } from "hono";

// The Host header is attacker-controlled, so production builds every link from
// PUBLIC_URL. Elsewhere (local dev, tests) the request origin is good enough.
function configuredPublicUrl(): string | undefined {
    const value = process.env["PUBLIC_URL"];
    if (value) return value;
    if (process.env["NODE_ENV"] === "production") {
        throw new Error("PUBLIC_URL must be set in production");
    }
    return undefined;
}

// Called once at startup so a missing or malformed PUBLIC_URL stops the deploy
export function checkPublicUrl() {
    const value = configuredPublicUrl();
    if (value && !URL.canParse(value)) {
        throw new Error(`PUBLIC_URL is not a valid URL: ${value}`);
    }
}

export function publicUrl(c: Context, path: string): string {
    const base = configuredPublicUrl() ?? new URL(c.req.url).origin;
    return `${base.replace(/\/$/, "")}${path}`;
}
