import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { db } from "../../src/prisma/db.js";
import {
    MAX_CHART_POINTS,
    MAX_HISTORY_BUCKETS,
    MAX_HOSTS,
} from "../../src/routes/dashboard.js";

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
            for (const path of [
                "hosts",
                "metrics?host=web",
                "stats?host=web",
                "history?host=web",
            ])
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
            for (const path of [
                "hosts",
                "metrics?host=secret",
                "stats?host=secret",
                "history?host=secret",
            ])
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
describe("dashboard analytics", () => {
    const query = (params: Record<string, string>) =>
        new URLSearchParams(params).toString();

    it("returns min, avg, max, p95 and threshold shares for the selected range", async () => {
        const user = await account();
        const d = await dataset(user.id),
            other = await dataset(user.id, "Other");
        // 20 readings a minute apart: CPU 5, 10, ..., 100; RAM 81; net in 1..20.
        await db.transaction((tx) =>
            tx.execute(
                db.raw
                    .sql`INSERT INTO "Metric" ("datasetId", host, timestamp, "cpuPercent", "ramPercent", "diskPercent", "netInMbps", "netOutMbps") SELECT ${d.id}, 'web', '2026-09-10T12:00:00Z'::timestamptz + i * interval '1 minute', i * 5, 81, 40, i, i * 0.5 FROM generate_series(1, 20) i`
                    .affectedCount()
                    .build(),
            ),
        );
        await reading(d.id, "web", "2026-09-08T00:00:00Z", 0);
        await reading(d.id, "other-host", "2026-09-10T12:10:00Z", 99);
        await reading(other.id, "web", "2026-09-10T12:10:00Z", 99);
        const response = await get(
            user.cookie,
            d.id,
            `stats?${query({ host: "web", range: "1h" })}`,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const body = await response.json();
        expect(body).toMatchObject({
            datasetId: d.id,
            host: "web",
            range: "1h",
            from: "2026-09-10T12:01:00.000Z",
            to: "2026-09-10T12:20:00.000Z",
        });
        const { cpuPercent, ramPercent, diskPercent, netInMbps, netOutMbps } =
            body.metrics;
        expect(cpuPercent).toMatchObject({
            count: 20,
            min: 5,
            max: 100,
            shareAbove80: 0.2,
            shareAbove90: 0.1,
        });
        expect(cpuPercent.avg).toBeCloseTo(52.5, 10);
        // percentile_cont: 95 + 0.05 * (100 - 95)
        expect(cpuPercent.p95).toBeCloseTo(95.25, 10);
        expect(ramPercent).toMatchObject({
            min: 81,
            max: 81,
            shareAbove80: 1,
            shareAbove90: 0,
        });
        expect(diskPercent).toMatchObject({ p95: 40, shareAbove80: 0 });
        expect(netInMbps).toEqual({
            count: 20,
            min: 1,
            avg: 10.5,
            max: 20,
            p95: expect.closeTo(19.05, 10),
        });
        expect(netOutMbps).toMatchObject({ min: 0.5, max: 10 });
        expect(netOutMbps).not.toHaveProperty("shareAbove80");

        const all = await (
            await get(user.cookie, d.id, `stats?${query({ host: "web" })}`)
        ).json();
        expect(all.range).toBe("all");
        expect(all.from).toBe("2026-09-08T00:00:00.000Z");
        expect(all.metrics.cpuPercent).toMatchObject({ count: 21, min: 0 });
    });
    it("returns empty stats for a host without readings", async () => {
        const user = await account();
        const d = await dataset(user.id);
        const body = await (
            await get(user.cookie, d.id, "stats?host=missing&range=24h")
        ).json();
        expect(body).toMatchObject({ from: null, to: null });
        expect(body.metrics.cpuPercent).toEqual({
            count: 0,
            min: null,
            avg: null,
            max: null,
            p95: null,
            shareAbove80: null,
            shareAbove90: null,
        });
        expect(body.metrics.netInMbps).toEqual({
            count: 0,
            min: null,
            avg: null,
            max: null,
            p95: null,
        });
    });
    it("aggregates history per bucket and keeps empty buckets", async () => {
        const user = await account();
        const d = await dataset(user.id);
        for (const [timestamp, cpu] of [
            ["2026-09-01T00:00:00Z", 10],
            ["2026-09-01T00:05:00Z", 20],
            ["2026-09-01T00:10:00Z", 30],
            // nothing between 00:10 and 02:00
            ["2026-09-01T02:00:00Z", 50],
            ["2026-09-01T02:30:00Z", 70],
        ] as const)
            await reading(d.id, "gappy", timestamp, cpu);
        const response = await get(
            user.cookie,
            d.id,
            `history?${query({ host: "gappy", bucket: "1h" })}`,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const body = await response.json();
        expect(body).toMatchObject({
            datasetId: d.id,
            host: "gappy",
            range: "all",
            bucket: "1h",
            from: "2026-09-01T00:00:00.000Z",
            to: "2026-09-01T02:30:00.000Z",
            maxBuckets: MAX_HISTORY_BUCKETS,
        });
        expect(body.buckets).toEqual([
            {
                start: "2026-09-01T00:00:00.000Z",
                count: 3,
                cpuPercent: { avg: 20, max: 30 },
                ramPercent: { avg: 30, max: 30 },
                diskPercent: { avg: 40, max: 40 },
                netInMbps: { avg: 5.5, max: 5.5 },
                netOutMbps: { avg: 1.25, max: 1.25 },
            },
            {
                start: "2026-09-01T01:00:00.000Z",
                count: 0,
                cpuPercent: { avg: null, max: null },
                ramPercent: { avg: null, max: null },
                diskPercent: { avg: null, max: null },
                netInMbps: { avg: null, max: null },
                netOutMbps: { avg: null, max: null },
            },
            {
                start: "2026-09-01T02:00:00.000Z",
                count: 2,
                cpuPercent: { avg: 60, max: 70 },
                ramPercent: { avg: 30, max: 30 },
                diskPercent: { avg: 40, max: 40 },
                netInMbps: { avg: 5.5, max: 5.5 },
                netOutMbps: { avg: 1.25, max: 1.25 },
            },
        ]);

        // The finest bucket that fits is the default for the full history.
        const fine = await (
            await get(user.cookie, d.id, "history?host=gappy")
        ).json();
        expect(fine.bucket).toBe("5m");
        expect(fine.buckets).toHaveLength(31);
        expect(
            fine.buckets.filter((b: { count: number }) => b.count > 0),
        ).toHaveLength(5);
        expect(fine.buckets[3]).toMatchObject({
            start: "2026-09-01T00:15:00.000Z",
            count: 0,
        });

        // Ranges end at the host's last reading; partial buckets are aligned to the clock.
        const recent = await (
            await get(
                user.cookie,
                d.id,
                `history?${query({ host: "gappy", range: "1h", bucket: "1h" })}`,
            )
        ).json();
        expect(recent.from).toBe("2026-09-01T02:00:00.000Z");
        expect(recent.buckets).toEqual([
            expect.objectContaining({
                start: "2026-09-01T02:00:00.000Z",
                count: 2,
            }),
        ]);

        for (const [range, bucket] of [
            ["1h", "5m"],
            ["24h", "5m"],
            ["7d", "1h"],
            ["30d", "1h"],
        ])
            expect(
                (
                    await (
                        await get(
                            user.cookie,
                            d.id,
                            `history?${query({ host: "gappy", range })}`,
                        )
                    ).json()
                ).bucket,
            ).toBe(bucket);

        expect(
            await (
                await get(user.cookie, d.id, "history?host=missing&range=7d")
            ).json(),
        ).toMatchObject({ bucket: "1h", from: null, to: null, buckets: [] });
    });
    it("rejects invalid buckets and requests over the bucket limit", async () => {
        const user = await account();
        const d = await dataset(user.id);
        await reading(d.id, "long", "2026-01-01T00:00:00Z");
        await reading(d.id, "long", "2026-03-01T00:00:00Z");
        await reading(d.id, "ancient", "2019-01-01T00:00:00Z");
        await reading(d.id, "ancient", "2026-01-01T00:00:00Z");
        for (const path of [
            "history",
            "history?host=long&range=bogus",
            "history?host=long&bucket=1w",
            "history?host=long&bucket=__proto__",
            "history?host=long&bucket=",
            `stats?range=24h`,
            `stats?host=${"a".repeat(256)}`,
            "stats?host=long&range=__proto__",
        ])
            expect((await get(user.cookie, d.id, path)).status).toBe(400);
        for (const [path, buckets] of [
            ["history?host=long&range=7d&bucket=5m", 2017],
            ["history?host=long&range=30d&bucket=5m", 8641],
            // 59 days of 5-minute buckets
            ["history?host=long&bucket=5m", 16993],
            // more than 2000 days even with daily buckets
            ["history?host=ancient", 2558],
        ] as const) {
            const response = await get(user.cookie, d.id, path);
            expect(response.status).toBe(400);
            const body = await response.json();
            expect(body).toMatchObject({
                buckets,
                maxBuckets: MAX_HISTORY_BUCKETS,
            });
            expect(body.error).toMatch(/Choose a larger bucket/);
        }
        const fallback = await (
            await get(user.cookie, d.id, "history?host=long")
        ).json();
        expect(fallback.bucket).toBe("1h");
        expect(fallback.buckets).toHaveLength(59 * 24 + 1);
        expect(
            (
                await get(
                    user.cookie,
                    d.id,
                    "history?host=long&range=7d&bucket=1h",
                )
            ).status,
        ).toBe(200);
    });
});
