import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { auth } from "./routes/auth.js";

const app = new Hono();

app.route("/api/auth", auth);
app.get("/health", (c) => {
    return c.json({ ok: true });
});

// In the Docker image the built frontend is served from STATIC_DIR
const staticDir = process.env["STATIC_DIR"];
if (staticDir) {
    app.use("/*", serveStatic({ root: staticDir }));
}

app.get("/", (c) => {
    return c.text("Hello Hono!");
});

serve(
    {
        fetch: app.fetch,
        port: Number(process.env["PORT"] ?? 3000),
    },
    (info) => {
        console.log(`Server is running on http://localhost:${info.port}`);
    },
);
