export function isUniqueViolation(err: unknown): boolean {
    for (let e = err; e && typeof e === "object"; e = (e as any).cause) {
        if ((e as { sqlState?: string }).sqlState === "23505") return true;
    }
    return false;
}
