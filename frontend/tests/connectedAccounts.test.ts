import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    canUnlink,
    linkResult,
    mountConnectedAccounts,
    type ConnectedAccount,
    type ConnectedAccounts,
} from "../src/lib/connectedAccounts";

const google: ConnectedAccount = {
    id: 1,
    provider: "google",
    email: "alice@gmail.example",
    createdAt: "2026-10-01T00:00:00Z",
};
const facebook: ConnectedAccount = {
    id: 2,
    provider: "facebook",
    email: '<img src=x onerror="alert(1)">',
    createdAt: "2026-10-02T00:00:00Z",
};
const state = (overrides: Partial<ConnectedAccounts>): ConnectedAccounts => ({
    hasPassword: false,
    accounts: [google],
    providers: ["google", "facebook"],
    ...overrides,
});

describe("linkResult", () => {
    it.each([
        ["linked=google", { ok: true, message: "Google account connected." }],
        [
            "link_error=linked_elsewhere&provider=facebook",
            {
                ok: false,
                message:
                    "That Facebook account already logs in to another PulseBoard account. Disconnect it there first.",
            },
        ],
        [
            "link_error=cancelled&provider=google",
            { ok: false, message: "Connecting Google was cancelled" },
        ],
        [
            "link_error=<b>hi</b>&provider=google",
            {
                ok: false,
                message: "Couldn't connect the account, please try again",
            },
        ],
        [
            "link_error=failed&provider=evil",
            {
                ok: false,
                message: "Couldn't connect the account, please try again",
            },
        ],
        ["linked=evil", null],
        ["", null],
    ])("maps ?%s to a fixed message", (query, expected) => {
        expect(linkResult(new URLSearchParams(query))).toEqual(expected);
    });
});

describe("canUnlink", () => {
    it("never allows removing the last way to log in", () => {
        expect(canUnlink(state({}), google.id)).toBe(false);
        expect(canUnlink(state({ hasPassword: true }), google.id)).toBe(true);
        expect(
            canUnlink(state({ accounts: [google, facebook] }), google.id),
        ).toBe(true);
    });

    it("doesn't count a provider the server no longer offers", () => {
        expect(
            canUnlink(
                state({ accounts: [google, facebook], providers: ["google"] }),
                google.id,
            ),
        ).toBe(false);
    });
});

describe("mountConnectedAccounts", () => {
    let window: Window;
    let section: HTMLElement;

    beforeEach(() => {
        window = new Window({ url: "http://localhost/settings" });
        const doc = window.document as unknown as Document;
        vi.stubGlobal("document", doc);
        vi.stubGlobal("location", window.location);
        doc.body.innerHTML = `
            <section id="connected-accounts">
                <ul></ul>
                <cds-inline-notification hidden></cds-inline-notification>
                <p class="success" role="status"></p>
                <div class="connect" hidden>
                    <cds-text-input name="currentPassword" hidden></cds-text-input>
                    <div class="connect-buttons"></div>
                </div>
            </section>`;
        section = doc.getElementById("connected-accounts")!;
    });
    afterEach(async () => {
        await window.happyDOM.close();
    });

    const items = () => [...section.querySelectorAll("li")];
    const connectButtons = () => [
        ...section.querySelectorAll<HTMLElement & { disabled: boolean }>(
            ".connect-buttons cds-button",
        ),
    ];
    const password = () =>
        section.querySelector('[name="currentPassword"]') as HTMLElement & {
            value: string;
        };
    const error = () =>
        section.querySelector("cds-inline-notification") as HTMLElement & {
            subtitle: string;
        };
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it("lists logins as text and offers the providers not yet connected", async () => {
        const onLoad = vi.fn();
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue(
                    Response.json(state({ accounts: [facebook] })),
                ),
        );
        await mountConnectedAccounts(section, onLoad).load();

        expect(items()).toHaveLength(1);
        expect(items()[0]!.querySelector("img")).toBeNull();
        expect(items()[0]!.textContent).toContain("Facebook");
        expect(items()[0]!.textContent).toContain("<img");
        expect(connectButtons().map((b) => b.textContent)).toEqual([
            "Connect Google",
        ]);
        expect(section.querySelector<HTMLElement>(".connect")!.hidden).toBe(
            false,
        );
        // social-only: no password to ask for
        expect(password().hidden).toBe(true);
        expect(onLoad).toHaveBeenCalledWith(
            expect.objectContaining({ hasPassword: false }),
        );
    });

    it("disables disconnecting the only login", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(Response.json(state({}))),
        );
        await mountConnectedAccounts(section).load();
        const button = items()[0]!.querySelector(
            "cds-button",
        ) as HTMLElement & {
            disabled: boolean;
        };
        expect(button.disabled).toBe(true);
        expect(button.title).toContain("only way to log in");
    });

    it("asks for the password before connecting a password account", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(Response.json(state({ hasPassword: true })))
            .mockResolvedValueOnce(
                Response.json({ url: "https://www.facebook.com/dialog" }),
            );
        vi.stubGlobal("fetch", fetch);
        const assign = vi.fn();
        vi.stubGlobal("location", { ...window.location, assign });
        await mountConnectedAccounts(section).load();
        expect(password().hidden).toBe(false);

        connectButtons()[0]!.click();
        await flush();
        expect(fetch).toHaveBeenCalledOnce();
        expect(error().subtitle).toBe(
            "Enter your current password to connect Facebook",
        );

        password().value = "my password";
        connectButtons()[0]!.click();
        await flush();
        await flush();
        expect(fetch).toHaveBeenLastCalledWith(
            "/api/auth/oauth/facebook/link",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ currentPassword: "my password" }),
            },
        );
        expect(assign).toHaveBeenCalledWith("https://www.facebook.com/dialog");
    });

    it("shows why a link couldn't start", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce(Response.json(state({})))
                .mockResolvedValueOnce(
                    Response.json(
                        { error: "Sign in again with Google or Facebook" },
                        { status: 403 },
                    ),
                ),
        );
        await mountConnectedAccounts(section).load();
        connectButtons()[0]!.click();
        await flush();
        await flush();
        expect(error().hidden).toBe(false);
        expect(error().subtitle).toBe("Sign in again with Google or Facebook");
        expect(connectButtons()[0]!.disabled).toBe(false);
    });

    it("disconnects a login and reloads", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                Response.json(state({ accounts: [google, facebook] })),
            )
            .mockResolvedValueOnce(Response.json({ revoked: 2 }))
            .mockResolvedValueOnce(Response.json(state({})));
        vi.stubGlobal("fetch", fetch);
        await mountConnectedAccounts(section).load();

        (items()[1]!.querySelector("cds-button") as HTMLElement).click();
        await flush();
        await flush();
        expect(fetch).toHaveBeenNthCalledWith(
            2,
            "/api/auth/connected-accounts/2",
            {
                method: "DELETE",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ currentPassword: "" }),
            },
        );
        expect(items()).toHaveLength(1);
        expect(section.querySelector(".success")!.textContent).toBe(
            "Facebook disconnected. Other devices have been signed out.",
        );
    });

    it("asks a password account for its password before disconnecting", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                Response.json(
                    state({
                        hasPassword: true,
                        accounts: [google, facebook],
                        providers: ["google", "facebook"],
                    }),
                ),
            )
            .mockResolvedValueOnce(Response.json({ revoked: 0 }))
            .mockResolvedValueOnce(Response.json(state({ hasPassword: true })));
        vi.stubGlobal("fetch", fetch);
        await mountConnectedAccounts(section).load();
        // nothing left to connect, but the password is still asked for
        expect(section.querySelector<HTMLElement>(".connect")!.hidden).toBe(
            true,
        );
        expect(password().hidden).toBe(false);

        const disconnect = () =>
            (items()[0]!.querySelector("cds-button") as HTMLElement).click();
        disconnect();
        await flush();
        expect(fetch).toHaveBeenCalledOnce();
        expect(error().subtitle).toBe(
            "Enter your current password to disconnect Google",
        );

        password().value = "my password";
        disconnect();
        await flush();
        await flush();
        expect(fetch).toHaveBeenNthCalledWith(
            2,
            "/api/auth/connected-accounts/1",
            {
                method: "DELETE",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ currentPassword: "my password" }),
            },
        );
    });

    it("shows the callback's outcome", () => {
        const accounts = mountConnectedAccounts(section);
        accounts.showResult({ ok: false, message: "Couldn't connect Google" });
        expect(error().hidden).toBe(false);
        accounts.showResult({ ok: true, message: "Google account connected." });
        expect(error().hidden).toBe(true);
        expect(section.querySelector(".success")!.textContent).toBe(
            "Google account connected.",
        );
    });
});
