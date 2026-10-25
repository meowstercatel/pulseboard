import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { sessionIdFor } from "../../src/auth/session.js";
import { db } from "../../src/prisma/db.js";
import { MAX_DATASETS, MAX_FILE_BYTES } from "../../src/routes/datasets.js";

const app = createApp();
const userIds = new Set<number>();
// what the browser sends with uploads and deletes, so CSRF checks pass
const origin = process.env["PUBLIC_URL"]!;

afterEach(async () => {
    for (const id of userIds) await db.orm.public.User.where({ id }).delete();
    userIds.clear();
});
afterAll(async () => {
    await db.close();
});

const sample = (name: string) =>
    readFileSync(new URL(`../../../samples/${name}`, import.meta.url));

// Accounts are seeded directly: registration and checkout have their own tests.
async function account({ verified = true, licensed = true } = {}) {
    const now = new Date().toISOString();
    const user = await db.orm.public.User.create({
        email: `datasets-${randomUUID()}@example.com`,
        emailVerifiedAt: verified ? now : null,
        licensePlan: licensed ? "lifetime" : null,
        licensedAt: licensed ? now : null,
    });
    userIds.add(user.id);
    const token = randomBytes(32).toString("base64url");
    await db.orm.public.Session.create({
        id: sessionIdFor(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    return { id: user.id, cookie: `session=${token}` };
}

function upload(
    cookie: string,
    content: string | Uint8Array<ArrayBuffer>,
    fileName = "metrics.csv",
    name?: string,
) {
    const form = new FormData();
    form.set("file", new File([content], fileName, { type: "text/csv" }));
    if (name !== undefined) form.set("name", name);
    return app.request("/api/datasets", {
        method: "POST",
        headers: { cookie, origin },
        body: form,
    });
}

const list = (cookie: string) =>
    app.request("/api/datasets", { headers: { cookie } });

const metricsOf = (datasetId: number) =>
    db.orm.public.Metric.where({ datasetId })
        .orderBy((m) => m.timestamp.asc())
        .all();

describe("access", () => {
    it.each([
        ["logged out", null, 401],
        ["unverified", { verified: false }, 403],
        ["unlicensed", { licensed: false }, 402],
    ])("refuses %s users", async (_, options, status) => {
        const cookie = options ? (await account(options)).cookie : "";
        expect((await list(cookie)).status).toBe(status);
        expect((await upload(cookie, sample("servers-30d.csv"))).status).toBe(
            status,
        );
    });
});

describe("import", () => {
    it("stores every row and lists the dataset", async () => {
        const { cookie } = await account();
        const response = await upload(
            cookie,
            sample("servers-30d.csv"),
            "servers-30d.csv",
        );
        expect(response.status).toBe(201);
        const { dataset, report } = await response.json();
        expect(dataset).toEqual({
            id: expect.any(Number),
            name: "servers-30d",
            fileName: "servers-30d.csv",
            rowCount: 8640,
            startsAt: "2026-09-01T00:00:00.000Z",
            endsAt: "2026-09-30T23:45:00.000Z",
            createdAt: expect.any(String),
        });
        expect(report).toEqual({
            totalRows: 8640,
            importedRows: 8640,
            invalidRows: 0,
            errors: [],
        });

        const metrics = await metricsOf(dataset.id);
        expect(metrics).toHaveLength(8640);
        expect(metrics[0]).toMatchObject({
            host: "web-01",
            cpuPercent: 27.3,
            netOutMbps: 5.01,
        });
        expect(new Date(metrics[0]!.timestamp).toISOString()).toBe(
            "2026-09-01T00:00:00.000Z",
        );

        const { datasets, limits } = await (await list(cookie)).json();
        expect(datasets).toEqual([dataset]);
        expect(limits).toMatchObject({ maxDatasets: MAX_DATASETS });
    });

    it("reads the Excel sample and uses the given name", async () => {
        const { cookie } = await account();
        const response = await upload(
            cookie,
            sample("excel-pl-7d.csv"),
            "export.csv",
            "  Office server  ",
        );
        expect(response.status).toBe(201);
        const { dataset } = await response.json();
        expect(dataset).toMatchObject({ name: "Office server", rowCount: 672 });
        const [first] = await metricsOf(dataset.id);
        expect(Number.isInteger(first!.cpuPercent * 10)).toBe(true);
    });

    it("reads a windows-1250 file", async () => {
        const { cookie } = await account();
        // "serwer-łódź" in windows-1250
        const host = Uint8Array.from([
            ...Buffer.from("serwer-"),
            0xb3,
            0xf3,
            0x64,
            0x9f,
        ]);
        const content = Buffer.concat([
            Buffer.from(
                "timestamp;host;cpu_percent;ram_percent;disk_percent;net_in_mbps;net_out_mbps\r\n2026-09-01T00:00:00Z;",
            ),
            host,
            Buffer.from(";1,5;2;3;4;5\r\n"),
        ]);
        const response = await upload(cookie, content);
        expect(response.status).toBe(201);
        const [metric] = await metricsOf((await response.json()).dataset.id);
        expect(metric!.host).toBe("serwer-łódź");
    });

    it("imports the valid rows when under 5% are broken, and reports the rest", async () => {
        const { cookie } = await account();
        const response = await upload(cookie, sample("invalid-3-percent.csv"));
        expect(response.status).toBe(201);
        const { dataset, report } = await response.json();
        expect(report).toMatchObject({
            totalRows: 672,
            importedRows: 650,
            invalidRows: 22,
        });
        expect(report.errors).toHaveLength(22);
        expect(report.errors[0]).toEqual({
            line: expect.any(Number),
            message: expect.any(String),
        });
        expect(await metricsOf(dataset.id)).toHaveLength(650);
    });

    it("rejects the whole file when over 5% are broken", async () => {
        const { id, cookie } = await account();
        const response = await upload(cookie, sample("invalid-10-percent.csv"));
        expect(response.status).toBe(422);
        const body = await response.json();
        expect(body.error).toMatch(/59 of 672 rows \(8\.8%\) are invalid/);
        expect(body.report).toMatchObject({
            importedRows: 0,
            invalidRows: 59,
        });
        expect(
            await db.orm.public.Dataset.where({ ownerId: id }).all(),
        ).toEqual([]);
    });

    it("leaves the account row alone, so a parallel email change survives", async () => {
        const { id, cookie } = await account();
        const before = await db.orm.public.User.where({ id }).first();
        expect((await upload(cookie, sample("excel-pl-7d.csv"))).status).toBe(
            201,
        );
        expect(await db.orm.public.User.where({ id }).first()).toEqual(before);
    });

    it("reports rows Postgres couldn't store instead of failing", async () => {
        const { cookie } = await account();
        const good = Array.from(
            { length: 60 },
            (_, i) =>
                `2026-09-01T${String(i % 24).padStart(2, "0")}:${String(i).padStart(2, "0")}:00Z,web,1,1,1,1,1`,
        );
        const content = [
            "timestamp,host,cpu_percent,ram_percent,disk_percent,net_in_mbps,net_out_mbps",
            ...good,
            "2026-09-01T00:00:00Z,a\u0000b,1,1,1,1,1",
            "9999-12-31T23:30:00-01:00,web,1,1,1,1,1",
            `2026-09-01T00:00:00Z,web,1,1,1,${"9".repeat(400)},1`,
        ].join("\n");
        const response = await upload(
            cookie,
            content,
            "bad\u0000name.csv",
            "My\u0000 data\u0007",
        );
        expect(response.status).toBe(201);
        const { dataset, report } = await response.json();
        expect(dataset).toMatchObject({
            name: "My data",
            fileName: "badname.csv",
            rowCount: 60,
        });
        expect(report.invalidRows).toBe(3);
    });

    it.each([
        ["an empty upload", "", 400, "Choose a CSV file"],
        ["a wrong header", "a,b\n1,2", 422, "The header is missing"],
    ])("refuses %s", async (_, content, status, message) => {
        const { cookie } = await account();
        const response = await upload(cookie, content);
        expect(response.status).toBe(status);
        expect((await response.json()).error).toContain(message);
    });

    it("refuses a request without a file", async () => {
        const { cookie } = await account();
        const response = await app.request("/api/datasets", {
            method: "POST",
            headers: { cookie, origin },
            body: new FormData(),
        });
        expect(response.status).toBe(400);
    });

    it("refuses files over 25 MB before parsing them", async () => {
        const { cookie } = await account();
        const response = await upload(
            cookie,
            new Uint8Array(MAX_FILE_BYTES + 1),
        );
        expect(response.status).toBe(413);
        expect((await response.json()).error).toBe(
            "The file is larger than 25 MB",
        );
    });

    it(`keeps at most ${MAX_DATASETS} datasets per account`, async () => {
        const { cookie } = await account();
        const small = sample("excel-pl-7d.csv");
        for (let i = 0; i < MAX_DATASETS; i++) {
            expect((await upload(cookie, small)).status).toBe(201);
        }
        const response = await upload(cookie, small);
        expect(response.status).toBe(409);
        expect((await response.json()).error).toMatch(/up to 5 datasets/);
    });

    it("does not exceed the limit when uploads run at the same time", async () => {
        const { id, cookie } = await account();
        const small = sample("excel-pl-7d.csv");
        const statuses = await Promise.all(
            Array.from(
                { length: MAX_DATASETS + 3 },
                async () => (await upload(cookie, small)).status,
            ),
        );
        expect(statuses.filter((s) => s === 201)).toHaveLength(MAX_DATASETS);
        expect(statuses.filter((s) => s === 409)).toHaveLength(3);
        expect(
            await db.orm.public.Dataset.where({ ownerId: id }).all(),
        ).toHaveLength(MAX_DATASETS);
    });
});

describe("delete", () => {
    it("deletes a dataset with its metrics", async () => {
        const { cookie } = await account();
        const { dataset } = await (
            await upload(cookie, sample("excel-pl-7d.csv"))
        ).json();
        const response = await app.request(`/api/datasets/${dataset.id}`, {
            method: "DELETE",
            headers: { cookie, origin },
        });
        expect(response.status).toBe(204);
        expect(await metricsOf(dataset.id)).toEqual([]);
        expect((await (await list(cookie)).json()).datasets).toEqual([]);
    });

    it("keeps other users' datasets out of reach", async () => {
        const owner = await account();
        const other = await account();
        const { dataset } = await (
            await upload(owner.cookie, sample("excel-pl-7d.csv"))
        ).json();

        expect((await (await list(other.cookie)).json()).datasets).toEqual([]);
        for (const path of [`${dataset.id}`, "999999999", "abc"]) {
            const response = await app.request(`/api/datasets/${path}`, {
                method: "DELETE",
                headers: { cookie: other.cookie, origin },
            });
            expect(response.status).toBe(404);
        }
        expect(await metricsOf(dataset.id)).toHaveLength(672);
    });

    it("only accepts plain decimal ids", async () => {
        const { cookie } = await account();
        const { dataset } = await (
            await upload(cookie, sample("excel-pl-7d.csv"))
        ).json();
        for (const path of [
            `0x${dataset.id.toString(16)}`,
            `${dataset.id}.0`,
            `+${dataset.id}`,
            "99999999999",
        ]) {
            const response = await app.request(`/api/datasets/${path}`, {
                method: "DELETE",
                headers: { cookie, origin },
            });
            expect(response.status, path).toBe(404);
        }
        expect(await metricsOf(dataset.id)).toHaveLength(672);
    });
});
