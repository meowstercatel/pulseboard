import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import {
    accountDestination,
    type User,
    login,
    loginUrl,
    requireUser,
    requireVerifiedUser,
    requireLicense,
    safeNext,
    verifiedStep,
    verifyEmail,
    disownAccount,
    disownedMessage,
} from "../src/lib/auth";

it.each([
    [false, null, "/verify-email"],
    [false, "lifetime", "/verify-email"],
    [true, null, "/buy"],
    [true, "lifetime", "/overview"],
])("chooses the next account step", (emailVerified, licensePlan, expected) => {
    expect(accountDestination({ emailVerified, licensePlan } as User)).toBe(
        expected,
    );
});

it.each([
    ["/history", "/history"],
    ["/overview?dataset=3", "/overview?dataset=3"],
    ["/settings#delete", "/settings#delete"],
    ["/a/../history", "/history"],
    ["/%2F%2Fevil.example", "/%2F%2Fevil.example"],
])("follows the same-origin path %s", (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
});

it.each([
    null,
    "",
    "history",
    "//evil.example",
    "///evil.example",
    "/\\evil.example",
    "\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    " /history",
    "https://evil.example/history",
    "javascript:alert(1)",
    "/login",
    "/register?next=/history",
    "/a/../login",
    "/login/",
    "/LOGIN",
    "/register/index.html",
    "/api/auth/oauth/google",
    "/./api/auth/logout",
    "/" + "a".repeat(1100),
])("ignores %j as a next page", (raw) => {
    expect(safeNext(raw)).toBeNull();
});

it.each([
    [false, null, "/history", "/verify-email"],
    [true, null, "/settings", "/settings"],
    [true, "lifetime", "/history?dataset=2", "/history?dataset=2"],
    [true, "lifetime", "//evil.example", "/overview"],
])(
    "returns a verified user to the requested page",
    (emailVerified, licensePlan, next, expected) => {
        expect(
            accountDestination({ emailVerified, licensePlan } as User, next),
        ).toBe(expected);
    },
);

it.each([
    ["/history", "?dataset=2", "/login?next=%2Fhistory%3Fdataset%3D2"],
    ["/settings", "", "/login?next=%2Fsettings"],
    ["/login", "", "/login"],
])("sends %s%s to the login page and back", (pathname, search, expected) => {
    vi.stubGlobal("location", { pathname, search });
    expect(loginUrl()).toBe(expected);
});

it("turns a network failure into a form error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect(await login("alice@example.com", "password")).toEqual({
        error: "Can't reach the server",
    });
});

it("handles a non-JSON error response", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("Bad gateway", { status: 502 })),
    );
    expect(await login("alice@example.com", "password")).toEqual({
        error: "Something went wrong (502)",
        status: 502,
    });
});

it("preserves API validation errors", async () => {
    vi.stubGlobal(
        "fetch",
        vi
            .fn()
            .mockResolvedValue(
                Response.json(
                    { error: "Wrong email or password" },
                    { status: 401 },
                ),
            ),
    );
    expect(await login("alice@example.com", "password")).toEqual({
        error: "Wrong email or password",
        status: 401,
    });
});

it.each([
    [requireUser, null, "/login"],
    [requireVerifiedUser, { emailVerified: false }, "/verify-email"],
    [requireLicense, { emailVerified: true, licensePlan: null }, "/buy"],
])(
    "redirects when an access requirement is missing",
    async (guard, user, path) => {
        const replace = vi.fn();
        vi.stubGlobal("location", { replace });
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue(
                    Response.json({ user }, { status: user ? 200 : 401 }),
                ),
        );
        expect(await guard()).toBeNull();
        expect(replace).toHaveBeenCalledExactlyOnceWith(path);
    },
);

it("allows a verified user with a license", async () => {
    const user = {
        id: 1,
        email: "alice@example.com",
        username: null,
        emailVerified: true,
        licensePlan: "lifetime",
    };
    const replace = vi.fn();
    vi.stubGlobal("location", { replace });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ user })));
    expect(await requireLicense()).toEqual(user);
    expect(replace).not.toHaveBeenCalled();
});

it("shows a protected page only once the user may see it", async () => {
    const { document } = new Window();
    vi.stubGlobal("document", document);
    const root = document.documentElement;
    root.setAttribute("data-auth-pending", "");
    vi.stubGlobal("location", { replace: vi.fn() });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json({
                user: { emailVerified: true, licensePlan: null },
            }),
        ),
    );
    await requireLicense();
    expect(root.hasAttribute("data-auth-pending")).toBe(true);
    await requireVerifiedUser();
    expect(root.hasAttribute("data-auth-pending")).toBe(false);
});

describe("after the verification link", () => {
    const user = { emailVerified: true, licensePlan: null } as User;

    it("continues as usual when nothing was removed", () => {
        expect(
            verifiedStep({ user, removedLogins: [], needsPassword: false }),
        ).toEqual({ message: "Your email address is verified.", href: "/buy" });
    });

    it("explains a removed login and sends a user with no other login to set a password", () => {
        expect(
            verifiedStep({
                user,
                removedLogins: ["Facebook"],
                needsPassword: true,
            }),
        ).toEqual({
            message:
                "Your email address is verified. The Facebook login connected before you verified it was removed, because it may not have been yours. If it was, connect it again in Settings. Set a password in Settings, so you can log in again after you sign out.",
            href: "/settings",
        });
    });

    it("names several removed providers and keeps going when a login is left", () => {
        const { message, href } = verifiedStep({
            user: { ...user, licensePlan: "lifetime" },
            removedLogins: ["Facebook", "Google"],
            needsPassword: false,
        });
        expect(message).toContain(
            "The Facebook and Google logins connected before you verified it were removed",
        );
        expect(message).not.toContain("Set a password");
        expect(href).toBe("/overview");
    });
});

describe("a link opened outside the account's session", () => {
    function serverAnswers(status: number, body: unknown) {
        const fetch = vi
            .fn()
            .mockResolvedValue(Response.json(body, { status }));
        vi.stubGlobal("fetch", fetch);
        return fetch;
    }
    const sentBody = (fetch: ReturnType<typeof vi.fn>) =>
        JSON.parse(fetch.mock.calls[0]![1].body);

    it("asks for the password when the server wants it", async () => {
        const fetch = serverAnswers(403, {
            error: "Enter the account's password to finish verifying",
            confirm: "password",
            email: "a@example.com",
        });
        expect(await verifyEmail("t0k3n")).toEqual({
            confirm: "password",
            email: "a@example.com",
        });
        // only the token: no password field at all
        expect(sentBody(fetch)).toEqual({ token: "t0k3n" });
    });

    it("sends the password and returns the verification", async () => {
        const user = { id: 1, emailVerified: true } as User;
        const fetch = serverAnswers(200, {
            user,
            removedLogins: [],
            needsPassword: false,
        });
        expect(await verifyEmail("t0k3n", "hunter22!")).toEqual({
            user,
            removedLogins: [],
            needsPassword: false,
        });
        expect(sentBody(fetch)).toEqual({
            token: "t0k3n",
            password: "hunter22!",
        });
    });

    it.each([
        [401, { error: "Wrong password" }, "Wrong password"],
        [
            429,
            { error: "Too many attempts, try again in 15 minutes" },
            "Too many attempts, try again in 15 minutes",
        ],
        [
            400,
            { error: "This verification link is invalid or has expired" },
            "This verification link is invalid or has expired",
        ],
        // a 403 that isn't asking for the password is just an error
        [403, { error: "Forbidden" }, "Forbidden"],
    ])("reports a %i as an error", async (status, body, error) => {
        serverAnswers(status, body);
        expect(await verifyEmail("t0k3n", "x")).toEqual({ error, status });
    });

    it("says when the server can't be reached", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockRejectedValue(new TypeError("offline")),
        );
        expect(await verifyEmail("t0k3n")).toEqual({
            error: "Can't reach the server",
        });
        expect(await disownAccount("t0k3n")).toEqual({
            error: "Can't reach the server",
        });
    });

    it("disowns the account with the token only", async () => {
        const fetch = serverAnswers(200, {
            email: "a@example.com",
            emailSent: true,
        });
        expect(await disownAccount("t0k3n")).toEqual({
            email: "a@example.com",
            emailSent: true,
        });
        expect(fetch.mock.calls[0]![0]).toBe("/api/auth/verify-email/not-mine");
        expect(sentBody(fetch)).toEqual({ token: "t0k3n" });
    });

    it("reports a used link when disowning", async () => {
        serverAnswers(400, {
            error: "This verification link is invalid or has expired",
        });
        expect(await disownAccount("t0k3n")).toEqual({
            error: "This verification link is invalid or has expired",
            status: 400,
        });
    });

    it("tells the owner where the password link went, or that it didn't", () => {
        const sent = disownedMessage({
            email: "a@example.com",
            emailSent: true,
        });
        expect(sent).toContain("a@example.com is verified");
        expect(sent).toContain("signed out");
        expect(sent).toContain(
            "We sent a link to a@example.com to choose your own password.",
        );
        const failed = disownedMessage({
            email: "a@example.com",
            emailSent: false,
        });
        expect(failed).toContain("couldn't send the email");
        expect(failed).not.toContain("We sent a link");
    });
});
