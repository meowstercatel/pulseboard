import { defineConfig } from "vitest/config";
import { testEnvironment } from "./tests/environment.mjs";

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: "unit",
                    include: [
                        "backend/tests/unit/**/*.test.ts",
                        "frontend/tests/**/*.test.ts",
                    ],
                    restoreMocks: true,
                    unstubEnvs: true,
                    unstubGlobals: true,
                },
            },
            {
                test: {
                    name: "integration",
                    include: ["backend/tests/integration/**/*.test.ts"],
                    env: testEnvironment(),
                    globalSetup: ["./tests/prepare-db.mjs"],
                    testTimeout: 15000,
                    hookTimeout: 15000,
                    restoreMocks: true,
                },
            },
        ],
    },
});
