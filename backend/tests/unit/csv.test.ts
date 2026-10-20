import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    CsvError,
    MAX_REPORTED_ERRORS,
    MAX_ROWS,
    parseMetricsCsv,
    rejectionReason,
} from "../../src/datasets/csv.js";

const HEADER =
    "timestamp,host,cpu_percent,ram_percent,disk_percent,net_in_mbps,net_out_mbps";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");
const sample = (name: string) =>
    readFileSync(new URL(`../../../samples/${name}`, import.meta.url), "utf8");

describe("parseMetricsCsv", () => {
    it("parses rows into numbers and UTC timestamps", () => {
        const parsed = parseMetricsCsv(
            csv("2026-09-01T12:00:00Z,web-01,42.5,60,70.1,10.25,3"),
        );
        expect(parsed).toEqual({
            rows: [
                {
                    timestamp: "2026-09-01T12:00:00.000000Z",
                    host: "web-01",
                    cpuPercent: 42.5,
                    ramPercent: 60,
                    diskPercent: 70.1,
                    netInMbps: 10.25,
                    netOutMbps: 3,
                },
            ],
            totalRows: 1,
            invalidRows: 0,
            errors: [],
        });
    });

    it.each([
        ["2026-09-01T12:00:00Z", "2026-09-01T12:00:00.000000Z"],
        ["2026-09-01 12:00", "2026-09-01T12:00:00.000000Z"],
        ["2026-09-01T14:00:00+02:00", "2026-09-01T12:00:00.000000Z"],
        ["2026-09-01T07:30:00-0430", "2026-09-01T12:00:00.000000Z"],
        ["2026-09-01T12:00:00.25Z", "2026-09-01T12:00:00.250000Z"],
        ["2026-09-01T12:00:00.123456Z", "2026-09-01T12:00:00.123456Z"],
        ["2026-09-01T12:00:00.9996Z", "2026-09-01T12:00:00.999600Z"],
        ["2026-09-01T14:00:00+14:00", "2026-09-01T00:00:00.000000Z"],
        ["9999-12-31T23:30:00+01:00", "9999-12-31T22:30:00.000000Z"],
    ])("reads timestamp %s", (input, expected) => {
        const { rows } = parseMetricsCsv(csv(`${input},h,1,1,1,1,1`));
        expect(rows[0]?.timestamp).toBe(expected);
    });

    it("accepts columns in any order, any case, with extra columns", () => {
        const { rows, invalidRows } = parseMetricsCsv(
            [
                "Host,note,NET_OUT_MBPS,net_in_mbps,disk_percent,ram_percent,cpu_percent,Timestamp",
                "db-01,hello,1,2,3,4,5,2026-09-01T00:00:00Z",
            ].join("\n"),
        );
        expect(invalidRows).toBe(0);
        expect(rows[0]).toMatchObject({
            host: "db-01",
            cpuPercent: 5,
            netOutMbps: 1,
        });
    });

    it("reads Excel files: BOM, semicolons, decimal commas, CRLF", () => {
        const text =
            "﻿" +
            [
                HEADER.replaceAll(",", ";"),
                "2026-09-01T00:00:00Z;app-01;12,5;40;55,25;1,5;0,75",
                "",
            ].join("\r\n");
        const { rows, invalidRows } = parseMetricsCsv(text);
        expect(invalidRows).toBe(0);
        expect(rows[0]).toMatchObject({
            cpuPercent: 12.5,
            diskPercent: 55.25,
            netOutMbps: 0.75,
        });
    });

    it("reads quoted fields", () => {
        const { rows } = parseMetricsCsv(
            csv('2026-09-01T00:00:00Z,"web ""01""","12,5",1,1,1,1'),
        );
        expect(rows[0]).toMatchObject({ host: 'web "01"', cpuPercent: 12.5 });
    });

    it.each([
        ["not-a-date,h,1,1,1,1,1", "Invalid timestamp"],
        ["2026-02-30T00:00:00Z,h,1,1,1,1,1", "Invalid timestamp"],
        ["2026-09-01T24:00:00Z,h,1,1,1,1,1", "Invalid timestamp"],
        ["2026-09-01T00:00:00Z, ,1,1,1,1,1", "Host is empty"],
        [
            "2026-09-01T00:00:00Z,h,n/a,1,1,1,1",
            'cpu_percent "n/a" is not a number',
        ],
        ["2026-09-01T00:00:00Z,h,1,,1,1,1", "ram_percent is empty"],
        ["2026-09-01T00:00:00Z,h,1,1,-4,1,1", 'disk_percent "-4" is negative'],
        ["2026-09-01T00:00:00Z,h,140,1,1,1,1", 'cpu_percent "140" is over 100'],
        [
            "2026-09-01T00:00:00Z,h,1,1,1,2000000,1",
            'net_in_mbps "2000000" is over 1,000,000',
        ],
        [
            `2026-09-01T00:00:00Z,h,1,1,1,${"9".repeat(400)},1`,
            "is not a number",
        ],
        ["2026-09-01T00:00:00Z,a\u0000b,1,1,1,1,1", "control characters"],
        ["2026-09-01T00:00:00Z,a\tb,1,1,1,1,1", "control characters"],
        ["2026-09-01T00:00:00+99:99,h,1,1,1,1,1", "Invalid timestamp"],
        ["2026-09-01T00:00:00+15:00,h,1,1,1,1,1", "Invalid timestamp"],
        ["9999-12-31T23:30:00-01:00,h,1,1,1,1,1", "Invalid timestamp"],
        ["0999-12-31T23:30:00Z,h,1,1,1,1,1", "Invalid timestamp"],
        ["2026-09-01T00:00:00Z,h,1,1,1,1e3,1", "is not a number"],
        ["2026-09-01T00:00:00Z,h,1,1,1,1", "Expected 7 fields, found 6"],
        ["2026-09-01T00:00:00Z,h,1,1,1,1,1,x", "Expected 7 fields, found 8"],
    ])("reports %s", (row, message) => {
        const parsed = parseMetricsCsv(
            csv("2026-09-01T01:00:00Z,ok,1,1,1,1,1", row),
        );
        expect(parsed.rows).toHaveLength(1);
        expect(parsed.invalidRows).toBe(1);
        expect(parsed.errors).toEqual([
            { line: 3, message: expect.stringContaining(message) },
        ]);
    });

    it("rejects a second reading for the same host and time", () => {
        const parsed = parseMetricsCsv(
            csv(
                "2026-09-01T00:00:00Z,a,1,1,1,1,1",
                "2026-09-01T02:00:00+02:00,a,2,2,2,2,2",
                "2026-09-01T00:00:00Z,b,1,1,1,1,1",
            ),
        );
        expect(parsed.rows.map((r) => r.host)).toEqual(["a", "b"]);
        expect(parsed.errors[0]?.message).toMatch(/^Duplicate reading for a/);
    });

    it("keeps readings a fraction of a millisecond apart", () => {
        const parsed = parseMetricsCsv(
            csv(
                "2026-09-01T00:00:00.0001Z,a,1,1,1,1,1",
                "2026-09-01T00:00:00.0004Z,a,1,1,1,1,1",
            ),
        );
        expect(parsed.invalidRows).toBe(0);
        expect(parsed.rows).toHaveLength(2);
    });

    it("shortens long values quoted in errors", () => {
        const long = "x".repeat(10_000);
        const { errors } = parseMetricsCsv(csv(`${long},h,1,1,1,1,1`));
        expect(errors[0]!.message).toBe(
            `Invalid timestamp "${"x".repeat(40)}…", use e.g. 2026-09-01T12:00:00Z`,
        );
    });

    it("skips rows of separators that Excel leaves behind", () => {
        const parsed = parseMetricsCsv(
            [
                HEADER.replaceAll(",", ";"),
                "2026-09-01T00:00:00Z;a;1;1;1;1;1",
                ";;;;;;",
                " ; ;;;;; ",
            ].join("\r\n"),
        );
        expect(parsed.totalRows).toBe(1);
        expect(parsed.invalidRows).toBe(0);
    });

    it("splits lines on a lone CR, as classic Mac OS wrote them", () => {
        const parsed = parseMetricsCsv(
            csv(
                "2026-09-01T00:00:00Z,a,1,1,1,1,1",
                "2026-09-01T00:15:00Z,a,1,1,1,1,1",
            ).replaceAll("\n", "\r"),
        );
        expect(parsed.totalRows).toBe(2);
        expect(parsed.invalidRows).toBe(0);
    });

    it("ignores separators inside quoted header names", () => {
        const parsed = parseMetricsCsv(
            [
                `${HEADER.replaceAll(",", ";")};"site, rack, row, room, floor, dc, region, zone"`,
                "2026-09-01T00:00:00Z;a;1,5;1;1;1;1;x",
            ].join("\n"),
        );
        expect(parsed.invalidRows).toBe(0);
        expect(parsed.rows[0]?.cpuPercent).toBe(1.5);
    });

    it("skips blank lines without counting them", () => {
        const parsed = parseMetricsCsv(
            `\n${csv("2026-09-01T00:00:00Z,a,1,1,1,1,1", "", "2026-09-01T00:15:00Z,a,1,1,1,1,1")}\n\n`,
        );
        expect(parsed.totalRows).toBe(2);
        expect(parsed.invalidRows).toBe(0);
    });

    it("caps the error list but keeps the count exact", () => {
        const bad = Array.from(
            { length: MAX_REPORTED_ERRORS + 20 },
            () => "bad,h,1,1,1,1,1",
        );
        const parsed = parseMetricsCsv(csv(...bad));
        expect(parsed.invalidRows).toBe(MAX_REPORTED_ERRORS + 20);
        expect(parsed.errors).toHaveLength(MAX_REPORTED_ERRORS);
    });

    it.each([
        ["", "The file is empty"],
        ["﻿\r\n\r\n", "The file is empty"],
        [HEADER + "\n", "The file has no data rows"],
        ["time,host,cpu\n1,2,3", "The header is missing timestamp"],
    ])("refuses the whole file for %j", (text, message) => {
        expect(() => parseMetricsCsv(text)).toThrow(CsvError);
        expect(() => parseMetricsCsv(text)).toThrow(message);
    });

    it(`refuses more than ${MAX_ROWS} rows`, () => {
        const row = "2026-09-01T00:00:00Z,h,1,1,1,1,1\n";
        const text = HEADER + "\n" + row.repeat(MAX_ROWS + 1);
        expect(() => parseMetricsCsv(text)).toThrow(/more than 500,000 rows/);
    });
});

describe("sample files", () => {
    it.each([
        ["servers-30d.csv", 8640, 0],
        ["excel-pl-7d.csv", 672, 0],
        ["gaps-and-anomalies-14d.csv", 2544, 0],
        ["invalid-3-percent.csv", 672, 22],
        ["invalid-10-percent.csv", 672, 59],
    ])("%s has %i rows, %i invalid", (name, total, invalid) => {
        const parsed = parseMetricsCsv(sample(name));
        expect(parsed.totalRows).toBe(total);
        expect(parsed.invalidRows).toBe(invalid);
    });

    it("imports up to 5% invalid rows and rejects more", () => {
        expect(
            rejectionReason(parseMetricsCsv(sample("invalid-3-percent.csv"))),
        ).toBeNull();
        expect(
            rejectionReason(parseMetricsCsv(sample("invalid-10-percent.csv"))),
        ).toBe("59 of 672 rows (8.8%) are invalid, more than the 5% allowed");
    });
});

describe("rejectionReason", () => {
    it("rejects a file where no row is valid", () => {
        expect(rejectionReason(parseMetricsCsv(csv("bad,h,1,1,1,1,1")))).toBe(
            "None of the rows are valid",
        );
    });
});
