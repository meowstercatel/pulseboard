import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) =>
    JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

// Backups (scripts/db-backup.sh) started before the withdrawal waiver column
// existed, and db-restore.sh runs `prisma db migrate` on the restored dump, so
// every schema a backup can be at needs a migration path to the contract.
const backedUpSchemas = {
    "before the withdrawal waiver":
        "d7d041a2cacd34b2a9695ea8115b3b4fe1d1c4c75e90c1d8cd370a6ad66a7062",
    "before session details":
        "491b34cb2e0440598e17329e28ce57d484e36bf2cbbf5cf6e72741874b3bf1e3",
};

it.each(Object.entries(backedUpSchemas))(
    "migrates a backup taken %s to the contract",
    (_, start) => {
        const edges = new Map<string | null, string>();
        for (const dir of readdirSync(
            new URL("../../migrations/app/", import.meta.url),
        )) {
            const { from, to } = read(
                `../../migrations/app/${dir}/migration.json`,
            );
            edges.set(from, to);
        }
        const target: string = read("../../src/prisma/contract.json").storage
            .storageHash;
        expect(target).toMatch(/^[0-9a-f]{64}$/);
        const seen = new Set<string>();
        let hash: string | undefined = start;
        while (hash && hash !== target && !seen.has(hash)) {
            seen.add(hash);
            hash = edges.get(hash);
        }
        expect(hash).toBe(target);
    },
);
