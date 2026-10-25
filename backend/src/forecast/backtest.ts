import type { Model, ModelName, Series } from "./models.js";

export type Score = {
    model: ModelName;
    mae: number | null;
    mape: number | null;
    points: number;
    skipped: string | null;
};

export type Backtest = {
    method: "holdout" | "rolling-origin";
    origins: number;
    holdoutHours: number;
    holdoutShorterThanHorizon: boolean;
    scores: Score[];
    // actual - predicted for every scored hour, per model, for the forecast band
    residuals: Map<ModelName, number[]>;
};

export const ROLLING_ORIGINS = 7;

// Mean absolute error, and mean absolute percentage error over the hours whose
// actual value is not 0 (percent of nothing is undefined).
export function errors(pairs: { actual: number; predicted: number }[]) {
    if (pairs.length === 0) return { mae: null, mape: null };
    const mae =
        pairs.reduce((s, p) => s + Math.abs(p.actual - p.predicted), 0) /
        pairs.length;
    const nonZero = pairs.filter((p) => p.actual !== 0);
    const mape = nonZero.length
        ? (nonZero.reduce(
              (s, p) => s + Math.abs((p.actual - p.predicted) / p.actual),
              0,
          ) /
              nonZero.length) *
          100
        : null;
    return { mae, mape };
}

// Where each forecast in the backtest starts and how far it looks ahead.
// A 24h horizon is scored from 7 daily origins across the last week, so every
// hour of the week counts once instead of one day's noise deciding. Longer
// horizons use one holdout of the horizon's length, at most half the history.
export function origins(length: number, horizonHours: number) {
    if (horizonHours <= 24 && length >= 2 * ROLLING_ORIGINS * horizonHours)
        return {
            method: "rolling-origin" as const,
            steps: horizonHours,
            starts: Array.from(
                { length: ROLLING_ORIGINS },
                (_, k) => length - (ROLLING_ORIGINS - k) * horizonHours,
            ),
        };
    const holdout = Math.min(horizonHours, Math.floor(length / 2));
    return {
        method: "holdout" as const,
        steps: holdout,
        starts: [length - holdout],
    };
}

export function backtest(
    series: Series,
    horizonHours: number,
    models: Model[],
    clamp: (value: number) => number,
): Backtest {
    const { method, steps, starts } = origins(
        series.values.length,
        horizonHours,
    );
    const residuals = new Map<ModelName, number[]>();
    const scores = models.map((model): Score => {
        if (starts[0]! < model.minTrainingHours)
            return {
                model: model.name,
                mae: null,
                mape: null,
                points: 0,
                skipped: `needs ${model.minTrainingHours / 24} days of training`,
            };
        const pairs: { actual: number; predicted: number }[] = [];
        for (const origin of starts) {
            const predict = model.fit({
                start: series.start,
                values: series.values.slice(0, origin),
            });
            predict(steps).forEach((value, h) => {
                const actual = series.values[origin + h];
                if (actual !== undefined && actual !== null)
                    pairs.push({ actual, predicted: clamp(value) });
            });
        }
        residuals.set(
            model.name,
            pairs.map((p) => p.actual - p.predicted),
        );
        return {
            model: model.name,
            ...errors(pairs),
            points: pairs.length,
            skipped: null,
        };
    });
    return {
        method,
        origins: starts.length,
        holdoutHours: steps * starts.length,
        holdoutShorterThanHorizon: steps < horizonHours,
        scores,
        residuals,
    };
}
