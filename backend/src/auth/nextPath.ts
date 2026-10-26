// Pages that would send a logged-in user straight back out
const AUTH_PAGES = new Set(["/login", "/register"]);
const BASE = "http://pulseboard.invalid";
// The OAuth state cookie carries it, and cookies are capped at about 4 KB
const MAX_LENGTH = 1024;

// A ?next= value is followed only if it is a page on this site. Browsers treat
// "//host" and backslashes as another origin and drop tabs and newlines.
// Mirrors safeNext in frontend/src/lib/auth.ts.
export function safeNext(raw: string | null | undefined): string | null {
    if (!raw || raw.length > MAX_LENGTH) return null;
    if (!raw.startsWith("/") || raw.startsWith("//")) return null;
    if (/[\\\u0000-\u0020\u007f]/.test(raw)) return null;
    let url: URL;
    try {
        url = new URL(raw, BASE);
    } catch {
        return null;
    }
    if (url.origin !== BASE) return null;
    // the static server also answers /login/ and /login/index.html
    const page = url.pathname
        .toLowerCase()
        .replace(/\/index\.html$/, "")
        .replace(/\/+$/, "");
    if (AUTH_PAGES.has(page) || page === "/api" || page.startsWith("/api/")) {
        return null;
    }
    return url.pathname + url.search + url.hash;
}
