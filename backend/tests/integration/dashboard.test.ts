import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { db } from "../../src/prisma/db.js";
import { MAX_CHART_POINTS, MAX_HOSTS } from "../../src/routes/dashboard.js";

const app = createApp();
const userIds = new Set<number>();
afterEach(async () => {
    for (const id of userIds) await db.orm.public.User.where({ id }).delete();
    userIds.clear();
});
afterAll(() => db.close());
async function account(verified = true, licensed = true) {
    const now = new Date().toISOString();
    const user = await db.orm.public.User.create({
        email: `dashboard-${randomUUID()}@example.com`,
        emailVerifiedAt: verified ? now : null,
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
const get = (cookie: string, id: number | string, path: string) =>
    app.request(`/api/datasets/${id}/${path}`, { headers: { cookie } });
async function dataset(ownerId: number, name = "Metrics") {
    return db.orm.public.Dataset.create({ ownerId, name });
}
async function reading(
    datasetId: number,
    host: string,
    timestamp: string,
    cpuPercent = 20,
) {
    return db.orm.public.Metric.create({
        datasetId,
        host,
        timestamp,
        cpuPercent,
        ramPercent: 30,
        diskPercent: 40,
        netInMbps: 5.5,
        netOutMbps: 1.25,
    });
}
describe("dashboard authorization", () => {
    it.each([
        ["anonymous", false, false, 401],
        ["unverified", false, true, 403],
        ["unlicensed", true, false, 402],
    ] as const)(
        "rejects %s access",
        async (name, verified, licensed, status) => {
            const cookie =
                name === "anonymous"
                    ? ""
                    : (await account(verified, licensed)).cookie;
            for (const path of ["hosts", "metrics?host=web"])
                expect((await get(cookie, 1, path)).status).toBe(status);
        },
    );
    it("hides other owners' datasets and invalid ids", async () => {
        const owner = await account(),
            other = await account();
        const d = await dataset(owner.id);
        await reading(d.id, "secret", "2026-09-01T00:00:00Z");
        for (const id of [
            d.id,
            "abc",
            "0",
            "99999999999",
            `0x${d.id.toString(16)}`,
            `${d.id}.0`,
        ]) {
            for (const path of ["hosts", "metrics?host=secret"])
                expect((await get(other.cookie, id, path)).status).toBe(404);
        }
        expect(
            (await (await get(owner.cookie, d.id, "hosts")).json()).hosts,
        ).toEqual(["secret"]);
    });
});
describe("dashboard selection", () => {
    it("selects the dataset, literal host and range relative to imported data, in timestamp order", async () => {
        const user = await account();
        const d = await dataset(user.id),
            other = await dataset(user.id, "Other");
        const host = "web'_%<&";
        await reading(d.id, host, "2026-09-10T12:00:00Z", 91);
        await reading(d.id, host, "2026-09-01T00:00:00Z", 2);
        await reading(d.id, host, "2026-09-10T11:00:00Z", 42);
        await reading(d.id, "other-host", "2026-10-01T00:00:00Z", 99);
        await reading(other.id, host, "2026-10-01T00:00:00Z", 88);
        const response = await get(
            user.cookie,
            d.id,
            `metrics?${new URLSearchParams({ host, range: "1h" })}`,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const body = await response.json();
        expect(body).toMatchObject({
            datasetId: d.id,
            host,
            range: "1h",
            total: 2,
            sampling: "none",
            latest: {
                timestamp: "2026-09-10T12:00:00.000Z",
                cpuPercent: 91,
                ramPercent: 30,
                diskPercent: 40,
                netInMbps: 5.5,
                netOutMbps: 1.25,
            },
        });
        expect(
            body.points.map((p: { cpuPercent: number }) => p.cpuPercent),
        ).toEqual([42, 91]);
        expect(
            (
                await (
                    await get(
                        user.cookie,
                        d.id,
                        `metrics?${new URLSearchParams({ host })}`,
                    )
                ).json()
            ).total,
        ).toBe(3);
        expect(
            (await (await get(user.cookie, d.id, "hosts?q=%25")).json()).hosts,
        ).toEqual([host]);
    });
    it("handles empty and single-reading datasets, and validates requests", async () => {
        const user = await account();
        const d = await dataset(user.id);
        expect(
            (await (await get(user.cookie, d.id, "hosts")).json()).hosts,
        ).toEqual([]);
        expect(
            await (await get(user.cookie, d.id, "metrics?host=missing")).json(),
        ).toMatchObject({
            points: [],
            latest: null,
            total: 0,
            sampling: "none",
        });
        await reading(d.id, "one", "2026-09-01T00:00:00Z");
        const body = await (
            await get(user.cookie, d.id, "metrics?host=one&range=24h")
        ).json();
        expect(body.points).toHaveLength(1);
        expect(body.latest).toEqual(body.points[0]);
        for (const path of [
            "metrics",
            "metrics?host=one&range=bogus",
            "metrics?host=one&range=__proto__",
            `hosts?q=${"a".repeat(256)}`,
        ])
            expect((await get(user.cookie, d.id, path)).status).toBe(400);
    });
    it("bounds host lists and supports finding hosts beyond the first page", async () => {
        const user = await account();
        const d = await dataset(user.id);
        await db.transaction((tx) =>
            tx.execute(
                db.raw
                    .sql`INSERT INTO "Metric" ("datasetId", host, timestamp, "cpuPercent", "ramPercent", "diskPercent", "netInMbps", "netOutMbps") SELECT ${d.id}, 'host-' || lpad(i::text, 3, '0'), '2026-09-01'::timestamptz, 1, 2, 3, 4, 5 FROM generate_series(1, 105) i`
                    .affectedCount()
                    .build(),
            ),
        );
        const body = await (await get(user.cookie, d.id, "hosts")).json();
        expect(body.hosts).toHaveLength(MAX_HOSTS);
        expect(body.hasMore).toBe(true);
        // An exact host must remain reachable even if 100 earlier-sorting
        // hostnames contain it as a substring.
        await reading(d.id, "ost", "2026-09-01T00:00:00Z");
        const exact = await (
            await get(user.cookie, d.id, "hosts?q=ost")
        ).json();
        expect(exact.hosts[0]).toBe("ost");
        expect(exact.hosts).toHaveLength(MAX_HOSTS);

        expect(
            await (await get(user.cookie, d.id, "hosts?q=105")).json(),
        ).toEqual({ hosts: ["host-105"], hasMore: false });
    });
    it("keeps a 500,000-row history bounded, preserving exact endpoints and values", async () => {
        const user = await account();
        const d = await dataset(user.id);
        await db.transaction((tx) =>
            tx.execute(
                db.raw
                    .sql`INSERT INTO "Metric" ("datasetId", host, timestamp, "cpuPercent", "ramPercent", "diskPercent", "netInMbps", "netOutMbps") SELECT ${d.id}, 'large', '2026-01-01'::timestamptz + i * interval '1 second', i % 100, 2, 3, i::double precision, 5 FROM generate_series(0, 499999) i`
                    .affectedCount()
                    .build(),
            ),
        );
        const response = await get(user.cookie, d.id, "metrics?host=large");
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.total).toBe(500000);
        expect(body.sampling).toBe("uniform-rows");
        expect(body.points.length).toBeLessThanOrEqual(MAX_CHART_POINTS);
        expect(body.points[0]).toMatchObject({
            timestamp: "2026-01-01T00:00:00.000Z",
            netInMbps: 0,
        });
        expect(body.latest).toMatchObject({
            netInMbps: 499999,
            cpuPercent: 99,
        });
        expect(body.latest).toEqual(body.points.at(-1));
        expect(JSON.stringify(body).length).toBeLessThan(150000);
    }, 30000);
});
