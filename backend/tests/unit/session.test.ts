import { describe, expect, it, vi } from "vitest";
import { trimUserAgent } from "../../src/auth/session.js";

vi.mock("../../src/prisma/db.js", () => ({ db: {} }));

describe("trimUserAgent", () => {
    it("keeps an ordinary user agent as it is", () => {
        const ua =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
        expect(trimUserAgent(ua)).toBe(ua);
    });

    it("stores nothing for a missing or blank header", () => {
        expect(trimUserAgent(undefined)).toBeNull();
        expect(trimUserAgent("")).toBeNull();
        expect(trimUserAgent(" \t ")).toBeNull();
    });

    it("drops control characters and collapses whitespace", () => {
        expect(trimUserAgent("  curl/8.0\r\n\u0000 x\u007f  y ")).toBe(
            "curl/8.0 x y",
        );
    });

    it("caps the length at 256 characters", () => {
        expect(trimUserAgent("a".repeat(5000))).toHaveLength(256);
        expect(trimUserAgent(`${"a".repeat(255)} b`)).toBe("a".repeat(255));
    });
});
