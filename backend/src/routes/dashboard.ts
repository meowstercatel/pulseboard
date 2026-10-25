import { Hono } from "hono";
import { requireAuth, requireLicense, type AuthEnv } from "../auth/session.js";
import { db } from "../prisma/db.js";
import {
    forecast,
    HOUR_MS,
    InsufficientHistory,
    MIN_DAYS,
    observedDays,
} from "../forecast/index.js";

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

export const MAX_HISTORY_BUCKETS = 2000;
const buckets: Record<string, number> = {
    "5m": 300000,
    "1h": 3600000,
    "1d": 86400000,
};
const defaultBuckets: Record<string, string> = {
    "1h": "5m",
    "24h": "5m",
    "7d": "1h",
    "30d": "1h",
};
// metric -> SQL column alias prefix
const prefixes = {
    cpuPercent: "cpu",
    ramPercent: "ram",
    diskPercent: "disk",
    netInMbps: "netIn",
    netOutMbps: "netOut",
};
const percent = (prefix: string) => !prefix.startsWith("net");
const nullableFloat = { codecId: "pg/float8@1", nullable: true } as const;
const nullableText = { codecId: "pg/text@1", nullable: true } as const;
const isoOrNull = (value: unknown) =>
    value === null ? null : new Date(value as string).toISOString();

function selection(c: { req: { query(name: string): string | undefined } }) {
    const host = c.req.query("host");
    const range = c.req.query("range") ?? "all";
    if (
        !host ||
        host.length > 255 ||
        (range !== "all" && !Object.hasOwn(ranges, range))
    )
        return null;
    return { host, range };
}

// The same readings /metrics charts: one host, the range ending at its last timestamp.
function readings(id: number, host: string, range: string) {
    const windowMs = ranges[range] ?? 0;
    return db.raw
        .sql`SELECT timestamp, "cpuPercent", "ramPercent", "diskPercent", "netInMbps", "netOutMbps"
        FROM "Metric" WHERE "datasetId" = ${id} AND host = ${host}
            AND (${range} = 'all' OR timestamp >= (
                SELECT max(timestamp) FROM "Metric" WHERE "datasetId" = ${id} AND host = ${host}
            ) - ${windowMs}::double precision * interval '1 millisecond')`.returnsRow(
        {
            timestamp: "pg/timestamptz-string@1",
            cpuPercent: "pg/float8@1",
            ramPercent: "pg/float8@1",
            diskPercent: "pg/float8@1",
            netInMbps: "pg/float8@1",
            netOutMbps: "pg/float8@1",
        },
    );
}

dashboard.get("/:id/stats", async (c) => {
    const id = Number(c.req.param("id"));
    const selected = selection(c);
    if (!selected)
        return c.json({ error: "Choose a host and a valid time range" }, 400);
    const { host, range } = selected;
    // One wide row: five sorts for the percentiles are much cheaper than
    // unpivoting. percentile_cont interpolates between neighbouring readings.
    const plan = db.raw.sql`
        WITH readings AS (${readings(id, host, range)})
        SELECT count(*)::integer AS count,
            min(timestamp)::text AS "from", max(timestamp)::text AS "to",
            min("cpuPercent") AS "cpuMin", avg("cpuPercent") AS "cpuAvg", max("cpuPercent") AS "cpuMax",
            percentile_cont(0.95) WITHIN GROUP (ORDER BY "cpuPercent") AS "cpuP95",
            count(*) FILTER (WHERE "cpuPercent" > 80)::double precision / nullif(count(*), 0) AS "cpuAbove80",
            count(*) FILTER (WHERE "cpuPercent" > 90)::double precision / nullif(count(*), 0) AS "cpuAbove90",
            min("ramPercent") AS "ramMin", avg("ramPercent") AS "ramAvg", max("ramPercent") AS "ramMax",
            percentile_cont(0.95) WITHIN GROUP (ORDER BY "ramPercent") AS "ramP95",
            count(*) FILTER (WHERE "ramPercent" > 80)::double precision / nullif(count(*), 0) AS "ramAbove80",
            count(*) FILTER (WHERE "ramPercent" > 90)::double precision / nullif(count(*), 0) AS "ramAbove90",
            min("diskPercent") AS "diskMin", avg("diskPercent") AS "diskAvg", max("diskPercent") AS "diskMax",
            percentile_cont(0.95) WITHIN GROUP (ORDER BY "diskPercent") AS "diskP95",
            count(*) FILTER (WHERE "diskPercent" > 80)::double precision / nullif(count(*), 0) AS "diskAbove80",
            count(*) FILTER (WHERE "diskPercent" > 90)::double precision / nullif(count(*), 0) AS "diskAbove90",
            min("netInMbps") AS "netInMin", avg("netInMbps") AS "netInAvg", max("netInMbps") AS "netInMax",
            percentile_cont(0.95) WITHIN GROUP (ORDER BY "netInMbps") AS "netInP95",
            min("netOutMbps") AS "netOutMin", avg("netOutMbps") AS "netOutAvg", max("netOutMbps") AS "netOutMax",
            percentile_cont(0.95) WITHIN GROUP (ORDER BY "netOutMbps") AS "netOutP95"
        FROM readings`
        .returnsRow({
            count: "pg/int4@1",
            from: nullableText,
            to: nullableText,
            ...Object.fromEntries(
                Object.values(prefixes).flatMap((p) =>
                    ["Min", "Avg", "Max", "P95", "Above80", "Above90"]
                        .filter((s) => !s.startsWith("Above") || percent(p))
                        .map((s) => [p + s, nullableFloat]),
                ),
            ),
        })
        .build();
    let row: Record<string, unknown> = {};
    for await (const r of db.runtime().query(plan)) row = r;
    const metrics: Record<string, Record<string, unknown>> = {};
    for (const [name, p] of Object.entries(prefixes)) {
        metrics[name] = {
            count: row["count"] ?? 0,
            min: row[`${p}Min`] ?? null,
            avg: row[`${p}Avg`] ?? null,
            max: row[`${p}Max`] ?? null,
            p95: row[`${p}P95`] ?? null,
            ...(percent(p) && {
                shareAbove80: row[`${p}Above80`] ?? null,
                shareAbove90: row[`${p}Above90`] ?? null,
            }),
        };
    }
    return c.json({
        datasetId: id,
        host,
        range,
        from: isoOrNull(row["from"] ?? null),
        to: isoOrNull(row["to"] ?? null),
        metrics,
    });
});

dashboard.get("/:id/history", async (c) => {
    const id = Number(c.req.param("id"));
    const selected = selection(c);
    if (!selected)
        return c.json({ error: "Choose a host and a valid time range" }, 400);
    const { host, range } = selected;
    const requested = c.req.query("bucket");
    if (requested !== undefined && !Object.hasOwn(buckets, requested))
        return c.json({ error: "Choose a bucket of 5m, 1h or 1d" }, 400);

    const boundsPlan = db.raw.sql`
        SELECT min(timestamp)::text AS "from", max(timestamp)::text AS "to"
        FROM (${readings(id, host, range)}) r`
        .returnsRow({ from: nullableText, to: nullableText })
        .build();
    let from: string | null = null,
        to: string | null = null;
    for await (const row of db.runtime().query(boundsPlan))
        ({ from, to } = row as { from: string | null; to: string | null });
    // Buckets are aligned to UTC clock boundaries, so a range can touch one extra.
    const count = (bucket: string) => {
        const ms = buckets[bucket]!;
        if (range !== "all") return Math.floor(ranges[range]! / ms) + 1;
        if (from === null || to === null) return 0;
        return (
            Math.floor(Date.parse(to) / ms) -
            Math.floor(Date.parse(from) / ms) +
            1
        );
    };
    const bucket =
        requested ??
        defaultBuckets[range] ??
        Object.keys(buckets).find((b) => count(b) <= MAX_HISTORY_BUCKETS) ??
        "1d";
    const bucketCount = count(bucket);
    if (bucketCount > MAX_HISTORY_BUCKETS) {
        const span =
            range === "all" ? "this host's full history" : `the last ${range}`;
        return c.json(
            {
                error: `${bucket} buckets over ${span} would return ${bucketCount} buckets, more than the limit of ${MAX_HISTORY_BUCKETS}. Choose a larger bucket or a shorter range.`,
                buckets: bucketCount,
                maxBuckets: MAX_HISTORY_BUCKETS,
            },
            400,
        );
    }

    const bucketMs = buckets[bucket]!;
    // Every bucket between the first and last reading is returned; empty ones
    // have count 0 and null values, so gaps stay visible.
    const plan = db.raw.sql`
        WITH readings AS (${readings(id, host, range)}),
        aggregated AS (
            SELECT date_bin(${bucketMs}::double precision * interval '1 millisecond', timestamp, timestamptz '1970-01-01Z') AS start,
                count(*)::integer AS count,
                avg("cpuPercent") AS "cpuAvg", max("cpuPercent") AS "cpuMax",
                avg("ramPercent") AS "ramAvg", max("ramPercent") AS "ramMax",
                avg("diskPercent") AS "diskAvg", max("diskPercent") AS "diskMax",
                avg("netInMbps") AS "netInAvg", max("netInMbps") AS "netInMax",
                avg("netOutMbps") AS "netOutAvg", max("netOutMbps") AS "netOutMax"
            FROM readings GROUP BY 1
        ), series AS (
            SELECT generate_series(min(start), max(start), ${bucketMs}::double precision * interval '1 millisecond') AS start FROM aggregated
        )
        SELECT s.start::text AS start, coalesce(a.count, 0) AS count,
            "cpuAvg", "cpuMax", "ramAvg", "ramMax", "diskAvg", "diskMax",
            "netInAvg", "netInMax", "netOutAvg", "netOutMax"
        FROM series s LEFT JOIN aggregated a USING (start)
        ORDER BY s.start
        LIMIT ${MAX_HISTORY_BUCKETS}`
        .returnsRow({
            start: "pg/text@1",
            count: "pg/int4@1",
            cpuAvg: nullableFloat,
            cpuMax: nullableFloat,
            ramAvg: nullableFloat,
            ramMax: nullableFloat,
            diskAvg: nullableFloat,
            diskMax: nullableFloat,
            netInAvg: nullableFloat,
            netInMax: nullableFloat,
            netOutAvg: nullableFloat,
            netOutMax: nullableFloat,
        })
        .build();
    const series = [];
    for await (const row of db.runtime().query(plan)) {
        series.push({
            start: new Date(row.start).toISOString(),
            count: row.count,
            cpuPercent: { avg: row.cpuAvg, max: row.cpuMax },
            ramPercent: { avg: row.ramAvg, max: row.ramMax },
            diskPercent: { avg: row.diskAvg, max: row.diskMax },
            netInMbps: { avg: row.netInAvg, max: row.netInMax },
            netOutMbps: { avg: row.netOutAvg, max: row.netOutMax },
        });
    }
    return c.json({
        datasetId: id,
        host,
        range,
        bucket,
        from: isoOrNull(from),
        to: isoOrNull(to),
        buckets: series,
        maxBuckets: MAX_HISTORY_BUCKETS,
    });
});

export const FORECAST_LOOKBACK_DAYS = 90;
const horizons: Record<string, number> = { "24h": 24, "7d": 168, "30d": 720 };

dashboard.get("/:id/forecast", async (c) => {
    const id = Number(c.req.param("id"));
    const host = c.req.query("host");
    const metric = c.req.query("metric") ?? "";
    const horizon = c.req.query("horizon") ?? "";
    if (
        !host ||
        host.length > 255 ||
        !Object.hasOwn(prefixes, metric) ||
        !Object.hasOwn(horizons, horizon)
    ) {
        return c.json(
            {
                error: "Choose a host, a metric and a horizon of 24h, 7d or 30d",
            },
            400,
        );
    }
    // Hourly averages over the last 90 days before the host's latest reading,
    // bucketed like /history; hours without readings come back as null.
    const lookbackMs = FORECAST_LOOKBACK_DAYS * 86400000;
    const plan = db.raw.sql`
        WITH readings AS (
            SELECT timestamp, CASE ${metric}
                    WHEN 'cpuPercent' THEN "cpuPercent" WHEN 'ramPercent' THEN "ramPercent"
                    WHEN 'diskPercent' THEN "diskPercent" WHEN 'netInMbps' THEN "netInMbps"
                    ELSE "netOutMbps" END AS value
            FROM "Metric" WHERE "datasetId" = ${id} AND host = ${host}
                AND timestamp > (
                    SELECT max(timestamp) FROM "Metric" WHERE "datasetId" = ${id} AND host = ${host}
                ) - ${lookbackMs}::double precision * interval '1 millisecond'
        ), aggregated AS (
            SELECT date_bin(${HOUR_MS}::double precision * interval '1 millisecond', timestamp, timestamptz '1970-01-01Z') AS start,
                avg(value) AS value
            FROM readings GROUP BY 1
        ), series AS (
            SELECT generate_series(min(start), max(start), ${HOUR_MS}::double precision * interval '1 millisecond') AS start FROM aggregated
        )
        SELECT s.start::text AS start, a.value
        FROM series s LEFT JOIN aggregated a USING (start)
        ORDER BY s.start`
        .returnsRow({ start: "pg/text@1", value: nullableFloat })
        .build();
    const values: (number | null)[] = [];
    let start: number | null = null;
    for await (const row of db.runtime().query(plan)) {
        start ??= Date.parse(row.start);
        values.push(row.value);
    }
    const days = observedDays(values);
    if (start === null || days < MIN_DAYS) {
        return c.json(
            {
                error: new InsufficientHistory(days).message,
                days,
                requiredDays: MIN_DAYS,
            },
            422,
        );
    }
    const result = forecast(
        { start, values },
        {
            horizonHours: horizons[horizon]!,
            percent: percent(prefixes[metric as keyof typeof prefixes]),
        },
    );
    return c.json({
        datasetId: id,
        host,
        metric,
        horizon,
        bucket: "1h",
        history: {
            from: new Date(start).toISOString(),
            to: new Date(start + (values.length - 1) * HOUR_MS).toISOString(),
            buckets: values.length,
            observedBuckets: values.filter((v) => v !== null).length,
            days,
        },
        ...result,
    });
});
