// Writes the sample CSV files in samples/, or one custom file.
//
//   npm run samples                         regenerate everything in samples/
//   npm run samples -- --days 400 --hosts 20 --out big.csv
//
// Run with --help for all options.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateSampleCsv } from "./sampleCsv.mjs";

const SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../samples");

/** @type {Record<string, import("./sampleCsv.mjs").SampleOptions>} */
export const SAMPLES = {
    // Clean data, long enough for forecasts (they need at least 14 days).
    "servers-30d.csv": { days: 30, seed: 1 },
    // How Excel with Polish regional settings saves CSV.
    "excel-pl-7d.csv": {
        days: 7,
        hosts: ["app-01"],
        seed: 2,
        separator: ";",
        decimalComma: true,
        bom: true,
        crlf: true,
    },
    // Missing readings and spikes for the history dashboard to find.
    "gaps-and-anomalies-14d.csv": {
        days: 14,
        hosts: ["web-01", "db-01"],
        seed: 3,
        gaps: [
            { host: "web-01", from: "2026-09-04T09:00:00Z", hours: 6 },
            { host: "db-01", from: "2026-09-09T22:00:00Z", hours: 30 },
        ],
        spikes: [
            {
                host: "web-01",
                at: "2026-09-03T14:00:00Z",
                hours: 2,
                metric: "cpu",
            },
            {
                host: "db-01",
                at: "2026-09-06T03:00:00Z",
                hours: 1,
                metric: "ram",
            },
            {
                host: "web-01",
                at: "2026-09-11T19:00:00Z",
                hours: 3,
                metric: "net",
            },
        ],
    },
    // Below the 5% invalid-row limit: imports, with an error report.
    "invalid-3-percent.csv": {
        days: 7,
        hosts: ["web-01"],
        seed: 4,
        invalidRate: 0.03,
    },
    // Above the 5% invalid-row limit: the whole file is rejected.
    "invalid-10-percent.csv": {
        days: 7,
        hosts: ["web-01"],
        seed: 5,
        invalidRate: 0.1,
    },
};

const HELP = `Usage: node scripts/generate-samples.mjs [options]

Without --out, regenerates every file in samples/.

  --out <file>            write one custom file instead
  --start <iso>           first timestamp (default 2026-09-01T00:00:00Z)
  --days <n>              length of the data (default 30)
  --interval <minutes>    time between readings (default 15)
  --hosts <n|a,b,c>       number of hosts or a list of names (default 3)
  --seed <n>              same seed, same file (default 1)
  --semicolon             separate fields with ';'
  --decimal-comma         write 12,5 instead of 12.5 (implies --semicolon)
  --bom                   start with a UTF-8 byte order mark
  --crlf                  Windows line endings
  --invalid-rate <0-1>    share of rows to break on purpose`;

function hostList(value) {
    if (/^\d+$/.test(value)) {
        const count = Number(value);
        return Array.from(
            { length: count },
            (_, i) => `host-${String(i + 1).padStart(2, "0")}`,
        );
    }
    return value
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean);
}

function positive(name, value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
        throw new Error(`--${name} must be a positive number`);
    }
    return number;
}

function write(path, options) {
    const { csv, rows, invalidRows } = generateSampleCsv(options);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, csv);
    const size = (Buffer.byteLength(csv) / 1024 / 1024).toFixed(2);
    const invalid = invalidRows ? `, ${invalidRows} invalid` : "";
    console.log(
        `${relative(process.cwd(), path)}: ${rows} rows${invalid}, ${size} MB`,
    );
}

function main() {
    const { values } = parseArgs({
        options: {
            out: { type: "string" },
            start: { type: "string" },
            days: { type: "string" },
            interval: { type: "string" },
            hosts: { type: "string" },
            seed: { type: "string" },
            semicolon: { type: "boolean" },
            "decimal-comma": { type: "boolean" },
            bom: { type: "boolean" },
            crlf: { type: "boolean" },
            "invalid-rate": { type: "string" },
            help: { type: "boolean", short: "h" },
        },
    });

    if (values.help) {
        console.log(HELP);
        return;
    }

    if (!values.out) {
        for (const [name, options] of Object.entries(SAMPLES)) {
            write(join(SAMPLES_DIR, name), options);
        }
        return;
    }

    const decimalComma = values["decimal-comma"] ?? false;
    write(values.out, {
        start: values.start,
        days: values.days ? positive("days", values.days) : undefined,
        intervalMinutes: values.interval
            ? positive("interval", values.interval)
            : undefined,
        hosts: values.hosts ? hostList(values.hosts) : undefined,
        seed: values.seed ? Number(values.seed) : undefined,
        separator: values.semicolon || decimalComma ? ";" : ",",
        decimalComma,
        bom: values.bom,
        crlf: values.crlf,
        invalidRate: values["invalid-rate"]
            ? Number(values["invalid-rate"])
            : undefined,
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
