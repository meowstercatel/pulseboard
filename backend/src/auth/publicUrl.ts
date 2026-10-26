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
    if (value && !isHttpUrl(value)) {
        throw new Error(`PUBLIC_URL is not a valid URL: ${value}`);
    }
}

// URL.canParse alone accepts "pulseboard.example:443" (scheme "pulseboard.example:")
function isHttpUrl(value: string): boolean {
    if (!URL.canParse(value)) return false;
    const { protocol, host } = new URL(value);
    return (protocol === "https:" || protocol === "http:") && host !== "";
}

export function publicUrl(c: Context, path: string): string {
    const base = configuredPublicUrl() ?? new URL(c.req.url).origin;
    return `${base.replace(/\/$/, "")}${path}`;
}

// For mail sent outside a request, e.g. trial reminders. Local dev without
// PUBLIC_URL falls back to the server's own port.
export function appUrl(path: string): string {
    const base =
        configuredPublicUrl() ??
        `http://localhost:${process.env["PORT"] ?? 3000}`;
    return `${base.replace(/\/$/, "")}${path}`;
}
