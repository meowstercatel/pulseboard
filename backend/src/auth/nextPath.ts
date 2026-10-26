// Pages that would send a logged-in user straight back out
const AUTH_PAGES = new Set(["/login", "/register"]);
const BASE = "http://pulseboard.invalid";

// A ?next= value is followed only if it is a path on this site. Browsers treat
// "//host" and backslashes as another origin and drop tabs and newlines.
// Mirrors safeNext in frontend/src/lib/auth.ts.
export function safeNext(raw: string | null | undefined): string | null {
    if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
    if (/[\\\u0000-\u0020\u007f]/.test(raw)) return null;
    let url: URL;
    try {
        url = new URL(raw, BASE);
    } catch {
        return null;
    }
    if (url.origin !== BASE || AUTH_PAGES.has(url.pathname)) return null;
    return url.pathname + url.search + url.hash;
}
