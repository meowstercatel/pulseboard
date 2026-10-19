import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { verifyOAuthLinkedUsers } from "./auth/emailVerification.js";

await verifyOAuthLinkedUsers();

const app = createApp();

serve(
    {
        fetch: app.fetch,
        port: Number(process.env["PORT"] ?? 3000),
    },
    (info) => {
        console.log(`Server is running on http://localhost:${info.port}`);
    },
);
