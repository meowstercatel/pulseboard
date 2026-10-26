// Same limits as backend/src/auth/password.ts. Only the backend's length
// check decides what is accepted; the score below is a hint for the user.
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 256;

export type Strength = {
    // 0 when empty or outside the allowed length, then 1 (weak) to 4 (strong)
    score: 0 | 1 | 2 | 3 | 4;
    label: string;
};

const LABELS = ["", "Weak", "Fair", "Good", "Strong"] as const;
// The start of a few lists everyone tries first
const COMMON = /password|qwerty|12345|abcdef|letmein|iloveyou|admin/gi;

export function passwordStrength(password: string): Strength {
    if (!password) return { score: 0, label: "" };
    if (password.length < MIN_PASSWORD) return { score: 0, label: "Too short" };
    if (password.length > MAX_PASSWORD) return { score: 0, label: "Too long" };

    const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z\d]/].filter((kind) =>
        kind.test(password),
    ).length;
    let score = 1;
    if (password.length >= 12) score++;
    if (password.length >= 16) score++;
    if (kinds >= 3) score++;
    // long but predictable, like "aaaaaaaaaaaa" or "Password1234567!": too
    // little is left once the common parts are taken out. "Badminton…" is
    // fine, the rest of it is long enough.
    const rest = password.replace(COMMON, "");
    if (new Set(password).size < 5 || rest.length < MIN_PASSWORD) score = 1;

    const capped = Math.min(score, 4) as Strength["score"];
    return { score: capped, label: LABELS[capped] };
}
