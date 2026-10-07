// @ts-check
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
    vite: {
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
