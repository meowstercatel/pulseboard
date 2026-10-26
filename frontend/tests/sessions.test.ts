import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    describeUserAgent,
    formatLastSeen,
    mountSessions,
    type Session,
} from "../src/lib/sessions";

const CHROME_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

it.each([
    [CHROME_MAC, "Chrome on macOS"],
    [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
        "Firefox on Windows",
    ],
    [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
        "Edge on Windows",
    ],
    [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
        "Safari on iPhone",
    ],
    [
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
        "Chrome on Android",
    ],
    [
        "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
        "Firefox on Linux",
    ],
    ["curl/8.7.1", "curl/8.7.1"],
    [null, "Unknown device"],
])("describes %j as %s", (ua, expected) => {
    expect(describeUserAgent(ua)).toBe(expected);
});

it.each([
    [null, "Not recorded"],
    [60 * 1000, "In the last few minutes"],
    [20 * 60 * 1000, "20 minutes ago"],
    [3 * 60 * 60 * 1000, "3 hours ago"],
    [36 * 60 * 60 * 1000, "yesterday"],
    [10 * 24 * 60 * 60 * 1000, "10 days ago"],
])("formats last seen %s ms ago", (ago, expected) => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    const iso = ago === null ? null : new Date(now - ago).toISOString();
    expect(formatLastSeen(iso, now)).toBe(expected);
});

describe("mountSessions", () => {
    let window: Window;
    let section: HTMLElement;

    const session = (overrides: Partial<Session>): Session => ({
        id: "a".repeat(64),
        current: false,
        userAgent: CHROME_MAC,
        ip: "192.0.2.1",
        createdAt: "2026-10-01T00:00:00Z",
        lastSeenAt: new Date().toISOString(),
        expiresAt: "2026-11-25T00:00:00Z",
        ...overrides,
    });
    const current = session({ id: "c".repeat(64), current: true });
    const other = session({
        id: "b".repeat(64),
        userAgent: '<img src=x onerror="alert(1)">',
        ip: "198.51.100.4",
    });

    beforeEach(() => {
        window = new Window({ url: "http://localhost/settings" });
        const doc = window.document as unknown as Document;
        vi.stubGlobal("document", doc);
        vi.stubGlobal("location", window.location);
        doc.body.innerHTML = `
            <section id="sessions">
                <ul></ul>
                <cds-inline-notification role="status" hidden></cds-inline-notification>
                <p class="success" role="status"></p>
                <cds-button id="revoke-others" disabled>Log out everywhere else</cds-button>
            </section>`;
        section = doc.getElementById("sessions")!;
    });
    afterEach(async () => {
        await window.happyDOM.close();
    });

    const items = () => [...section.querySelectorAll("li")];
    const revokeOthers = () =>
        section.querySelector("#revoke-others") as HTMLElement & {
            disabled: boolean;
        };
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it("lists sessions, marks this device and shows user agents as text", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue(
                    Response.json({ sessions: [current, other] }),
                ),
        );
        await mountSessions(section).load();

        const [mine, theirs] = items();
        expect(mine!.textContent).toContain("Chrome on macOS");
        expect(mine!.textContent).toContain("This device");
        expect(mine!.textContent).toContain("Active now");
        expect(mine!.querySelector("cds-button")).toBeNull();
        expect(theirs!.querySelector("img")).toBeNull();
        expect(theirs!.textContent).toContain("<img");
        expect(theirs!.textContent).toContain("IP 198.51.100.4");
        expect(theirs!.textContent).toContain("In the last few minutes");
        // the device is named for screen readers inside the button
        expect(theirs!.querySelector("cds-button")!.textContent).toBe(
            "Sign out <img, IP 198.51.100.4",
        );
        expect(revokeOthers().disabled).toBe(false);
    });

    it("disables 'log out everywhere else' when there is nothing else", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(Response.json({ sessions: [current] })),
        );
        await mountSessions(section).load();
        expect(items()).toHaveLength(1);
        expect(revokeOthers().disabled).toBe(true);
    });

    it("signs out one device and reloads the list", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                Response.json({ sessions: [current, other] }),
            )
            .mockResolvedValueOnce(new Response(null, { status: 204 }))
            .mockResolvedValueOnce(Response.json({ sessions: [current] }));
        vi.stubGlobal("fetch", fetch);
        await mountSessions(section).load();

        (items()[1]!.querySelector("cds-button") as HTMLElement).click();
        await flush();
        await flush();
        expect(fetch).toHaveBeenNthCalledWith(
            2,
            `/api/auth/sessions/${other.id}`,
            { method: "DELETE" },
        );
        expect(items()).toHaveLength(1);
        expect(section.querySelector(".success")!.textContent).toBe(
            "Signed out that device.",
        );
    });

    it("logs out everywhere else", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                Response.json({ sessions: [current, other] }),
            )
            .mockResolvedValueOnce(Response.json({ revoked: 1 }))
            .mockResolvedValueOnce(Response.json({ sessions: [current] }));
        vi.stubGlobal("fetch", fetch);
        await mountSessions(section).load();

        revokeOthers().click();
        await flush();
        await flush();
        expect(fetch).toHaveBeenNthCalledWith(
            2,
            "/api/auth/sessions/revoke-others",
            { method: "POST" },
        );
        expect(items()).toHaveLength(1);
        expect(revokeOthers().disabled).toBe(true);
    });

    it("renders only the latest of overlapping loads", async () => {
        let answerFirst!: (response: Response) => void;
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockReturnValueOnce(
                    new Promise<Response>((r) => (answerFirst = r)),
                )
                .mockResolvedValueOnce(Response.json({ sessions: [current] })),
        );
        const sessions = mountSessions(section);
        const first = sessions.load();
        await sessions.load();
        answerFirst(Response.json({ sessions: [current, other] }));
        await first;
        expect(items()).toHaveLength(1);
        expect(revokeOthers().disabled).toBe(true);
    });

    it("shows API errors", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                Response.json({ sessions: [current, other] }),
            )
            .mockResolvedValueOnce(
                Response.json({ error: "Session not found" }, { status: 404 }),
            )
            .mockResolvedValueOnce(Response.json({ sessions: [current] }));
        vi.stubGlobal("fetch", fetch);
        await mountSessions(section).load();

        (items()[1]!.querySelector("cds-button") as HTMLElement).click();
        await flush();
        await flush();
        const error = section.querySelector(
            "cds-inline-notification",
        ) as HTMLElement & { subtitle: string };
        expect(error.hidden).toBe(false);
        expect(error.subtitle).toBe("Session not found");
    });

    it("sends a signed-out user to the login page", async () => {
        const replace = vi.fn();
        vi.stubGlobal("location", {
            pathname: "/settings",
            search: "",
            replace,
        });
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
        );
        await mountSessions(section).load();
        expect(replace).toHaveBeenCalledWith("/login?next=%2Fsettings");
    });
});
