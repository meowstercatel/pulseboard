import { loginUrl } from "./auth";

export type Session = {
    id: string;
    current: boolean;
    userAgent: string | null;
    ip: string | null;
    createdAt: string;
    lastSeenAt: string | null;
    expiresAt: string;
};

type Result<T> = T | { error: string };

async function call<T>(
    path: string,
    init: RequestInit,
    read: (res: Response) => Promise<T>,
): Promise<Result<T>> {
    try {
        const res = await fetch(`/api/auth/sessions${path}`, init);
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

export function listSessions() {
    return call(
        "",
        {},
        async (res) => (await res.json()) as { sessions: Session[] },
    );
}

export function revokeSession(id: string) {
    return call(
        `/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        async () => ({ revoked: 1 }),
    );
}

export function revokeOtherSessions() {
    return call(
        "/revoke-others",
        { method: "POST" },
        async (res) => (await res.json()) as { revoked: number },
    );
}

const BROWSERS: [RegExp, string][] = [
    [/\bEdg(e|A|iOS)?\//, "Edge"],
    [/\b(OPR|Opera)\//, "Opera"],
    [/\bSamsungBrowser\//, "Samsung Internet"],
    [/\b(Firefox|FxiOS)\//, "Firefox"],
    [/\b(Chrome|CriOS|Chromium)\//, "Chrome"],
    [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
    [/\bWindows\b/, "Windows"],
    [/\bAndroid\b/, "Android"],
    [/\biPhone\b/, "iPhone"],
    [/\biPad\b/, "iPad"],
    [/\bCrOS\b/, "ChromeOS"],
    [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
    [/\bLinux\b/, "Linux"],
];

// "Firefox on Windows" from a user agent, or its first word for other clients
export function describeUserAgent(ua: string | null): string {
    if (!ua) return "Unknown device";
    const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
    const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
    if (browser && system) return `${browser} on ${system}`;
    if (browser || system) return (browser ?? system)!;
    return ua.split(" ")[0]!.slice(0, 40);
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 24 * 60 * 60 * 1000],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
];

// Activity is only recorded every few minutes, so recent times are approximate
export function formatLastSeen(iso: string | null, now = Date.now()): string {
    if (!iso) return "Not recorded";
    const ago = now - new Date(iso).getTime();
    if (ago < 5 * 60 * 1000) return "In the last few minutes";
    for (const [unit, ms] of UNITS) {
        if (ago >= ms) return relative.format(-Math.floor(ago / ms), unit);
    }
    return "In the last few minutes";
}

type Button = HTMLElement & { disabled: boolean };
type Notification = HTMLElement & { subtitle: string };

// Wires the settings page's sessions section; call load() to (re)fill the list.
// Text is only ever set with textContent: user agents are client input.
export function mountSessions(section: HTMLElement) {
    const list = section.querySelector<HTMLUListElement>("ul")!;
    const status = section.querySelector<HTMLElement>(".success")!;
    const error = section.querySelector<Notification>(
        "cds-inline-notification",
    )!;
    const revokeOthers = section.querySelector<Button>("#revoke-others")!;
    let busy = false;

    const showError = (message: string | null) => {
        error.hidden = !message;
        if (message) error.subtitle = message;
    };

    const render = (sessions: Session[]) => {
        list.replaceChildren(
            ...sessions.map((session) => {
                const item = document.createElement("li");
                const details = document.createElement("div");
                const name = document.createElement("p");
                name.className = "device";
                name.textContent = describeUserAgent(session.userAgent);
                if (session.userAgent) name.title = session.userAgent;
                if (session.current) {
                    const tag = document.createElement("cds-tag");
                    tag.setAttribute("type", "green");
                    tag.setAttribute("size", "sm");
                    tag.textContent = "This device";
                    name.append(" ", tag);
                }
                const meta = document.createElement("p");
                meta.className = "meta";
                const seen = session.current
                    ? "Active now"
                    : `Last active: ${formatLastSeen(session.lastSeenAt)}`;
                meta.textContent = `IP ${session.ip ?? "unknown"} · ${seen}`;
                details.append(name, meta);
                item.append(details);
                if (!session.current) {
                    const button = document.createElement(
                        "cds-button",
                    ) as Button;
                    button.setAttribute("kind", "ghost");
                    button.setAttribute("size", "sm");
                    // the host's aria-label doesn't reach Carbon's inner button
                    const which = document.createElement("span");
                    which.className = "visually-hidden";
                    which.textContent = ` ${name.firstChild!.textContent}, IP ${session.ip ?? "unknown"}`;
                    button.append("Sign out", which);
                    button.addEventListener("click", () =>
                        run(
                            button,
                            () => revokeSession(session.id),
                            "Signed out that device.",
                        ),
                    );
                    item.append(button);
                }
                return item;
            }),
        );
        revokeOthers.disabled = busy || !sessions.some((s) => !s.current);
    };

    const load = async () => {
        const result = await listSessions();
        if ("error" in result) {
            showError(result.error);
            return;
        }
        render(result.sessions);
    };

    async function run(
        button: Button,
        action: () => Promise<Result<unknown>>,
        done: string,
    ) {
        if (busy) return;
        busy = true;
        button.disabled = true;
        revokeOthers.disabled = true;
        status.textContent = "";
        showError(null);
        const result = await action();
        busy = false;
        button.disabled = false;
        if (result && typeof result === "object" && "error" in result) {
            showError(result.error as string);
        } else {
            status.textContent = done;
        }
        await load();
    }

    revokeOthers.addEventListener("click", () =>
        run(revokeOthers, revokeOtherSessions, "Signed out all other devices."),
    );
    return { load };
}
