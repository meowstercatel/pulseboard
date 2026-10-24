// @ts-check
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
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
