import { serveStatic } from "@hono/node-server/serve-static";
import type { MiddlewareHandler } from "hono";

// Serves the Astro build. The build writes .br/.gz copies next to each file,
// picked by Accept-Encoding. Files under /_astro/ have a content hash in their
// name, so browsers keep them; everything else (HTML) is revalidated.
export function staticFiles(root: string): MiddlewareHandler {
    const serve = serveStatic({ root, precompressed: true });
    return async (c, next) => {
        const res = await serve(c, next);
        // Misses fall through to next() and return whatever it returns
        if (res instanceof Response)
            res.headers.set(
                "Cache-Control",
                c.req.path.startsWith("/_astro/")
                    ? "public, max-age=31536000, immutable"
                    : "no-cache",
            );
        return res;
    };
}
