import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";
import { testEnvironment } from "../tests/environment.mjs";

export default definePrismaConfig({
    orm: ormConfig({
        contract: "./src/prisma/contract.prisma",
        migrations: { dir: "../.test-cache/prisma/migrations" },
        db: { connection: testEnvironment().DATABASE_URL },
    }),
});
