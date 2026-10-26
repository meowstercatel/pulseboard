import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

type Params = { ln: number; r: number; p: number };

// N = 2^17, r = 8, p = 1 (OWASP's scrypt recommendation), about 128 MiB per hash.
// They're stored in the hash, so they can be raised later without breaking
// existing hashes.
const PARAMS: Params = { ln: 17, r: 8, p: 1 };
// Hashes stored as scrypt$salt$hash, from before the parameters were stored,
// used Node's defaults
const LEGACY_PARAMS: Params = { ln: 14, r: 8, p: 1 };
// Stored hashes outside this range are rejected instead of run
const MAX_PARAMS: Params = { ln: 20, r: 16, p: 4 };

const KEY_LENGTH = 64;
const HEX_RE = /^(?:[0-9a-f]{2})+$/;
const PARAMS_RE = /^ln=(\d+),r=(\d+),p=(\d+)$/;

function scryptAsync(
    password: string,
    salt: Buffer,
    keylen: number,
    { ln, r, p }: Params,
): Promise<Buffer> {
    const N = 2 ** ln;
    return new Promise((resolve, reject) =>
        scrypt(
            password,
            salt,
            keylen,
            // Node refuses anything over 32 MiB by default
            { N, r, p, maxmem: 256 * N * r },
            (err, key) => (err ? reject(err) : resolve(key)),
        ),
    );
}

function parse(stored: string) {
    const parts = stored.split("$");
    if (parts[0] !== "scrypt") return null;

    let params = LEGACY_PARAMS;
    if (parts.length === 4) {
        const match = PARAMS_RE.exec(parts[1]!);
        if (!match) return null;
        const [ln, r, p] = match.slice(1).map(Number) as [
            number,
            number,
            number,
        ];
        if (
            ln < LEGACY_PARAMS.ln ||
            ln > MAX_PARAMS.ln ||
            r < 1 ||
            r > MAX_PARAMS.r ||
            p < 1 ||
            p > MAX_PARAMS.p
        ) {
            return null;
        }
        params = { ln, r, p };
    } else if (parts.length !== 3) {
        return null;
    }

    const [saltHex, hashHex] = parts.slice(-2) as [string, string];
    if (!HEX_RE.test(saltHex) || !HEX_RE.test(hashHex)) return null;
    return {
        params,
        salt: Buffer.from(saltHex, "hex"),
        hash: Buffer.from(hashHex, "hex"),
    };
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, KEY_LENGTH, PARAMS);
    const { ln, r, p } = PARAMS;
    return `scrypt$ln=${ln},r=${r},p=${p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(
    password: string,
    stored: string,
): Promise<boolean> {
    const parsed = parse(stored);
    if (!parsed) return false;

    const actual = await scryptAsync(
        password,
        parsed.salt,
        parsed.hash.length,
        parsed.params,
    );
    return timingSafeEqual(actual, parsed.hash);
}

// True when the hash uses older parameters than hashPassword does now
export function needsRehash(stored: string): boolean {
    const parsed = parse(stored);
    return (
        !parsed ||
        parsed.params.ln !== PARAMS.ln ||
        parsed.params.r !== PARAMS.r ||
        parsed.params.p !== PARAMS.p ||
        parsed.hash.length !== KEY_LENGTH
    );
}

// Used when the email doesn't exist, so a failed login takes the same time either way
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));
