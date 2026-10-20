// Parses an uploaded metrics CSV into rows ready to insert, plus a report of
// every row that was skipped. Accepts what spreadsheets typically export:
// "," or ";" separators, decimal commas, a UTF-8 BOM, CRLF line endings and
// quoted fields.

export const MAX_ROWS = 500_000;
// Above this share of invalid rows the file is rejected as a whole.
export const MAX_INVALID_SHARE = 0.05;
// The report lists at most this many problems; the counts stay exact.
export const MAX_REPORTED_ERRORS = 100;
const MAX_HOST_LENGTH = 100;

const COLUMNS = {
    timestamp: "timestamp",
    host: "host",
    cpuPercent: "cpu_percent",
    ramPercent: "ram_percent",
    diskPercent: "disk_percent",
    netInMbps: "net_in_mbps",
    netOutMbps: "net_out_mbps",
} as const;
type Column = keyof typeof COLUMNS;

const PERCENT_COLUMNS = ["cpuPercent", "ramPercent", "diskPercent"] as const;
const RATE_COLUMNS = ["netInMbps", "netOutMbps"] as const;

export type MetricRow = {
    timestamp: string;
    host: string;
    cpuPercent: number;
    ramPercent: number;
    diskPercent: number;
    netInMbps: number;
    netOutMbps: number;
};

export type RowError = { line: number; message: string };

export type ParsedCsv = {
    rows: MetricRow[];
    // data rows in the file, valid or not
    totalRows: number;
    invalidRows: number;
    errors: RowError[];
};

// Problems with the file as a whole, not with a single row
export class CsvError extends Error {}

// 2026-09-01T12:00:00Z, 2026-09-01 12:00, 2026-09-01T12:00:00.5+02:00, ...
// Without a zone the time is taken as UTC.
const TIMESTAMP =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

function parseTimestamp(value: string): string | null {
    const m = TIMESTAMP.exec(value);
    if (!m) return null;
    const [, y, mo, d, h, mi, s = "0", fraction = "0", zone = "Z"] = m;
    const local = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s);
    // Date.UTC rolls 2026-02-30 over to March; a real date survives the round trip
    const check = new Date(local);
    if (
        check.getUTCFullYear() !== +y! ||
        check.getUTCMonth() !== +mo! - 1 ||
        check.getUTCDate() !== +d! ||
        +h! > 23 ||
        +mi! > 59 ||
        +s > 59
    ) {
        return null;
    }
    let offset = 0;
    if (zone.toUpperCase() !== "Z") {
        const sign = zone[0] === "-" ? -1 : 1;
        const digits = zone.slice(1).replace(":", "");
        offset = sign * (+digits.slice(0, 2) * 60 + +digits.slice(2)) * 60_000;
    }
    const ms = Math.round(Number(`0.${fraction}`) * 1000);
    return new Date(local - offset + ms).toISOString();
}

// "12.5", "12,5", "-3", ".5". No thousands separators or exponents.
const NUMBER = /^-?(\d+([.,]\d*)?|[.,]\d+)$/;

function parseNumber(value: string): number | null {
    if (!NUMBER.test(value)) return null;
    return Number(value.replace(",", "."));
}

// Splits one line into fields, honouring double quotes ("a;b" and "" escapes).
function splitLine(line: string, separator: string): string[] {
    if (!line.includes('"')) return line.split(separator);
    const fields: string[] = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (quoted) {
            if (char === '"' && line[i + 1] === '"') {
                field += '"';
                i++;
            } else if (char === '"') {
                quoted = false;
            } else {
                field += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === separator) {
            fields.push(field);
            field = "";
        } else {
            field += char;
        }
    }
    fields.push(field);
    return fields;
}

// The header decides the separator: whichever of ";" and "," splits it into more
// fields. A ";" file can then use decimal commas without quoting them.
function detectSeparator(header: string): string {
    const semicolons = header.split(";").length;
    const commas = header.split(",").length;
    return semicolons > commas ? ";" : ",";
}

function readHeader(fields: string[]): Record<Column, number> {
    const names = fields.map((f) => f.trim().toLowerCase());
    const positions = {} as Record<Column, number>;
    const missing: string[] = [];
    for (const [key, name] of Object.entries(COLUMNS) as [Column, string][]) {
        const index = names.indexOf(name);
        if (index === -1) missing.push(name);
        positions[key] = index;
    }
    if (missing.length) {
        throw new CsvError(
            `The header is missing ${missing.join(", ")}. Expected columns: ${Object.values(COLUMNS).join(", ")}`,
        );
    }
    return positions;
}

function parseRow(
    fields: string[],
    width: number,
    at: Record<Column, number>,
): MetricRow | string {
    if (fields.length !== width) {
        return `Expected ${width} fields, found ${fields.length}`;
    }
    const value = (column: Column) => fields[at[column]]!.trim();

    const timestamp = parseTimestamp(value("timestamp"));
    if (!timestamp) {
        return `Invalid timestamp "${value("timestamp")}", use e.g. 2026-09-01T12:00:00Z`;
    }
    const host = value("host");
    if (!host) return "Host is empty";
    if (host.length > MAX_HOST_LENGTH) {
        return `Host is longer than ${MAX_HOST_LENGTH} characters`;
    }

    const numbers = {} as Record<
        (typeof PERCENT_COLUMNS)[number] | (typeof RATE_COLUMNS)[number],
        number
    >;
    for (const column of [...PERCENT_COLUMNS, ...RATE_COLUMNS]) {
        const raw = value(column);
        const number = parseNumber(raw);
        const name = COLUMNS[column];
        if (number === null) {
            return raw
                ? `${name} "${raw}" is not a number`
                : `${name} is empty`;
        }
        if (number < 0) return `${name} ${raw} is negative`;
        if (column.endsWith("Percent") && number > 100) {
            return `${name} ${raw} is over 100`;
        }
        numbers[column] = number;
    }
    return { timestamp, host, ...numbers };
}

export function parseMetricsCsv(text: string): ParsedCsv {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/);
    // tolerate blank lines anywhere, most often a trailing newline
    const firstLine = lines.findIndex((l) => l.trim() !== "");
    if (firstLine === -1) throw new CsvError("The file is empty");

    const separator = detectSeparator(lines[firstLine]!);
    const headerFields = splitLine(lines[firstLine]!, separator);
    const positions = readHeader(headerFields);

    const rows: MetricRow[] = [];
    const errors: RowError[] = [];
    const seen = new Set<string>();
    let totalRows = 0;
    let invalidRows = 0;

    const fail = (line: number, message: string) => {
        invalidRows++;
        if (errors.length < MAX_REPORTED_ERRORS) errors.push({ line, message });
    };

    for (let i = firstLine + 1; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trim() === "") continue;
        if (++totalRows > MAX_ROWS) {
            throw new CsvError(
                `The file has more than ${MAX_ROWS.toLocaleString("en")} rows`,
            );
        }
        const lineNumber = i + 1;
        const row = parseRow(
            splitLine(line, separator),
            headerFields.length,
            positions,
        );
        if (typeof row === "string") {
            fail(lineNumber, row);
            continue;
        }
        // two readings for the same host and time would skew every aggregate
        const key = `${row.host}\n${row.timestamp}`;
        if (seen.has(key)) {
            fail(
                lineNumber,
                `Duplicate reading for ${row.host} at ${row.timestamp}`,
            );
            continue;
        }
        seen.add(key);
        rows.push(row);
    }

    if (totalRows === 0) throw new CsvError("The file has no data rows");
    return { rows, totalRows, invalidRows, errors };
}

// The import is all or nothing: a file with too many bad rows is probably in
// the wrong format, and importing its remainder would give misleading charts.
export function rejectionReason(parsed: ParsedCsv): string | null {
    if (parsed.rows.length === 0) return "None of the rows are valid";
    const share = parsed.invalidRows / parsed.totalRows;
    if (share > MAX_INVALID_SHARE) {
        const percent = (share * 100).toFixed(1);
        return `${parsed.invalidRows} of ${parsed.totalRows} rows (${percent}%) are invalid, more than the ${MAX_INVALID_SHARE * 100}% allowed`;
    }
    return null;
}
