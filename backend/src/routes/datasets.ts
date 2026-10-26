import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireAuth, requireLicense, type AuthEnv } from "../auth/session.js";
import {
    CsvError,
    parseMetricsCsv,
    rejectionReason,
    type MetricRow,
} from "../datasets/csv.js";
import { LIMITS, MAX_DATASETS, MAX_FILE_BYTES } from "../datasets/limits.js";
import { db } from "../prisma/db.js";

export { LIMITS, MAX_DATASETS, MAX_FILE_BYTES };

const MAX_NAME_LENGTH = 100;
// First key of the advisory lock that serializes one user's imports; the
// second key is the user id
const IMPORT_LOCK = 1;
// Dataset ids are Postgres integers
const MAX_ID = 2_147_483_647;
// 8 parameters per row keeps each INSERT below Postgres' 65535-parameter limit
const INSERT_BATCH = 2000;

const SUMMARY_FIELDS = [
    "id",
    "name",
    "fileName",
    "rowCount",
    "startsAt",
    "endsAt",
    "createdAt",
] as const;

class LimitReached extends Error {}

type DatasetRow = {
    id: number;
    name: string;
    fileName: string | null;
    rowCount: number;
    startsAt: string | null;
    endsAt: string | null;
    createdAt: string;
};

// Postgres hands timestamps back as "2026-09-01 00:00:00+00"; the API speaks ISO 8601
const iso = (value: string | null) =>
    value === null ? null : new Date(value).toISOString();

function toSummary(row: DatasetRow) {
    return {
        id: row.id,
        name: row.name,
        fileName: row.fileName,
        rowCount: row.rowCount,
        startsAt: iso(row.startsAt),
        endsAt: iso(row.endsAt),
        createdAt: iso(row.createdAt),
    };
}

// Excel saves "CSV" in the system code page unless told otherwise, which for
// Polish Windows is windows-1250.
function decode(bytes: ArrayBuffer): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return new TextDecoder("windows-1250").decode(bytes);
    }
}

// Postgres can't store NUL, and no other control character belongs in a name
const withoutControlCharacters = (text: string) =>
    text.replace(/[\u0000-\u001f\u007f]/g, "");

function datasetName(given: unknown, fileName: string): string {
    const typed =
        typeof given === "string" ? withoutControlCharacters(given).trim() : "";
    const name =
        typed || fileName.replace(/\.[^.]*$/, "").trim() || "Untitled dataset";
    return name.slice(0, MAX_NAME_LENGTH);
}

function timeRange(rows: MetricRow[]) {
    let first = rows[0]!.timestamp;
    let last = first;
    for (const { timestamp } of rows) {
        if (timestamp < first) first = timestamp;
        if (timestamp > last) last = timestamp;
    }
    return { startsAt: first, endsAt: last };
}

export const datasets = new Hono<AuthEnv>();

datasets.use(requireAuth, requireLicense);

datasets.get("/", async (c) => {
    const list = await db.orm.public.Dataset.where({
        ownerId: c.get("user").id,
    })
        .select(...SUMMARY_FIELDS)
        .orderBy((d) => d.createdAt.desc())
        .all();
    return c.json({ datasets: list.map(toSummary), limits: LIMITS });
});

datasets.post(
    "/",
    // the form fields around the file take a few hundred bytes; the file
    // itself is checked against MAX_FILE_BYTES below
    bodyLimit({
        maxSize: MAX_FILE_BYTES + 64 * 1024,
        onError: (c) => c.json({ error: "The file is larger than 25 MB" }, 413),
    }),
    async (c) => {
        const user = c.get("user");
        const form = await c.req.parseBody().catch(() => null);
        const file = form?.["file"];
        if (!(file instanceof File) || file.size === 0) {
            return c.json({ error: "Choose a CSV file to upload" }, 400);
        }
        if (file.size > MAX_FILE_BYTES) {
            return c.json({ error: "The file is larger than 25 MB" }, 413);
        }

        // fail fast before parsing; checked again under a lock when saving
        const { count } = await db.orm.public.Dataset.where({
            ownerId: user.id,
        }).aggregate((a) => ({ count: a.count() }));
        if (count >= MAX_DATASETS) {
            return c.json(
                {
                    error: `You can keep up to ${MAX_DATASETS} datasets. Delete one to import another.`,
                },
                409,
            );
        }

        let parsed;
        try {
            parsed = parseMetricsCsv(decode(await file.arrayBuffer()));
        } catch (err) {
            if (err instanceof CsvError) {
                return c.json({ error: err.message }, 422);
            }
            throw err;
        }

        const report = {
            totalRows: parsed.totalRows,
            importedRows: parsed.rows.length,
            invalidRows: parsed.invalidRows,
            errors: parsed.errors,
        };
        const rejected = rejectionReason(parsed);
        if (rejected) {
            return c.json(
                { error: rejected, report: { ...report, importedRows: 0 } },
                422,
            );
        }

        let dataset;
        try {
            dataset = await db.transaction(async (tx) => {
                // Held until commit, so two uploads at once can't both pass
                // the limit check. An advisory lock writes nothing and blocks
                // only this user's other imports, not changes to the account.
                await tx.execute(
                    db.raw
                        .sql`SELECT pg_advisory_xact_lock(${IMPORT_LOCK}::int, ${user.id}::int)`
                        .affectedCount()
                        .build(),
                );
                const { count } = await tx.orm.public.Dataset.where({
                    ownerId: user.id,
                }).aggregate((a) => ({ count: a.count() }));
                if (count >= MAX_DATASETS) throw new LimitReached();

                const fileName = withoutControlCharacters(file.name);
                const created = await tx.orm.public.Dataset.create({
                    ownerId: user.id,
                    name: datasetName(form?.["name"], fileName),
                    fileName: fileName.slice(0, 255) || null,
                    rowCount: parsed.rows.length,
                    ...timeRange(parsed.rows),
                });
                for (let i = 0; i < parsed.rows.length; i += INSERT_BATCH) {
                    const batch = parsed.rows
                        .slice(i, i + INSERT_BATCH)
                        .map((row) => ({ datasetId: created.id, ...row }));
                    await tx.execute(
                        tx.sql.public.Metric.insert(batch).build(),
                    );
                }
                return created;
            });
        } catch (err) {
            if (err instanceof LimitReached) {
                return c.json(
                    {
                        error: `You can keep up to ${MAX_DATASETS} datasets. Delete one to import another.`,
                    },
                    409,
                );
            }
            throw err;
        }

        return c.json({ dataset: toSummary(dataset), report }, 201);
    },
);

datasets.delete("/:id", async (c) => {
    const param = c.req.param("id");
    // plain digits only: Number() would also accept "0x1d" or "1e1"
    const id = /^\d{1,10}$/.test(param) ? Number(param) : 0;
    if (id <= 0 || id > MAX_ID) {
        return c.json({ error: "Dataset not found" }, 404);
    }
    // filtering by owner too means another user's id behaves like a missing one
    const deleted = await db.orm.public.Dataset.where({
        id,
        ownerId: c.get("user").id,
    }).delete();
    if (!deleted) return c.json({ error: "Dataset not found" }, 404);
    return c.body(null, 204);
});
