import { expect, it } from "vitest";
import { safeNext } from "../../src/auth/nextPath.js";

it.each([
    ["/history", "/history"],
    ["/overview?dataset=3", "/overview?dataset=3"],
    ["/a/../history", "/history"],
])("follows the same-origin path %s", (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
});

it.each([
    undefined,
    "",
    "history",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/\t/evil.example",
    "https://evil.example/history",
    "javascript:alert(1)",
    "/login",
    "/register",
])("ignores %j as a next page", (raw) => {
    expect(safeNext(raw)).toBeNull();
});
