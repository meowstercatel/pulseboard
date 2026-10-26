import { Window } from "happy-dom";
import { expect, it, vi } from "vitest";
import {
    accountDestination,
    type User,
    login,
    loginUrl,
    requireUser,
    requireVerifiedUser,
    requireLicense,
    safeNext,
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
