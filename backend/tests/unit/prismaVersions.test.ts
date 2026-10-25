import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) =>
    JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const manifest = (name: string) =>
    read(`../../node_modules/${name}/package.json`);

// The two packages are released separately, so their version numbers differ.
// What has to match is the toolchain the CLI plans migrations with and the one
// the runtime ships; bump both together.
it("pins the Prisma CLI to the runtime's toolchain", () => {
    const runtime = manifest("@prisma/orm-postgres");
    const cli = manifest("prisma");
    expect(cli.dependencies["@prisma/orm-toolchain"]).toBe(
        runtime.dependencies["@prisma/orm-toolchain"],
    );
    // exact versions, so a fresh install can't pick up a different RC
    const pinned = read("../../package.json");
    for (const name of ["@prisma/orm-postgres", "prisma"]) {
        const version =
            pinned.dependencies[name] ?? pinned.devDependencies[name];
        expect(version, name).toMatch(/^\d/);
    }
});
