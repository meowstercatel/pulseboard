// Synthetic server metrics in the CSV format PulseBoard imports:
// timestamp, host, cpu_percent, ram_percent, disk_percent, net_in_mbps, net_out_mbps

export const COLUMNS = [
    "timestamp",
    "host",
    "cpu_percent",
    "ram_percent",
    "disk_percent",
    "net_in_mbps",
    "net_out_mbps",
];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * @typedef {object} Gap
 * @property {string} host
 * @property {string} from ISO timestamp of the first missing row
 * @property {number} hours
 *
 * @typedef {object} Spike
 * @property {string} host
 * @property {string} at ISO timestamp where the spike starts
 * @property {number} hours
 * @property {"cpu" | "ram" | "net"} metric
 *
 * @typedef {object} SampleOptions
 * @property {string} [start] ISO timestamp of the first row
 * @property {number} [days]
 * @property {number} [intervalMinutes]
 * @property {string[]} [hosts]
 * @property {number} [seed]
 * @property {"," | ";"} [separator]
 * @property {boolean} [decimalComma] requires separator ";"
 * @property {boolean} [bom] prefix a UTF-8 byte order mark, like Excel does
 * @property {boolean} [crlf] Windows line endings
 * @property {number} [invalidRate] share of data rows (0-1) replaced with broken ones
 * @property {Gap[]} [gaps] periods with no rows for a host
 * @property {Spike[]} [spikes] periods where one metric jumps far above normal
 */

/** Deterministic PRNG (mulberry32), so the same seed gives the same file. */
export function random(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Each host gets its own baseline, so charts for different hosts don't overlap.
function hostProfile(rand) {
    return {
        cpuBase: 15 + rand() * 20,
        cpuSwing: 15 + rand() * 20,
        ramBase: 40 + rand() * 25,
        diskStart: 30 + rand() * 30,
        // percentage points per day; 0.2-0.6 fills the disk within a few months
        diskGrowth: 0.2 + rand() * 0.4,
        netBase: 20 + rand() * 80,
    };
}

function inPeriod(time, from, hours) {
    const start = Date.parse(from);
    return time >= start && time < start + hours * HOUR;
}

/**
 * One healthy reading for a host at a point in time: busy during working
 * hours, quieter at weekends, disk usage growing slowly with a weekly cleanup.
 */
function reading(profile, time, startTime, rand) {
    const date = new Date(time);
    const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
    const weekday = date.getUTCDay();
    const weekend = weekday === 0 || weekday === 6 ? 0.55 : 1;
    // 0 at 02:00, 1 at 14:00
    const daily = (1 - Math.cos(((hour - 2) / 24) * 2 * Math.PI)) / 2;
    const noise = () => (rand() - 0.5) * 2;

    const load = daily * weekend;
    const cpu = profile.cpuBase + profile.cpuSwing * load + noise() * 6;
    const ram = profile.ramBase + 12 * load + noise() * 2;
    const days = (time - startTime) / DAY;
    // logs are rotated every 7 days, freeing part of what accumulated
    const disk =
        profile.diskStart +
        profile.diskGrowth * days -
        profile.diskGrowth * 2.5 * Math.floor(days / 7) +
        noise() * 0.3;
    const netIn = profile.netBase * (0.3 + load) * (1 + noise() * 0.15);
    const netOut = netIn * (0.35 + rand() * 0.1);

    return {
        cpu: clamp(cpu, 0.5, 100),
        ram: clamp(ram, 1, 100),
        disk: clamp(disk, 1, 100),
        netIn: Math.max(0, netIn),
        netOut: Math.max(0, netOut),
    };
}

function applySpike(values, metric, rand) {
    if (metric === "cpu") values.cpu = 92 + rand() * 8;
    if (metric === "ram") values.ram = 94 + rand() * 6;
    if (metric === "net") {
        values.netIn *= 8 + rand() * 4;
        values.netOut *= 3;
    }
}

// The kinds of broken rows an import has to reject.
const BROKEN_ROWS = [
    (row) => ({ ...row, timestamp: "not-a-date" }),
    (row) => ({ ...row, timestamp: "2026-13-45T25:61:00Z" }),
    (row) => ({ ...row, host: "" }),
    (row) => ({ ...row, cpu: "n/a" }),
    (row) => ({ ...row, ram: "" }),
    (row) => ({ ...row, disk: "-4" }),
    (row) => ({ ...row, cpu: "140" }),
    (row) => ({ ...row, netIn: "-12" }),
    (row) => ({ ...row, missingColumn: true }),
    (row) => ({ ...row, extraColumn: true }),
];

/**
 * Builds the CSV text. Rows are ordered by timestamp, then by host.
 *
 * @param {SampleOptions} [options]
 * @returns {{ csv: string, rows: number, invalidRows: number }}
 */
export function generateSampleCsv(options = {}) {
    const {
        start = "2026-09-01T00:00:00Z",
        days = 30,
        intervalMinutes = 15,
        hosts = ["web-01", "web-02", "db-01"],
        seed = 1,
        separator = ",",
        decimalComma = false,
        bom = false,
        crlf = false,
        invalidRate = 0,
        gaps = [],
        spikes = [],
    } = options;

    if (decimalComma && separator !== ";") {
        throw new Error("decimalComma needs separator ';'");
    }
    if (hosts.length === 0) throw new Error("Need at least one host");
    if (!(days > 0 && intervalMinutes > 0)) {
        throw new Error("days and intervalMinutes must be positive");
    }
    if (!(invalidRate >= 0 && invalidRate < 1)) {
        throw new Error("invalidRate must be between 0 and 1");
    }
    const startTime = Date.parse(start);
    if (Number.isNaN(startTime)) throw new Error(`Invalid start: ${start}`);

    const rand = random(seed);
    const profiles = new Map(hosts.map((host) => [host, hostProfile(rand)]));
    const step = intervalMinutes * 60 * 1000;
    const end = startTime + days * DAY;

    const number = (value, digits) => {
        const text = typeof value === "number" ? value.toFixed(digits) : value;
        return decimalComma ? text.replace(".", ",") : text;
    };

    const lines = [COLUMNS.join(separator)];
    let rows = 0;
    let invalidRows = 0;

    for (let time = startTime; time < end; time += step) {
        for (const host of hosts) {
            if (
                gaps.some(
                    (g) => g.host === host && inPeriod(time, g.from, g.hours),
                )
            ) {
                continue;
            }
            const values = reading(profiles.get(host), time, startTime, rand);
            for (const spike of spikes) {
                if (
                    spike.host === host &&
                    inPeriod(time, spike.at, spike.hours)
                ) {
                    applySpike(values, spike.metric, rand);
                }
            }

            /** @type {Record<string, any>} */
            let row = {
                timestamp: new Date(time).toISOString().replace(".000Z", "Z"),
                host,
                ...values,
            };
            if (invalidRate > 0 && rand() < invalidRate) {
                row = BROKEN_ROWS[Math.floor(rand() * BROKEN_ROWS.length)](row);
                invalidRows++;
            }

            const fields = [
                row.timestamp,
                row.host,
                number(row.cpu, 1),
                number(row.ram, 1),
                number(row.disk, 1),
                number(row.netIn, 2),
                number(row.netOut, 2),
            ];
            if (row.missingColumn) fields.pop();
            if (row.extraColumn) fields.push("unexpected");
            lines.push(fields.join(separator));
            rows++;
        }
    }

    const newline = crlf ? "\r\n" : "\n";
    const csv = (bom ? "﻿" : "") + lines.join(newline) + newline;
    return { csv, rows, invalidRows };
}
