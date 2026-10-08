export type User = {
    id: number;
    email: string;
    username: string | null;
    licensePlan: string | null;
};

type AuthResult = { user: User } | { error: string };

async function post(path: string, body: unknown): Promise<AuthResult> {
    try {
        const res = await fetch(`/api/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.user) return { user: data.user };
        return { error: data?.error ?? `Something went wrong (${res.status})` };
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

export function purchase(plan: "subscription" | "lifetime") {
    return post("billing/purchase", { plan });
}

export async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
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
    if (!user) location.replace("/");
    return user;
}

export async function requireLicense(): Promise<User | null> {
    const user = await requireUser();
    if (user && !user.licensePlan) location.replace("/buy");
    return user?.licensePlan ? user : null;
}
