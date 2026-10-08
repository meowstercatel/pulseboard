import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
    password: string,
    salt: Buffer,
    keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, KEY_LENGTH);
    return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(
    password: string,
    stored: string,
): Promise<boolean> {
    const [algorithm, saltHex, hashHex] = stored.split("$");
    if (algorithm !== "scrypt" || !saltHex || !hashHex) return false;

    const expected = Buffer.from(hashHex, "hex");
    const actual = await scryptAsync(
        password,
        Buffer.from(saltHex, "hex"),
        expected.length,
    );
    return timingSafeEqual(actual, expected);
}

// Used when the email doesn't exist, so a failed login takes the same time either way
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));
