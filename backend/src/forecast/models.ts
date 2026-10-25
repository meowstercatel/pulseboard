export const HOUR_MS = 3600000;
export const WEEK_HOURS = 168;

// Hourly buckets from `start` (ms, aligned to the hour); null marks an hour without readings.
export type Series = { start: number; values: (number | null)[] };

export type ModelName = "linear-trend" | "hour-of-week-trend" | "holt-winters";

// Fitting a model returns a predictor for the `steps` hours right after the training data.
export type Model = {
    name: ModelName;
    minTrainingHours: number;
    fit(train: Series): (steps: number) => number[];
};

function observed(values: (number | null)[]) {
    const points: [number, number][] = [];
    values.forEach((y, i) => {
        if (y !== null) points.push([i, y]);
    });
    return points;
}

// Least squares over the hours that have readings, so gaps neither bend nor shift the line.
export function fitLine(values: (number | null)[]) {
    const points = observed(values);
    if (points.length === 0) return { intercept: 0, slope: 0 };
    const meanX = points.reduce((s, [x]) => s + x, 0) / points.length;
    const meanY = points.reduce((s, [, y]) => s + y, 0) / points.length;
    let cov = 0,
        variance = 0;
    for (const [x, y] of points) {
        cov += (x - meanX) * (y - meanY);
        variance += (x - meanX) ** 2;
    }
    const slope = variance === 0 ? 0 : cov / variance;
    return { intercept: meanY - slope * meanX, slope };
}

// UTC hour of the week; any fixed phase works as long as it is the same for every series.
export const hourOfWeek = (start: number, index: number) =>
    (((Math.floor(start / HOUR_MS) + index) % WEEK_HOURS) + WEEK_HOURS) %
    WEEK_HOURS;

export const linearTrend: Model = {
    name: "linear-trend",
    minTrainingHours: 2,
    fit({ values }) {
        const { intercept, slope } = fitLine(values);
        const n = values.length;
        return (steps) =>
            Array.from(
                { length: steps },
                (_, h) => intercept + slope * (n + h),
            );
    },
};

// The trend plus the average detrended value for each hour of the week.
// A slot that never had a reading adds nothing. The weekly pattern would bias
// a line fitted on its own (weekends sit at fixed points in the window), so the
// two are fitted in turn until they settle: least squares on both together.
export const hourOfWeekTrend: Model = {
    name: "hour-of-week-trend",
    minTrainingHours: WEEK_HOURS,
    fit({ start, values }) {
        const slots = values.map((_, i) => hourOfWeek(start, i));
        let effect = new Array<number>(WEEK_HOURS).fill(0);
        let line = fitLine(values);
        for (let round = 0; round < 20; round++) {
            const sums = new Array<number>(WEEK_HOURS).fill(0);
            const counts = new Array<number>(WEEK_HOURS).fill(0);
            values.forEach((y, i) => {
                if (y === null) return;
                sums[slots[i]!]! += y - (line.intercept + line.slope * i);
                counts[slots[i]!]!++;
            });
            effect = sums.map((s, i) => (counts[i] ? s / counts[i]! : 0));
            line = fitLine(
                values.map((y, i) =>
                    y === null ? null : y - effect[slots[i]!]!,
                ),
            );
        }
        const { intercept, slope } = line;
        const n = values.length;
        return (steps) =>
            Array.from(
                { length: steps },
                (_, h) =>
                    intercept +
                    slope * (n + h) +
                    effect[hourOfWeek(start, n + h)]!,
            );
    },
};

type HoltState = { level: number; trend: number; season: number[] };

function mean(values: (number | null)[]) {
    const present = values.filter((v): v is number => v !== null);
    return present.length
        ? present.reduce((s, v) => s + v, 0) / present.length
        : null;
}

// Additive Holt-Winters with a weekly season. Starts from the first two weeks;
// a missing hour advances the state on its own forecast instead of updating it.
function runHolt(
    values: (number | null)[],
    alpha: number,
    beta: number,
    gamma: number,
) {
    const m = WEEK_HOURS;
    const first = mean(values.slice(0, m)) ?? mean(values) ?? 0;
    const second = mean(values.slice(m, 2 * m)) ?? first;
    const trend0 = (second - first) / m;
    const season = Array.from({ length: m }, (_, j) => {
        const deviations: number[] = [];
        for (const k of [0, 1]) {
            const y = values[k * m + j];
            if (y !== undefined && y !== null)
                deviations.push(y - (k ? second : first));
        }
        return deviations.length
            ? deviations.reduce((s, d) => s + d, 0) / deviations.length
            : 0;
    });
    const state: HoltState = {
        // level as of the hour before the series starts, centred on the first week's mean
        level: first - (trend0 * (m + 1)) / 2,
        trend: trend0,
        season,
    };
    let sse = 0;
    values.forEach((y, t) => {
        const j = t % m;
        const expected = state.level + state.trend + state.season[j]!;
        if (y === null) {
            state.level += state.trend;
            return;
        }
        sse += (y - expected) ** 2;
        const level =
            alpha * (y - state.season[j]!) +
            (1 - alpha) * (state.level + state.trend);
        state.trend = beta * (level - state.level) + (1 - beta) * state.trend;
        state.level = level;
        state.season[j] = gamma * (y - level) + (1 - gamma) * state.season[j]!;
    });
    return { sse, state };
}

const ALPHAS = [0.05, 0.1, 0.2, 0.3, 0.5];
const BETAS = [0, 0.005, 0.02, 0.1];
const GAMMAS = [0.05, 0.1, 0.2, 0.4];

export const holtWinters: Model = {
    name: "holt-winters",
    minTrainingHours: 2 * WEEK_HOURS,
    fit({ values }) {
        let best: { sse: number; state: HoltState } | null = null;
        for (const alpha of ALPHAS)
            for (const beta of BETAS)
                for (const gamma of GAMMAS) {
                    const run = runHolt(values, alpha, beta, gamma);
                    if (!best || run.sse < best.sse) best = run;
                }
        const { level, trend, season } = best!.state;
        const n = values.length;
        return (steps) =>
            Array.from(
                { length: steps },
                (_, h) =>
                    level + trend * (h + 1) + season[(n + h) % WEEK_HOURS]!,
            );
    },
};

export const MODELS: Model[] = [linearTrend, hourOfWeekTrend, holtWinters];
