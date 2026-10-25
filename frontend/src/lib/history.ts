// Analysis for /history: bucket choice, gaps, spikes and the hour × weekday
// heatmap, computed from GET /api/datasets/:id/history buckets.
import type { MetricField } from "./dashboardControls";

export const bucketSizes = {
    "5m": 300000,
    "1h": 3600000,
    "1d": 86400000,
} as const;
export type BucketSize = keyof typeof bucketSizes;
export const MAX_BUCKETS = 2000;
const rangeMs: Record<string, number> = {
    "1h": 3600000,
    "24h": 86400000,
    "7d": 604800000,
    "30d": 2592000000,
};
const HOUR = 3600000;

export type Bucket = { start: string; count: number } & Record<
    MetricField,
    { avg: number | null; max: number | null }
>;
export type History = {
    host: string;
    range: string;
    bucket: BucketSize;
    from: string | null;
    to: string | null;
    buckets: Bucket[];
};
export type Stats = {
    host: string;
    range: string;
    from: string | null;
    to: string | null;
    metrics: Record<
        MetricField,
        {
            count: number;
            min: number | null;
            avg: number | null;
            max: number | null;
            p95: number | null;
            shareAbove80?: number | null;
            shareAbove90?: number | null;
        }
    >;
};

// The finest bucket that stays within the API's limit, counted the same way the
// API does: from the range length, or for "all" from the dataset's span. Every
// host in a dataset gets the same bucket, so compared lines line up.
export function pickBucket(
    range: string,
    dataset: { startsAt: string | null; endsAt: string | null },
): BucketSize {
    const sizes = Object.keys(bucketSizes) as BucketSize[];
    return (
        sizes.find(
            (s) =>
                bucketCount(range, dataset.startsAt, dataset.endsAt, s) <=
                MAX_BUCKETS,
        ) ?? "1d"
    );
}

// Buckets the API would return: from the range length, or for "all" from the
// first to the last reading, aligned to UTC bucket boundaries.
export function bucketCount(
    range: string,
    from: string | null,
    to: string | null,
    bucket: BucketSize,
) {
    const ms = bucketSizes[bucket];
    if (range !== "all") return Math.floor(rangeMs[range]! / ms) + 1;
    if (!from || !to) return 1;
    return (
        Math.floor(Date.parse(to) / ms) - Math.floor(Date.parse(from) / ms) + 1
    );
}

// Usual distance between filled buckets: the bucket size, or the reading
// interval when readings are sparser than buckets (15-minute CSVs in 5m
// buckets leave two of every three buckets empty without any data missing).
export function typicalSpacing(times: number[], bucketMs: number) {
    const steps = times.slice(1).map((t, i) => t - times[i]!);
    return Math.max(bucketMs, median(steps) ?? bucketMs);
}

export type Gap = { start: number; end: number };

// A gap is a stretch between filled buckets longer than 1.5 × the usual spacing.
// It starts one spacing after the last reading's bucket and ends at the next one.
export function findGaps(times: number[], spacing: number): Gap[] {
    const gaps: Gap[] = [];
    for (let i = 1; i < times.length; i++) {
        if (times[i]! - times[i - 1]! > spacing * 1.5)
            gaps.push({ start: times[i - 1]! + spacing, end: times[i]! });
    }
    return gaps;
}

export type Spike = {
    field: MetricField;
    start: number;
    end: number;
    peak: number;
    peakAt: number;
    typical: number;
};

// Robust spike rule, checked against samples/gaps-and-anomalies-14d.csv and
// servers-30d.csv at 5m, 1h and 1d buckets. A bucket's max is a spike when it is
// more than SPIKE_Z robust deviations (1.4826 × MAD) above the median of the
// readings within SPIKE_WINDOW on either side, and also clearly above it in
// absolute terms, so that normal daily peaks on calm hosts are not flagged.
export const SPIKE_WINDOW = 6 * HOUR;
export const SPIKE_Z = 4;
export const SPIKE_MIN_PERCENT_POINTS = 20;
export const SPIKE_MIN_NETWORK_RATIO = 2;

export function findSpikes(
    field: MetricField,
    times: number[],
    values: number[],
    bucketMs: number,
    spacing: number,
): Spike[] {
    const percent = field.endsWith("Percent");
    const window = Math.max(SPIKE_WINDOW, 3 * bucketMs);
    const minimum = Math.max(3, Math.floor(window / spacing));
    const flagged: { i: number; typical: number }[] = [];
    let from = 0;
    let to = 0;
    for (let i = 0; i < times.length; i++) {
        while (times[from]! < times[i]! - window) from++;
        while (to < times.length && times[to]! <= times[i]! + window) to++;
        const neighbours = values.slice(from, to);
        if (neighbours.length < minimum) continue;
        const typical = median(neighbours)!;
        const mad = median(neighbours.map((v) => Math.abs(v - typical)))!;
        const scale = Math.max(
            1.4826 * mad,
            percent ? 2 : Math.max(1, typical * 0.1),
        );
        const value = values[i]!;
        const clear = percent
            ? value - typical >= SPIKE_MIN_PERCENT_POINTS
            : value >= SPIKE_MIN_NETWORK_RATIO * Math.max(typical, 1);
        if ((value - typical) / scale > SPIKE_Z && clear)
            flagged.push({ i, typical });
    }
    // Neighbouring flagged buckets with no gap between them are one spike.
    const spikes: Spike[] = [];
    let last = -2;
    for (const { i, typical } of flagged) {
        const current = spikes.at(-1);
        if (
            current &&
            i === last + 1 &&
            times[i]! - times[last]! <= spacing * 1.5
        ) {
            current.end = times[i]! + spacing;
            if (values[i]! > current.peak) {
                current.peak = values[i]!;
                current.peakAt = times[i]!;
                current.typical = typical;
            }
        } else {
            spikes.push({
                field,
                start: times[i]!,
                end: times[i]! + spacing,
                peak: values[i]!,
                peakAt: times[i]!,
                typical,
            });
        }
        last = i;
    }
    return spikes;
}

export const weekdays = [
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
    "Sun",
] as const;
export type HeatmapCell = { value: number | null; hours: number };

// Mean of each UTC weekday and hour, weighted by readings per 1h bucket so
// that partial hours count for what they contain. Rows start on Monday.
export function heatmap(buckets: Bucket[], field: MetricField) {
    const sums = weekdays.map(() =>
        Array.from({ length: 24 }, () => ({ sum: 0, readings: 0, hours: 0 })),
    );
    for (const b of buckets) {
        const avg = b[field].avg;
        if (!b.count || avg == null) continue;
        const date = new Date(b.start);
        const cell = sums[(date.getUTCDay() + 6) % 7]![date.getUTCHours()]!;
        cell.sum += avg * b.count;
        cell.readings += b.count;
        cell.hours++;
    }
    return sums.map((row) =>
        row.map((c): HeatmapCell => ({
            value: c.readings ? c.sum / c.readings : null,
            hours: c.hours,
        })),
    );
}

export function median(values: number[]) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2
        ? sorted[mid]!
        : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Filled buckets of one history response, ready for the functions above.
export function filled(history: History) {
    const bucketMs = bucketSizes[history.bucket];
    const buckets = history.buckets.filter((b) => b.count > 0);
    const times = buckets.map((b) => Date.parse(b.start));
    return {
        bucketMs,
        buckets,
        times,
        spacing: typicalSpacing(times, bucketMs),
    };
}

export const utc = (ms: number) =>
    new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export function duration(ms: number) {
    const minutes = Math.round(ms / 60000);
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    const m = minutes % 60;
    return (
        [d && `${d} d`, h && `${h} h`, m && `${m} min`]
            .filter(Boolean)
            .join(" ") || "0 min"
    );
}

// A round axis maximum for unbounded metrics (1, 2 or 5 × a power of ten).
export function niceMax(value: number) {
    if (!(value > 0)) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    return ([1, 2, 5, 10].find((f) => f * power >= value) ?? 10) * power;
}
