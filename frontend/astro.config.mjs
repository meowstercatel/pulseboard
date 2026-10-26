// @ts-check
import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { normalizePath, publicPage, siteUrl } from "./src/lib/seo.ts";

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// Writes .br and .gz copies of text files for the backend's serveStatic
// (precompressed: true), so nothing is compressed per request.
/** @returns {import("astro").AstroIntegration} */
const precompress = () => ({
    name: "precompress",
    hooks: {
        "astro:build:done": async ({ dir }) => {
            const root = fileURLToPath(dir);
            const files = await readdir(root, { recursive: true });
            for (const file of files) {
                if (!/\.(html|css|js|svg|ico|json|xml|txt|csv)$/.test(file))
                    continue;
                const path = `${root}/${file}`;
                const data = await readFile(path);
                if (data.length < 1024) continue;
                await writeFile(
                    `${path}.br`,
                    await brotli(data, {
                        params: {
                            [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
                            [zlib.constants.BROTLI_PARAM_SIZE_HINT]:
                                data.length,
                        },
                    }),
                );
                await writeFile(`${path}.gz`, await gzip(data, { level: 9 }));
            }
        },
    },
});

// @astrojs/sitemap always names its index sitemap-index.xml; robots.txt points
// at the conventional /sitemap.xml instead
/** @returns {import("astro").AstroIntegration} */
const sitemapAlias = () => ({
    name: "sitemap-alias",
    hooks: {
        "astro:build:done": async ({ dir }) => {
            const root = fileURLToPath(dir);
            await copyFile(`${root}/sitemap-index.xml`, `${root}/sitemap.xml`);
        },
    },
});

const site = siteUrl(process.env.PUBLIC_URL);

// https://astro.build/config
export default defineConfig({
    site,
    integrations: [
        sitemap({
            filter: (page) => !!publicPage(new URL(page).pathname),
            namespaces: { news: false, image: false, video: false },
            // without the trailing slash, as in the canonical links, and with
            // the other language version of the legal pages
            serialize: (item) => {
                const page = publicPage(new URL(item.url).pathname);
                const url = (path) => new URL(path, site).href;
                return {
                    ...item,
                    url: url(normalizePath(new URL(item.url).pathname)),
                    links: page?.alternates && [
                        ...Object.entries(page.alternates).map(
                            ([lang, path]) => ({ lang, url: url(path) }),
                        ),
                        { lang: "x-default", url: url(page.alternates.en) },
                    ],
                };
            },
        }),
        sitemapAlias(),
        precompress(),
    ],
    vite: {
        // keeps scripts out of the HTML so the CSP can stay script-src 'self'
        build: { assetsInlineLimit: 0 },
        server: {
            // needed for local development, doesn't affect github deployments
            proxy: { "/api": "http://localhost:3000" },
        },
        css: {
            preprocessorOptions: {
                scss: {
                    quietDeps: true,
                    silenceDeprecations: [
                        "import",
                        "global-builtin",
                        "if-function",
                    ],
                },
            },
        },
    },
});
