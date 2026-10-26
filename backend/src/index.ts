import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { startCleanup } from "./cleanup.js";
import { db } from "./prisma/db.js";

// Docker sends SIGKILL 10 s after SIGTERM, so give up a little earlier
const SHUTDOWN_TIMEOUT_MS = 8000;

const app = createApp();

const server = serve(
    {
        fetch: app.fetch,
        port: Number(process.env["PORT"] ?? 3000),
    },
    (info) => {
        console.log(`Server is running on http://localhost:${info.port}`);
    },
);

const stopCleanup = startCleanup();

let shuttingDown = false;
async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, finishing open requests`);
    setTimeout(() => {
        console.error("Shutdown timed out, exiting");
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    const cleanupStopped = stopCleanup();
    // stop accepting connections and wait for in-flight requests
    await new Promise<void>((resolve) => {
        server.close(() => resolve());
        if ("closeIdleConnections" in server) server.closeIdleConnections();
    });
    await cleanupStopped;
    await db.close();
    process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
