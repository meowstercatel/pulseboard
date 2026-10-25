import { execFileSync } from "node:child_process";
import { testEnvironment } from "./environment.mjs";

// Same migrations as the deploy. migrate refuses a contract with no planned
// migration, so a forgotten `prisma migration plan` breaks the tests.
export default function prepareDatabase() {
    for (const command of [
        ["db", "migrate"],
        ["db", "verify"],
    ]) {
        execFileSync(
            "pnpm",
            [
                "exec",
                "prisma",
                ...command,
                "--no-interactive",
                "--config",
                "prisma.test.config.ts",
                "--quiet",
            ],
            {
                cwd: new URL("../backend/", import.meta.url),
                env: { ...process.env, ...testEnvironment() },
                stdio: "inherit",
            },
        );
    }
}
