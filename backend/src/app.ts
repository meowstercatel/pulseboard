import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { checkPublicUrl } from "./auth/publicUrl.js";
import { auth } from "./routes/auth.js";
import { billing } from "./routes/billing.js";
import { dashboard } from "./routes/dashboard.js";
import { datasets } from "./routes/datasets.js";
import { oauth } from "./routes/oauth.js";
import { staticFiles } from "./static.js";

// Importing the app does not open a port or run startup database updates.
export function createApp() {
    checkPublicUrl();
    const app = new Hono();
    app.use(
        secureHeaders({
            // Mailpit and pgweb share these hostnames over plain http
            strictTransportSecurity: false,
            contentSecurityPolicy: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                // Astro's scoped <style> blocks and style attributes
                styleSrc: ["'self'", "'unsafe-inline'"],
                fontSrc: ["'self'"],
                imgSrc: ["'self'", "data:"],
                connectSrc: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
            },
        }),
    );

    const publicUrl = process.env["PUBLIC_URL"];
    const checkCsrf = csrf({
        origin: publicUrl ? new URL(publicUrl).origin : undefined,
    });
    // Stripe posts cross-origin; its signature is checked in the handler
    app.use((c, next) =>
        c.req.path === "/api/billing/webhook" ? next() : checkCsrf(c, next),
    );

    app.route("/api/auth/oauth", oauth);
    app.route("/api/auth", auth);
    app.route("/api/billing", billing);
    app.route("/api/datasets", datasets);
    app.route("/api/datasets", dashboard);
    app.get("/health", (c) => c.json({ ok: true }));

    const staticDir = process.env["STATIC_DIR"];
    if (staticDir) app.use("/*", staticFiles(staticDir));

    app.notFound(async (c) => {
        if (c.req.path.startsWith("/api/")) {
            return c.json({ error: "Not found" }, 404);
        }
        const page = staticDir
            ? await readFile(join(staticDir, "404.html"), "utf8").catch(
                  () => null,
              )
            : null;
        return page ? c.html(page, 404) : c.text("Not found", 404);
    });
    app.onError((err, c) => {
        if (err instanceof HTTPException) return err.getResponse();
        console.error(`${c.req.method} ${c.req.path} failed`, err);
        return c.req.path.startsWith("/api/")
            ? c.json({ error: "Something went wrong. Try again later" }, 500)
            : c.text("Something went wrong. Try again later", 500);
    });
    return app;
}
