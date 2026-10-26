import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { deleteExpiredRows } from "../../src/cleanup.js";
import { db } from "../../src/prisma/db.js";

const userIds = new Set<number>();

afterEach(async () => {
    for (const id of userIds) await db.orm.public.User.where({ id }).delete();
    userIds.clear();
});
afterAll(async () => {
    await db.close();
});

describe("expired row cleanup", () => {
    it("deletes expired sessions and links and keeps current ones", async () => {
        const email = `cleanup-${randomUUID()}@example.com`;
        const user = await db.orm.public.User.create({
            email,
            passwordHash: null,
        });
        userIds.add(user.id);
        const expired = new Date(Date.now() - 1000).toISOString();
        const current = new Date(Date.now() + 60_000).toISOString();
        for (const [suffix, expiresAt] of [
            ["old", expired],
            ["new", current],
        ] as const) {
            const id = `${randomUUID()}-${suffix}`;
            const row = { userId: user.id, expiresAt };
            await db.orm.public.Session.create({ id, ...row });
            await db.orm.public.EmailVerification.create({
                tokenHash: id,
                email,
                ...row,
            });
            await db.orm.public.PasswordReset.create({
                tokenHash: id,
                email,
                ...row,
            });
        }

        const deleted = await deleteExpiredRows();
        expect(deleted.sessions).toBeGreaterThanOrEqual(1);
        expect(deleted.verifications).toBeGreaterThanOrEqual(1);
        expect(deleted.resets).toBeGreaterThanOrEqual(1);

        const where = { userId: user.id };
        for (const rows of [
            await db.orm.public.Session.where(where).all(),
            await db.orm.public.EmailVerification.where(where).all(),
            await db.orm.public.PasswordReset.where(where).all(),
        ]) {
            expect(rows).toHaveLength(1);
            expect(new Date(rows[0]!.expiresAt).getTime()).toBe(
                new Date(current).getTime(),
            );
        }
    });
});
