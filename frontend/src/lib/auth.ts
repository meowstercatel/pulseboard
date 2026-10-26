export type User = {
    id: number;
    email: string;
    username: string | null;
    licensePlan: string | null;
    emailVerified: boolean;
};

// Pages that would send a logged-in user straight back out
const AUTH_PAGES = new Set(["/login", "/register"]);
const BASE = "http://pulseboard.invalid";
// The OAuth state cookie carries it, and cookies are capped at about 4 KB
const MAX_LENGTH = 1024;

// A ?next= value is followed only if it is a page on this site. Browsers treat
// "//host" and backslashes as another origin and drop tabs and newlines.
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

// The login page, set to come back to the current page afterwards
export function loginUrl(): string {
    const here = globalThis.location?.pathname;
    const next = here && safeNext(here + location.search);
    return next ? `/login?${new URLSearchParams({ next })}` : "/login";
}

export function accountDestination(user: User, next?: string | null): string {
    if (!user.emailVerified) return "/verify-email";
    // the page itself sends an unlicensed user on to /buy if it needs to
    const requested = safeNext(next);
    if (requested) return requested;
    return user.licensePlan ? "/overview" : "/buy";
}

type AuthResult = { user: User } | { error: string; status?: number };

async function post(path: string, body: unknown): Promise<AuthResult> {
    try {
        const res = await fetch(`/api/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.user) return { user: data.user };
        return {
            error: data?.error ?? `Something went wrong (${res.status})`,
            status: res.status,
        };
    } catch {
        return { error: "Can't reach the server" };
    }
}

export function login(email: string, password: string) {
    return post("auth/login", { email, password });
}

// Answers the same whether or not the email is taken; the link in the email
// that follows signs the new account in
export async function register(
    email: string,
    password: string,
    username: string,
): Promise<string | null> {
    try {
        const res = await fetch("/api/auth/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, password, username }),
        });
        if (res.ok) return null;
        const data = await res.json().catch(() => null);
        return data?.error ?? `Something went wrong (${res.status})`;
    } catch {
        return "Can't reach the server";
    }
}

export function verifyEmail(token: string) {
    return post("auth/verify-email", { token });
}

export async function resendVerificationEmail(): Promise<string | null> {
    try {
        const res = await fetch("/api/auth/verify-email/resend", {
            method: "POST",
        });
        if (res.ok) return null;
        if (res.status === 401) location.replace(loginUrl());
        const data = await res.json().catch(() => null);
        return data?.error ?? `Couldn't send the email (${res.status})`;
    } catch {
        return "Can't reach the server";
    }
}

export async function requestPasswordReset(
    email: string,
): Promise<string | null> {
    try {
        const res = await fetch("/api/auth/password-reset", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email }),
        });
        if (res.ok) return null;
        const data = await res.json().catch(() => null);
        return data?.error ?? `Couldn't send the email (${res.status})`;
    } catch {
        return "Can't reach the server";
    }
}

export function resetPassword(token: string, newPassword: string) {
    return post("auth/password-reset/confirm", { token, newPassword });
}

async function updateAccount(path: string, body: unknown): Promise<AuthResult> {
    const result = await post(path, body);
    if ("error" in result && result.status === 401) {
        location.replace(loginUrl());
    }
    return result;
}

export function updateProfile(
    username: string,
    email: string,
    currentPassword: string,
) {
    return updateAccount("auth/profile", { username, email, currentPassword });
}

export function changePassword(currentPassword: string, newPassword: string) {
    return updateAccount("auth/password", { currentPassword, newPassword });
}

export async function deleteAccount(
    confirmation: string,
    currentPassword: string,
): Promise<{ deleted: true } | { error: string }> {
    try {
        const res = await fetch("/api/auth/delete-account", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ confirmation, currentPassword }),
        });
        if (res.status === 204) return { deleted: true };
        if (res.status === 401) location.replace(loginUrl());
        const data = await res.json().catch(() => null);
        return {
            error: data?.error ?? `Couldn't delete account (${res.status})`,
        };
    } catch {
        return { error: "Can't reach the server" };
    }
}

export async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
}

export async function oauthProviders(): Promise<string[]> {
    try {
        const res = await fetch("/api/auth/oauth/providers");
        if (!res.ok) return [];
        return (await res.json()).providers;
    } catch {
        return [];
    }
}

export async function currentUser(): Promise<User | null> {
    try {
        const res = await fetch("/api/auth/me");
        if (!res.ok) return null;
        return (await res.json()).user;
    } catch {
        return null;
    }
}

// Protected pages start hidden (HtmlTemplate's requiresAuth) so they don't
// flash before a redirect; they are shown once the user may see them.
async function guard(
    redirect: (user: User) => string | null,
): Promise<User | null> {
    const user = await currentUser();
    const to = user ? redirect(user) : loginUrl();
    if (to) {
        location.replace(to);
        return null;
    }
    globalThis.document?.documentElement.removeAttribute("data-auth-pending");
    return user;
}

export function requireUser(): Promise<User | null> {
    return guard(() => null);
}

// Unverified users are sent to the page asking them to check their inbox
export function requireVerifiedUser(): Promise<User | null> {
    return guard((user) => (user.emailVerified ? null : "/verify-email"));
}

export function requireLicense(): Promise<User | null> {
    return guard((user) => {
        if (!user.emailVerified) return "/verify-email";
        return user.licensePlan ? null : "/buy";
    });
}
