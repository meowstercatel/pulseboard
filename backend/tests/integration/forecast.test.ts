import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { sessionIdFor } from "../../src/auth/session.js";
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
        email: `forecast-${randomUUID()}@example.com`,
        emailVerifiedAt: now,
        licensePlan: licensed ? "lifetime" : null,
        licensedAt: licensed ? now : null,
    });
    userIds.add(user.id);
    const token = randomBytes(32).toString("base64url");
    await db.orm.public.Session.create({
        id: sessionIdFor(token),
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
const forecast = (
    cookie: string,
    id: number | string,
    query: Record<string, string>,
) =>
    app.request(`/api/datasets/${id}/forecast?${new URLSearchParams(query)}`, {
        headers: { cookie },
    });

describe("forecast", () => {
    it("finds the disk growth in servers-30d", async () => {
        const user = await account();
        const id = await imported(user.cookie, "servers-30d.csv");
        const response = await forecast(user.cookie, id, {
            host: "web-01",
            metric: "diskPercent",
            horizon: "30d",
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const body = await response.json();
        expect(body).toMatchObject({
            datasetId: id,
            host: "web-01",
            metric: "diskPercent",
            horizon: "30d",
            bucket: "1h",
            history: {
                from: "2026-09-01T00:00:00.000Z",
                to: "2026-09-30T23:00:00.000Z",
                buckets: 720,
                observedBuckets: 720,
                days: 30,
            },
            backtest: {
                method: "holdout",
                origins: 1,
                holdoutHours: 360,
                holdoutShorterThanHorizon: true,
            },
            band: { level: 0.8, method: "backtest-residual-quantiles" },
            note: "Forecasts are estimates, not a guarantee.",
        });
        expect(
            body.backtest.scores.map((s: { model: string }) => s.model),
        ).toEqual(["linear-trend", "hour-of-week-trend", "holt-winters"]);
        for (const score of body.backtest.scores) {
            expect(score.skipped).toBeNull();
            expect(score.points).toBe(360);
            expect(score.mae).toBeGreaterThan(0);
            expect(score.mape).toBeGreaterThan(0);
        }
        const best = Math.min(
            ...body.backtest.scores.map((s: { mae: number }) => s.mae),
        );
        expect(
            body.backtest.scores.find(
                (s: { model: string }) => s.model === body.model,
            ).mae,
        ).toBe(best);

        const points = body.points;
        expect(points).toHaveLength(720);
        expect(points[0].timestamp).toBe("2026-10-01T00:00:00.000Z");
        expect(points.at(-1).timestamp).toBe("2026-10-30T23:00:00.000Z");
        // disk keeps growing: the last week sits well above the first
        const weekMean = (from: number) =>
            points
                .slice(from, from + 168)
                .reduce((s: number, p: { value: number }) => s + p.value, 0) /
            168;
        expect(weekMean(552) - weekMean(0)).toBeGreaterThan(5);
        for (const p of points) {
            expect(p.lower).toBeLessThanOrEqual(p.upper);
            expect(p.value).toBeGreaterThanOrEqual(0);
            expect(p.value).toBeLessThanOrEqual(100);
        }
        const [at80, at90, at100] = body.thresholds;
        expect(at80).toMatchObject({ percent: 80, alreadyAbove: false });
        expect(Date.parse(at80.crossesAt)).toBeGreaterThan(
            Date.parse(points[0].timestamp),
        );
        expect(at100).toEqual({
            percent: 100,
            crossesAt: null,
            alreadyAbove: false,
        });
        expect(at90.percent).toBe(90);
    });

    it("backtests 24h from rolling origins and 7d on a full-length holdout", async () => {
        const user = await account();
        const id = await imported(user.cookie, "servers-30d.csv");
        const day = await (
            await forecast(user.cookie, id, {
                host: "db-01",
                metric: "cpuPercent",
                horizon: "24h",
            })
        ).json();
        expect(day.points).toHaveLength(24);
        expect(day.backtest).toMatchObject({
            method: "rolling-origin",
            origins: 7,
            holdoutHours: 168,
            holdoutShorterThanHorizon: false,
        });
        const week = await (
            await forecast(user.cookie, id, {
                host: "db-01",
                metric: "netInMbps",
                horizon: "7d",
            })
        ).json();
        expect(week.points).toHaveLength(168);
        expect(week.thresholds).toBeNull();
        expect(week.backtest).toMatchObject({
            method: "holdout",
            holdoutHours: 168,
            holdoutShorterThanHorizon: false,
        });
    });

    it("needs 14 days of readings", async () => {
        const user = await account();
        const id = await imported(user.cookie, "excel-pl-7d.csv");
        const response = await forecast(user.cookie, id, {
            host: "app-01",
            metric: "diskPercent",
            horizon: "7d",
        });
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({
            error: "Forecasting needs at least 14 days of readings for this host; it has 7.0.",
            days: 7,
            requiredDays: 14,
        });
        // an unknown host has no readings at all
        const none = await forecast(user.cookie, id, {
            host: "missing",
            metric: "diskPercent",
            horizon: "7d",
        });
        expect(none.status).toBe(422);
        expect((await none.json()).days).toBe(0);
    });

    it("requires a license", async () => {
        const user = await account(false);
        const response = await forecast(user.cookie, 1, {
            host: "web-01",
            metric: "diskPercent",
            horizon: "7d",
        });
        expect(response.status).toBe(402);
    });

    it("hides other owners' datasets", async () => {
        const owner = await account(),
            other = await account();
        const id = await imported(owner.cookie, "servers-30d.csv");
        const response = await forecast(other.cookie, id, {
            host: "web-01",
            metric: "diskPercent",
            horizon: "7d",
        });
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
    });

    it.each<Record<string, string>>([
        { metric: "diskPercent", horizon: "7d" },
        { host: "web-01", metric: "diskPercent" },
        { host: "web-01", metric: "diskPercent", horizon: "1h" },
        { host: "web-01", metric: "timestamp", horizon: "7d" },
        { host: "web-01", metric: "toString", horizon: "7d" },
        { host: "x".repeat(256), metric: "diskPercent", horizon: "7d" },
    ])("rejects %o", async (query) => {
        const user = await account();
        const id = await imported(user.cookie, "excel-pl-7d.csv");
        const response = await forecast(user.cookie, id, query);
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe(
            "Choose a host, a metric and a horizon of 24h, 7d or 30d",
        );
    });
});
