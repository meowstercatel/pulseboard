import { Hono } from "hono";
import { requireAuth, requireLicense, type AuthEnv } from "../auth/session.js";
import { db } from "../prisma/db.js";

export const MAX_CHART_POINTS = 600;
export const MAX_HOSTS = 100;
const ranges: Record<string, number> = {
    "1h": 3600000,
    "24h": 86400000,
    "7d": 604800000,
    "30d": 2592000000,
};
export const dashboard = new Hono<AuthEnv>();
dashboard.use(requireAuth, requireLicense);
dashboard.use("/:id/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const param = c.req.param("id")!;
    const id = /^\d{1,10}$/.test(param) ? Number(param) : 0;
    if (
        id <= 0 ||
        id > 2147483647 ||
        !(await db.orm.public.Dataset.where({
            id,
            ownerId: c.get("user").id,
        }).first())
    ) {
        return c.json({ error: "Dataset not found" }, 404);
    }
    await next();
});

dashboard.get("/:id/hosts", async (c) => {
    const id = Number(c.req.param("id"));
    const search = c.req.query("q") ?? "";
    if (search.length > 255)
        return c.json({ error: "Host search is too long" }, 400);
    // Literal substring search: SQL wildcard characters in CSV hostnames are not patterns.
    const plan = db.raw.sql`SELECT host FROM (
            SELECT DISTINCT host FROM "Metric"
            WHERE "datasetId" = ${id} AND strpos(lower(host), lower(${search})) > 0
        ) matches
        ORDER BY (host = ${search}) DESC, host LIMIT ${MAX_HOSTS + 1}`
        .returnsRow({ host: "pg/text@1" })
        .build();
    const hosts: string[] = [];
    for await (const row of db.runtime().query(plan)) hosts.push(row.host);
    return c.json({
        hosts: hosts.slice(0, MAX_HOSTS),
        hasMore: hosts.length > MAX_HOSTS,
    });
});

dashboard.get("/:id/metrics", async (c) => {
    const id = Number(c.req.param("id"));
    const host = c.req.query("host");
    const range = c.req.query("range") ?? "all";
    if (
        !host ||
        host.length > 255 ||
        (range !== "all" && !Object.hasOwn(ranges, range))
    ) {
        return c.json({ error: "Choose a host and a valid time range" }, 400);
    }
    // Query-side sampling keeps application memory and responses bounded. Both ends
    // are retained; ordering by id makes duplicate timestamps deterministic.
    const windowMs = ranges[range] ?? 0;
    const plan = db.raw.sql`
        WITH bounds AS (
            SELECT max(timestamp) AS last FROM "Metric" WHERE "datasetId" = ${id} AND host = ${host}
        ), readings AS (
            SELECT m.*, row_number() OVER (ORDER BY timestamp, id) AS rn,
                count(*) OVER () AS total
            FROM "Metric" m WHERE "datasetId" = ${id} AND host = ${host}
                AND (${range} = 'all' OR timestamp >=
                    (SELECT last FROM bounds) - ${windowMs}::double precision * interval '1 millisecond')
        )
        SELECT timestamp::text AS timestamp, "cpuPercent", "ramPercent", "diskPercent", "netInMbps", "netOutMbps",
            total::integer AS total
        FROM readings
        WHERE mod(rn - 1, greatest(1, ceil((total - 1)::numeric / ${MAX_CHART_POINTS - 1})::bigint)) = 0 OR rn = total
        ORDER BY timestamp::timestamptz, id
        LIMIT ${MAX_CHART_POINTS}`
        .returnsRow({
            timestamp: "pg/text@1",
            cpuPercent: "pg/float8@1",
            ramPercent: "pg/float8@1",
            diskPercent: "pg/float8@1",
            netInMbps: "pg/float8@1",
            netOutMbps: "pg/float8@1",
            total: "pg/int4@1",
        })
        .build();
    const points = [];
    let total = 0;
    for await (const row of db.runtime().query(plan)) {
        total = row.total;
        const { total: _, ...values } = row;
        points.push({
            ...values,
            timestamp: new Date(row.timestamp).toISOString(),
        });
    }
    return c.json({
        datasetId: id,
        host,
        range,
        total,
        points,
        latest: points.at(-1) ?? null,
        sampling: total > points.length ? "uniform-rows" : "none",
        maxPoints: MAX_CHART_POINTS,
    });
});
