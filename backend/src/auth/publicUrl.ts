import type { Context } from "hono";

// Set PUBLIC_URL when the request URL differs from the public one (e.g. behind
// a reverse proxy, or the Astro dev proxy).
export function publicUrl(c: Context, path: string): string {
    const base = process.env["PUBLIC_URL"] || new URL(c.req.url).origin;
    return `${base.replace(/\/$/, "")}${path}`;
}
