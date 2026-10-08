// @ts-check
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
    vite: {
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
