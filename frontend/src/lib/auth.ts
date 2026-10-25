export type User = {
    id: number;
    email: string;
    username: string | null;
    licensePlan: string | null;
    emailVerified: boolean;
};

export function accountDestination(user: User): string {
    if (!user.emailVerified) return "/verify-email";
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

export function register(email: string, password: string, username: string) {
    return post("auth/register", { email, password, username });
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
        if (res.status === 401) location.replace("/login");
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
        location.replace("/login");
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
        if (res.status === 401) location.replace("/login");
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

export async function requireUser(): Promise<User | null> {
    const user = await currentUser();
    if (!user) location.replace("/login");
    return user;
}

// Unverified users are sent to the page asking them to check their inbox
export async function requireVerifiedUser(): Promise<User | null> {
    const user = await requireUser();
    if (user && !user.emailVerified) location.replace("/verify-email");
    return user?.emailVerified ? user : null;
}

export async function requireLicense(): Promise<User | null> {
    const user = await requireVerifiedUser();
    if (user && !user.licensePlan) location.replace("/buy");
    return user?.licensePlan ? user : null;
}
