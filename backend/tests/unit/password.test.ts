import { expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/auth/password.js";

it("accepts the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(
        true,
    );
    expect(await verifyPassword("wrong password", hash)).toBe(false);
});

it("uses a new salt for the same password", async () => {
    const first = await hashPassword("same password");
    const second = await hashPassword("same password");
    expect(first).not.toBe(second);
    expect(await verifyPassword("same password", second)).toBe(true);
});

it.each(["", "not-a-hash", "bcrypt$salt$hash", "scrypt$$hash", "scrypt$salt$"])(
    "rejects an unsupported or incomplete stored hash: %s",
    async (stored) =>
        expect(await verifyPassword("password", stored)).toBe(false),
);
