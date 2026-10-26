import { test as base } from "@playwright/test";

export * from "@playwright/test";

let next = 0;

// The rate limiters live in the one server process for the whole run, so
// every test (and every retry or --repeat-each copy) gets its own client
// address. The E2E server trusts X-Forwarded-For from loopback.
export const test = base.extend({
    extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
        const ip = `2001:db8::${testInfo.workerIndex.toString(16)}:${(next++).toString(16)}`;
        await use({ ...extraHTTPHeaders, "x-forwarded-for": ip });
    },
});
