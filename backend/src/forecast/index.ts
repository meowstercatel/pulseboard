import { backtest, type Score } from "./backtest.js";
import { HOUR_MS, MODELS, type Model, type Series } from "./models.js";

export { HOUR_MS, type Series } from "./models.js";

export const MIN_DAYS = 14;
export const THRESHOLDS = [80, 90, 100];
export const BAND_LEVEL = 0.8;
export const NOTE = "Forecasts are estimates, not a guarantee.";

export class InsufficientHistory extends Error {
    constructor(readonly days: number) {
        super(
            `Forecasting needs at least ${MIN_DAYS} days of readings for this host; it has ${days.toFixed(1)}.`,
        );
    }
}

// Hours with readings, in days; rounded down so 13.96 days never shows as 14.0.
export const observedDays = (values: (number | null)[]) =>
    Math.floor((values.filter((v) => v !== null).length / 24) * 10) / 10;

const round = (value: number) => Math.round(value * 100) / 100;
const roundOrNull = (value: number | null) =>
    value === null ? null : round(value);

// Linear interpolation between the closest ranks.
export function quantile(sorted: number[], q: number) {
    if (sorted.length === 0) return 0;
    const rank = (sorted.length - 1) * q;
    const low = Math.floor(rank);
    const high = Math.ceil(rank);
    return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

export type ForecastPoint = {
    timestamp: string;
    value: number;
    lower: number;
    upper: number;
};

export type Crossing = {
    percent: number;
    crossesAt: string | null;
    alreadyAbove: boolean;
};

// First forecast hour at or above each threshold, null if none within the horizon.
export function crossings(
    points: { timestamp: string; value: number }[],
    lastObserved: number | null,
): Crossing[] {
    return THRESHOLDS.map((percent) => ({
        percent,
        crossesAt: points.find((p) => p.value >= percent)?.timestamp ?? null,
        alreadyAbove: lastObserved !== null && lastObserved >= percent,
    }));
}

export function forecast(
    series: Series,
    options: { horizonHours: number; percent: boolean; models?: Model[] },
) {
    const days = observedDays(series.values);
    if (days < MIN_DAYS) throw new InsufficientHistory(days);
    const models = options.models ?? MODELS;
    // Percentages can't leave 0-100; throughput can't go negative.
    const clamp = (value: number) =>
        options.percent
            ? Math.min(100, Math.max(0, value))
            : Math.max(0, value);

    const result = backtest(series, options.horizonHours, models, clamp);
    // Lowest MAE wins; on a tie (or no scored hours) the simpler, earlier model.
    const ranked = result.scores
        .map((score, i) => ({ score, model: models[i]! }))
        .filter(({ score }) => score.skipped === null);
    const chosen = ranked.reduce((best, entry) =>
        (entry.score.mae ?? Infinity) < (best.score.mae ?? Infinity)
            ? entry
            : best,
    );

    const residuals = [...(result.residuals.get(chosen.model.name) ?? [])].sort(
        (a, b) => a - b,
    );
    const below = quantile(residuals, (1 - BAND_LEVEL) / 2);
    const above = quantile(residuals, (1 + BAND_LEVEL) / 2);
    const end = series.start + series.values.length * HOUR_MS;
    const points: ForecastPoint[] = chosen.model
        .fit(series)(options.horizonHours)
        .map((raw, h) => ({
            timestamp: new Date(end + h * HOUR_MS).toISOString(),
            value: round(clamp(raw)),
            lower: round(clamp(raw + below)),
            upper: round(clamp(raw + above)),
        }));
    const last = series.values.findLast((v) => v !== null) ?? null;

    return {
        model: chosen.model.name,
        backtest: {
            method: result.method,
            origins: result.origins,
            holdoutHours: result.holdoutHours,
            holdoutShorterThanHorizon: result.holdoutShorterThanHorizon,
            scores: result.scores.map((s): Score => ({
                ...s,
                mae: roundOrNull(s.mae),
                mape: roundOrNull(s.mape),
            })),
        },
        band: { level: BAND_LEVEL, method: "backtest-residual-quantiles" },
        points,
        thresholds: options.percent ? crossings(points, last) : null,
        note: NOTE,
    };
}
