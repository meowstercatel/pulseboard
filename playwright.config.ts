import { defineConfig, devices } from "@playwright/test";

const baseURL = `http://127.0.0.1:${process.env.TEST_PORT || "4300"}`;

export default defineConfig({
    testDir: "./tests/e2e",
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        baseURL,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: {
        command: "node tests/start-e2e-server.mjs",
        url: `${baseURL}/health`,
        reuseExistingServer: false,
        timeout: 120000,
    },
});
