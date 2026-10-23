import { fileURLToPath } from "node:url";
import prepareDatabase from "./prepare-db.mjs";
import { testEnvironment } from "./environment.mjs";
import { mockStripe } from "./stripe.mjs";

prepareDatabase();
Object.assign(process.env, testEnvironment(), {
    PORT: process.env.TEST_PORT || "4300",
    STATIC_DIR: fileURLToPath(new URL("../frontend/dist/", import.meta.url)),
    SMTP_URL: process.env.TEST_SMTP_URL || "smtp://127.0.0.1:51025",
});
mockStripe();
await import("../backend/dist/index.js");
