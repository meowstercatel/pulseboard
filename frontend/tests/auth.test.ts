import { expect, it, vi } from "vitest";
import {
    login,
    requireUser,
    requireVerifiedUser,
    requireLicense,
} from "../src/lib/auth";

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
