import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SAMPLES } from "../../scripts/generate-samples.mjs";
import { COLUMNS, generateSampleCsv } from "../../scripts/sampleCsv.mjs";

const rowsOf = (csv: string) => csv.trimEnd().split(/\r?\n/).slice(1);

it("writes a header and one row per host per interval", () => {
    const { csv, rows } = generateSampleCsv({
        days: 1,
        intervalMinutes: 60,
        hosts: ["a", "b"],
    });
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(COLUMNS.join(","));
    expect(rows).toBe(48);
    expect(lines).toHaveLength(49);
    expect(lines[1]).toMatch(/^2026-09-01T00:00:00Z,a,/);
    expect(lines[2]).toMatch(/^2026-09-01T00:00:00Z,b,/);
});

it("keeps every value in range", () => {
    const { csv } = generateSampleCsv({ days: 30 });
    for (const line of rowsOf(csv)) {
        const [timestamp, host, ...values] = line.split(",");
        expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
        expect(host).not.toBe("");
        const numbers = values.map(Number);
        expect(numbers).toHaveLength(5);
        for (const percent of numbers.slice(0, 3)) {
            expect(percent).toBeGreaterThan(0);
            expect(percent).toBeLessThanOrEqual(100);
        }
        for (const mbps of numbers.slice(3)) {
            expect(mbps).toBeGreaterThanOrEqual(0);
        }
    }
});

it("is reproducible from the seed", () => {
    expect(generateSampleCsv({ days: 2, seed: 7 }).csv).toBe(
        generateSampleCsv({ days: 2, seed: 7 }).csv,
    );
    expect(generateSampleCsv({ days: 2, seed: 7 }).csv).not.toBe(
        generateSampleCsv({ days: 2, seed: 8 }).csv,
    );
});

it("writes the Excel format: BOM, semicolons, decimal comma, CRLF", () => {
    const { csv } = generateSampleCsv({
        days: 1,
        hosts: ["a"],
        separator: ";",
        decimalComma: true,
        bom: true,
        crlf: true,
    });
    expect(csv.startsWith("\uFEFFtimestamp;host;")).toBe(true);
    expect(
        csv
            .split("\n")
            .slice(0, -1)
            .every((l) => l.endsWith("\r")),
    ).toBe(true);
    const fields = rowsOf(csv)[0].split(";");
    expect(fields).toHaveLength(7);
    expect(fields[2]).toMatch(/^\d+,\d$/);
    expect(() => generateSampleCsv({ decimalComma: true })).toThrow();
});

it("leaves out rows inside a gap", () => {
    const { csv } = generateSampleCsv({
        days: 1,
        intervalMinutes: 60,
        hosts: ["a", "b"],
        gaps: [{ host: "a", from: "2026-09-01T10:00:00Z", hours: 3 }],
    });
    const hoursOf = (host: string) =>
        rowsOf(csv)
            .filter((l) => l.split(",")[1] === host)
            .map((l) => new Date(l.split(",")[0]).getUTCHours());
    expect(hoursOf("a")).toHaveLength(21);
    expect(hoursOf("a")).not.toContain(11);
    expect(hoursOf("b")).toHaveLength(24);
});

it("breaks roughly the requested share of rows", () => {
    const { csv, rows, invalidRows } = generateSampleCsv({
        days: 30,
        invalidRate: 0.1,
    });
    expect(invalidRows / rows).toBeGreaterThan(0.08);
    expect(invalidRows / rows).toBeLessThan(0.12);
    const valid = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ,[^,]+(,\d+\.\d+){5}$/;
    const broken = rowsOf(csv).filter((l) => {
        const match = valid.test(l) && Number(l.split(",")[2]) <= 100;
        return !match || Number.isNaN(Date.parse(l.split(",")[0]));
    });
    expect(broken).toHaveLength(invalidRows);
});

it("matches the committed files in samples/", () => {
    for (const [name, options] of Object.entries(SAMPLES)) {
        const committed = readFileSync(
            new URL(`../../samples/${name}`, import.meta.url),
            "utf8",
        );
        expect(committed, name).toBe(generateSampleCsv(options).csv);
    }
});
