import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { db } from "../../src/prisma/db.js";

const app = createApp();
const userIds = new Set<number>();
// what the browser sends with uploads, so CSRF checks pass
const origin = process.env["PUBLIC_URL"]!;
afterEach(async () => {
    for (const id of userIds) await db.orm.public.User.where({ id }).delete();
    userIds.clear();
});
afterAll(() => db.close());
async function account(licensed = true) {
    const now = new Date().toISOString();
    const user = await db.orm.public.User.create({
        email: `capacity-${randomUUID()}@example.com`,
        emailVerifiedAt: now,
        licensePlan: licensed ? "lifetime" : null,
        licensedAt: licensed ? now : null,
    });
    userIds.add(user.id);
    const token = randomBytes(32).toString("base64url");
    await db.orm.public.Session.create({
        id: token,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    return { id: user.id, cookie: `session=${token}` };
}
// Imports a sample through the real upload, like a user would.
async function imported(cookie: string, name: string): Promise<number> {
    const form = new FormData();
    form.set(
        "file",
        new File(
            [
                readFileSync(
                    new URL(`../../../samples/${name}`, import.meta.url),
                ),
            ],
            name,
            { type: "text/csv" },
        ),
    );
    const response = await app.request("/api/datasets", {
        method: "POST",
        headers: { cookie, origin },
        body: form,
    });
    expect(response.status).toBe(201);
    return (await response.json()).dataset.id;
}
const capacity = (cookie: string, id: number | string) =>
    app.request(`/api/datasets/${id}/capacity`, { headers: { cookie } });

type Row = {
    host: string;
    metric: string;
    model?: string;
    latest?: number;
    thresholds?: {
        percent: number;
        crossesAt: string | null;
        alreadyAbove: boolean;
    }[];
    insufficient?: { days: number; requiredDays: number };
};

describe("capacity", () => {
    it("forecasts disk and RAM for every host, soonest first", async () => {
        const user = await account();
        const id = await imported(user.cookie, "servers-30d.csv");
        const response = await capacity(user.cookie, id);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const body = await response.json();
        expect(body).toMatchObject({
            datasetId: id,
            horizon: "30d",
            thresholds: [80, 90, 100],
            note: "Forecasts are estimates, not a guarantee.",
        });
        const rows: Row[] = body.rows;
        expect(rows.map((r) => `${r.host} ${r.metric}`).sort()).toEqual([
            "db-01 diskPercent",
            "db-01 ramPercent",
            "web-01 diskPercent",
            "web-01 ramPercent",
            "web-02 diskPercent",
            "web-02 ramPercent",
        ]);
        for (const row of rows) {
            expect(row.insufficient).toBeUndefined();
            expect(row.thresholds!.map((t) => t.percent)).toEqual([
                80, 90, 100,
            ]);
            expect(row.latest).toBeGreaterThan(0);
        }

        // the same crossings /forecast reports for that host and metric
        const single = await (
            await app.request(
                `/api/datasets/${id}/forecast?host=web-01&metric=diskPercent&horizon=30d`,
                { headers: { cookie: user.cookie } },
            )
        ).json();
        const web01 = rows.find(
            (r) => r.host === "web-01" && r.metric === "diskPercent",
        )!;
        expect(web01.model).toBe(single.model);
        expect(web01.thresholds).toEqual(single.thresholds);
        expect(web01.thresholds![0]!.crossesAt).not.toBeNull();

        // a row that crosses 80% comes before one that crosses nothing, and
        // rows crossing the same thresholds are ordered by when
        const at = (row: Row, percent: number) => {
            const t = row.thresholds!.find((t) => t.percent === percent)!;
            return t.alreadyAbove
                ? 0
                : t.crossesAt === null
                  ? Infinity
                  : Date.parse(t.crossesAt);
        };
        for (let i = 1; i < rows.length; i++) {
            const key = (r: Row) => [at(r, 100), at(r, 90), at(r, 80)];
            const [a, b] = [key(rows[i - 1]!), key(rows[i]!)];
            const k = a.findIndex((v, j) => v !== b[j]);
            if (k >= 0) expect(a[k]).toBeLessThan(b[k]!);
        }
        const crossing = rows.filter((r) => at(r, 80) !== Infinity);
        expect(crossing.length).toBeGreaterThan(0);
        expect(rows.slice(0, crossing.length)).toEqual(crossing);
        // RAM has no trend: it stays well below 80% in this sample
        for (const row of rows.filter((r) => r.metric === "ramPercent"))
            expect(at(row, 80)).toBe(Infinity);
    });

    it("lists hosts with under 14 days of readings as too short", async () => {
        const user = await account();
        const id = await imported(user.cookie, "excel-pl-7d.csv");
        const response = await capacity(user.cookie, id);
        expect(response.status).toBe(200);
        expect((await response.json()).rows).toEqual([
            {
                host: "app-01",
                metric: "diskPercent",
                insufficient: { days: 7, requiredDays: 14 },
            },
            {
                host: "app-01",
                metric: "ramPercent",
                insufficient: { days: 7, requiredDays: 14 },
            },
        ]);
    });

    it("requires a license", async () => {
        const user = await account(false);
        expect((await capacity(user.cookie, 1)).status).toBe(402);
    });

    it("answers 404 for another user's dataset", async () => {
        const owner = await account(),
            other = await account();
        const id = await imported(owner.cookie, "servers-30d.csv");
        const response = await capacity(other.cookie, id);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "Dataset not found" });
        expect(response.headers.get("cache-control")).toBe("private, no-store");
    });
});
