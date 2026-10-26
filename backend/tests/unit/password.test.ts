import { randomBytes, scryptSync } from "node:crypto";
import { expect, it } from "vitest";
import {
    hashPassword,
    needsRehash,
    verifyPassword,
} from "../../src/auth/password.js";

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

const legacyHash = (password: string) => {
    const salt = randomBytes(16);
    return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 64).toString("hex")}`;
};

it("stores the scrypt parameters in the hash", async () => {
    const hash = await hashPassword("password");
    expect(hash).toMatch(
        /^scrypt\$ln=17,r=8,p=1\$[0-9a-f]{32}\$[0-9a-f]{128}$/,
    );
    expect(needsRehash(hash)).toBe(false);
});

it("verifies hashes from before the parameters were stored, and marks them for rehashing", async () => {
    const hash = legacyHash("old password");
    expect(await verifyPassword("old password", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
    expect(needsRehash(hash)).toBe(true);
});

it("verifies with the parameters stored in the hash", async () => {
    const salt = randomBytes(16);
    const key = scryptSync("password", salt, 64, { N: 2 ** 15, r: 4, p: 2 });
    const hash = `scrypt$ln=15,r=4,p=2$${salt.toString("hex")}$${key.toString("hex")}`;
    expect(await verifyPassword("password", hash)).toBe(true);
    expect(needsRehash(hash)).toBe(true);
});

it.each([
    "scrypt$ln=30,r=8,p=1$00$00",
    "scrypt$ln=10,r=8,p=1$00$00",
    "scrypt$ln=17,r=0,p=1$00$00",
    "scrypt$ln=17,r=8,p=9$00$00",
    "scrypt$n=17$00$00",
    "scrypt$ln=17,r=8,p=1$salt$hash",
    "scrypt$ln=17,r=8,p=1$00$00$00",
])("rejects stored parameters outside the allowed range: %s", async (stored) =>
    expect(await verifyPassword("password", stored)).toBe(false),
);
