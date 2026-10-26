import * as crypto from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";

// Records the scrypt cost of each call, to compare what each check pays for
vi.mock("node:crypto", async (importOriginal) => {
    const original = await importOriginal<typeof crypto>();
    return { ...original, scrypt: vi.fn(original.scrypt) };
});

const { DUMMY_HASH, hashPassword, verifyPassword } =
    await import("../../src/auth/password.js");
const scrypt = vi.mocked(crypto.scrypt);

function legacyHash(password: string) {
    const salt = crypto.randomBytes(16);
    return `scrypt$${salt.toString("hex")}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

// The N of every scrypt call verifyPassword makes, sorted
async function costOf(password: string, stored: string) {
    scrypt.mockClear();
    await verifyPassword(password, stored);
    return scrypt.mock.calls
        .map((call) => (call[3] as crypto.ScryptOptions).N)
        .sort((a, b) => a! - b!);
}

beforeEach(() => {
    scrypt.mockClear();
});

it("pays the same scrypt cost to reject a wrong password for any kind of hash", async () => {
    const current = await hashPassword("password");
    const legacy = legacyHash("password");
    const missing = await costOf("wrong password", DUMMY_HASH);
    expect(missing).toEqual([2 ** 14, 2 ** 17]);
    expect(await costOf("wrong password", current)).toEqual(missing);
    expect(await costOf("wrong password", legacy)).toEqual(missing);
});

it("doesn't pay extra for a right password", async () => {
    expect(await costOf("password", await hashPassword("password"))).toEqual([
        2 ** 17,
    ]);
    expect(await costOf("password", legacyHash("password"))).toEqual([2 ** 14]);
});
