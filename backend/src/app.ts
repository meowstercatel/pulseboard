import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { auth } from "./routes/auth.js";
import { billing } from "./routes/billing.js";
import { oauth } from "./routes/oauth.js";

// Importing the app does not open a port or run startup database updates.
export function createApp() {
    const app = new Hono();
    app.route("/api/auth/oauth", oauth);
    app.route("/api/auth", auth);
    app.route("/api/billing", billing);
    app.get("/health", (c) => c.json({ ok: true }));

    const staticDir = process.env["STATIC_DIR"];
    if (staticDir) app.use("/*", serveStatic({ root: staticDir }));
    app.get("/", (c) => c.text("Hello Hono!"));
    return app;
}
