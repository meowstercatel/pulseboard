import type { APIRoute } from "astro";
import { disallowed } from "../lib/seo";

// Built with the rest of the site. Staging serves the same file, but nginx
// adds X-Robots-Tag: noindex to everything there, so nothing gets indexed.
export const GET: APIRoute = ({ site }) =>
    new Response(
        [
            "User-agent: *",
            ...disallowed.map((path) => `Disallow: ${path}`),
            "",
            `Sitemap: ${new URL("/sitemap.xml", site)}`,
            "",
        ].join("\n"),
        { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
