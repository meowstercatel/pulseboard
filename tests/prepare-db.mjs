import { execFileSync } from "node:child_process";
import { testEnvironment } from "./environment.mjs";

export default function prepareDatabase() {
    execFileSync(
        "pnpm",
        [
            "exec",
            "prisma",
            "db",
            "update",
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
