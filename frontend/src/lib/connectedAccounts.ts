import { loginUrl } from "./auth";

export type ConnectedAccount = {
    id: number;
    provider: string;
    // the provider account's address, shown so users can tell logins apart
    email: string | null;
    createdAt: string;
};

export type ConnectedAccounts = {
    hasPassword: boolean;
    accounts: ConnectedAccount[];
    // providers the server can connect
    providers: string[];
};

type Result<T> = T | { error: string };

export const PROVIDER_LABELS = new Map([
    ["google", "Google"],
    ["facebook", "Facebook"],
]);

const label = (provider: string) => PROVIDER_LABELS.get(provider) ?? provider;

async function call<T>(
    path: string,
    init: RequestInit,
    read: (res: Response) => Promise<T>,
): Promise<Result<T>> {
    try {
        const res = await fetch(`/api/auth/${path}`, init);
        if (res.status === 401) {
            location.replace(loginUrl());
            return { error: "Your session has ended" };
        }
        if (res.ok) return await read(res);
        const data = await res.json().catch(() => null);
        return { error: data?.error ?? `Something went wrong (${res.status})` };
    } catch {
        return { error: "Can't reach the server" };
    }
}

export function listConnectedAccounts() {
    return call(
        "connected-accounts",
        {},
        async (res) => (await res.json()) as ConnectedAccounts,
    );
}

// Answers with the provider's page to open; the server sends the browser
// back to /settings?linked= or ?link_error= when it is done
export function startLink(provider: string, currentPassword: string) {
    return call(
        `oauth/${encodeURIComponent(provider)}/link`,
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ currentPassword }),
        },
        async (res) => (await res.json()) as { url: string },
    );
}

export function unlink(id: number, currentPassword: string) {
    return call(
        `connected-accounts/${id}`,
        {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ currentPassword }),
        },
        async (res) => (await res.json()) as { revoked: number },
    );
}

export function requestPasswordSetup() {
    return call("password/setup", { method: "POST" }, async () => ({
        sent: true as const,
    }));
}

// Fixed messages, so a crafted link can't show its own text on the page
const LINK_ERRORS = new Map<string, (label: string) => string>([
    ["cancelled", (l) => `Connecting ${l} was cancelled`],
    ["expired", (l) => `Connecting ${l} expired, please try again`],
    ["failed", (l) => `Couldn't connect ${l}`],
    ["unverified", (l) => `Verify your email address before connecting ${l}`],
    [
        "linked_elsewhere",
        (l) =>
            `That ${l} account already logs in to another PulseBoard account. Disconnect it there first.`,
    ],
    [
        "provider_linked",
        (l) => `A ${l} account is already connected. Disconnect it first.`,
    ],
]);

// The outcome the OAuth callback put in the settings URL, if any
export function linkResult(
    params: URLSearchParams,
): { ok: boolean; message: string } | null {
    const linked = PROVIDER_LABELS.get(params.get("linked") ?? "");
    if (linked) return { ok: true, message: `${linked} account connected.` };
    if (!params.has("link_error")) return null;
    const message = LINK_ERRORS.get(params.get("link_error")!);
    const provider = PROVIDER_LABELS.get(params.get("provider") ?? "");
    return {
        ok: false,
        message:
            message && provider
                ? message(provider)
                : "Couldn't connect the account, please try again",
    };
}

// Whether disconnecting this login leaves another way to log in: a password,
// or a login with a provider the server still offers (the server checks too)
export function canUnlink(data: ConnectedAccounts, id: number): boolean {
    return (
        data.hasPassword ||
        data.accounts.some(
            (a) => a.id !== id && data.providers.includes(a.provider),
        )
    );
}

type Button = HTMLElement & { disabled: boolean };
type Input = HTMLElement & { value: string };
type Notification = HTMLElement & { subtitle: string };

// Wires the settings page's connected accounts section; call load() to
// (re)fill it. `onLoad` gets each loaded state, so the password section can
// offer to set a password. Provider emails are only set with textContent.
export function mountConnectedAccounts(
    section: HTMLElement,
    onLoad: (data: ConnectedAccounts) => void = () => {},
) {
    const list = section.querySelector<HTMLUListElement>("ul")!;
    const connect = section.querySelector<HTMLElement>(".connect")!;
    const buttons = section.querySelector<HTMLElement>(".connect-buttons")!;
    const password = section.querySelector<Input>('[name="currentPassword"]')!;
    const status = section.querySelector<HTMLElement>(".success")!;
    const error = section.querySelector<Notification>(
        "cds-inline-notification",
    )!;
    let busy = false;

    const showError = (message: string | null) => {
        error.hidden = !message;
        if (message) error.subtitle = message;
    };
    const showResult = (result: { ok: boolean; message: string }) => {
        status.textContent = result.ok ? result.message : "";
        showError(result.ok ? null : result.message);
    };

    const button = (text: string, hidden: string, kind: string) => {
        const element = document.createElement("cds-button") as Button;
        element.setAttribute("kind", kind);
        element.setAttribute("size", "sm");
        element.append(text);
        if (hidden) {
            // the host's aria-label doesn't reach Carbon's inner button
            const which = document.createElement("span");
            which.className = "visually-hidden";
            which.textContent = hidden;
            element.append(which);
        }
        return element;
    };

    const render = (data: ConnectedAccounts) => {
        list.replaceChildren(
            ...data.accounts.map((account) => {
                const item = document.createElement("li");
                const details = document.createElement("div");
                const name = document.createElement("p");
                name.className = "provider";
                name.textContent = label(account.provider);
                const meta = document.createElement("p");
                meta.className = "meta";
                meta.textContent = account.email ?? "No email address shared";
                details.append(name, meta);
                item.append(details);
                const allowed = canUnlink(data, account.id);
                const disconnect = button(
                    "Disconnect",
                    ` ${label(account.provider)}${account.email ? ` (${account.email})` : ""}`,
                    "ghost",
                );
                disconnect.disabled = busy || !allowed;
                if (!allowed) {
                    disconnect.title =
                        "Your only way to log in. Set a password or connect another account first.";
                }
                disconnect.addEventListener("click", () => {
                    if (needsPassword("disconnect", account.provider)) return;
                    run(
                        disconnect,
                        () => unlink(account.id, password.value),
                        `${label(account.provider)} disconnected. Other devices have been signed out.`,
                    );
                });
                item.append(disconnect);
                return item;
            }),
        );

        const linkable = data.providers.filter(
            (p) =>
                PROVIDER_LABELS.has(p) &&
                !data.accounts.some((a) => a.provider === p),
        );
        buttons.replaceChildren(
            ...linkable.map((provider) => {
                const element = button(
                    `Connect ${label(provider)}`,
                    "",
                    "tertiary",
                );
                element.disabled = busy;
                element.addEventListener("click", () =>
                    link(element, provider),
                );
                return element;
            }),
        );
        connect.hidden = !linkable.length;
        // connecting and disconnecting both ask for the password
        password.hidden =
            !data.hasPassword || (!linkable.length && !data.accounts.length);
        if (!data.hasPassword) password.value = "";
    };

    // Shows a hint and returns true if the password is needed but empty
    function needsPassword(action: string, provider: string): boolean {
        if (password.hidden || password.value) return false;
        showResult({
            ok: false,
            message: `Enter your current password to ${action} ${label(provider)}`,
        });
        return true;
    }

    async function link(element: Button, provider: string) {
        if (busy || needsPassword("connect", provider)) return;
        busy = true;
        element.disabled = true;
        showError(null);
        status.textContent = "";
        const result = await startLink(provider, password.value);
        if ("error" in result) {
            busy = false;
            element.disabled = false;
            showError(result.error);
            return;
        }
        location.assign(result.url);
    }

    // Only the latest request may render, so an older list that arrives late
    // can't bring back an account that was just disconnected
    let latest = 0;
    const load = async () => {
        const request = ++latest;
        const result = await listConnectedAccounts();
        if (request !== latest) return;
        if ("error" in result) {
            showError(result.error);
            return;
        }
        render(result);
        onLoad(result);
    };

    async function run(
        element: Button,
        action: () => Promise<Result<unknown>>,
        done: string,
    ) {
        if (busy) return;
        busy = true;
        element.disabled = true;
        status.textContent = "";
        showError(null);
        const result = await action();
        busy = false;
        element.disabled = false;
        if (result && typeof result === "object" && "error" in result) {
            showError(result.error as string);
        } else {
            status.textContent = done;
        }
        await load();
    }

    return { load, showResult };
}
