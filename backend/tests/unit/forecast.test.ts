import { describe, expect, it } from "vitest";
import { errors, origins } from "../../src/forecast/backtest.js";
import { compareCapacity } from "../../src/forecast/capacity.js";
import {
    crossings,
    forecast,
    InsufficientHistory,
    observedDays,
    quantile,
} from "../../src/forecast/index.js";
import {
    fitLine,
    holtWinters,
    hourOfWeek,
    hourOfWeekTrend,
    HOUR_MS,
    linearTrend,
    type Series,
} from "../../src/forecast/models.js";

// a Tuesday, like the samples
const start = Date.parse("2026-09-01T00:00:00Z");
const series = (days: number, f: (i: number) => number | null): Series => ({
    start,
    values: Array.from({ length: days * 24 }, (_, i) => f(i)),
});
// deterministic noise in [-1, 1]
const noise = (i: number) =>
    Math.sin(i * 12.9898) * 0.5 + Math.sin(i * 4.1414) * 0.5;
// busier on weekday afternoons, quiet at weekends
const weekly = (i: number) => {
    const hour = i % 24;
    const day = new Date(start + i * HOUR_MS).getUTCDay();
    const weekend = day === 0 || day === 6 ? 0.4 : 1;
    return 20 * weekend * Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
};
// every 5th hour missing and a two-day hole
const gappy = (f: (i: number) => number) => (i: number) =>
    i % 5 === 0 || (i >= 200 && i < 248) ? null : f(i);

describe("models", () => {
    it("recovers a known slope, ignoring gaps", () => {
        const s = series(
            20,
            gappy((i) => 10 + 0.05 * i),
        );
        expect(fitLine(s.values).slope).toBeCloseTo(0.05, 10);
        const next = linearTrend.fit(s)(3);
        expect(next[0]).toBeCloseTo(10 + 0.05 * 480, 8);
        expect(next[2]).toBeCloseTo(10 + 0.05 * 482, 8);
    });

    it("learns a known weekly pattern on top of the trend", () => {
        const truth = (i: number) => 30 + 0.02 * i + weekly(i);
        const predicted = hourOfWeekTrend.fit(series(21, truth))(168);
        predicted.forEach((p, h) => expect(p).toBeCloseTo(truth(504 + h), 1));
    });

    it("keeps the weekly pattern aligned to UTC hours of the week", () => {
        expect(hourOfWeek(start, 168)).toBe(hourOfWeek(start, 0));
        expect(hourOfWeek(start + HOUR_MS, 0)).toBe(hourOfWeek(start, 1));
    });

    it("fits Holt-Winters through gaps and follows a seasonal series", () => {
        const truth = (i: number) => 40 + 0.01 * i + weekly(i);
        const s = series(28, gappy(truth));
        const predicted = holtWinters.fit(s)(168);
        expect(predicted.every(Number.isFinite)).toBe(true);
        const mae =
            predicted.reduce(
                (sum, p, h) => sum + Math.abs(p - truth(672 + h)),
                0,
            ) / predicted.length;
        expect(mae).toBeLessThan(1);
    });
});

describe("scores", () => {
    it("computes MAE, and MAPE in percent without dividing by zero", () => {
        expect(
            errors([
                { actual: 10, predicted: 12 },
                { actual: 20, predicted: 19 },
                { actual: 0, predicted: 3 },
            ]),
        ).toEqual({ mae: 2, mape: 12.5 });
        expect(errors([{ actual: 0, predicted: 1 }]).mape).toBeNull();
        expect(errors([])).toEqual({ mae: null, mape: null });
    });

    it("backtests 24h from 7 daily origins and longer horizons on one holdout", () => {
        expect(origins(720, 24)).toEqual({
            method: "rolling-origin",
            steps: 24,
            starts: [552, 576, 600, 624, 648, 672, 696],
        });
        expect(origins(720, 168)).toMatchObject({ steps: 168, starts: [552] });
        // never more holdout than training
        expect(origins(720, 720)).toMatchObject({ steps: 360, starts: [360] });
    });

    it("interpolates quantiles", () => {
        expect(quantile([1, 2, 3, 4, 5], 0.1)).toBeCloseTo(1.4);
        expect(quantile([], 0.5)).toBe(0);
    });
});

describe("forecast", () => {
    it("picks the trend for a straight line", () => {
        const result = forecast(
            series(20, (i) => 10 + 0.05 * i + noise(i) * 0.1),
            { horizonHours: 24, percent: true },
        );
        expect(result.model).toBe("linear-trend");
        expect(result.points).toHaveLength(24);
        expect(result.points[0]!.timestamp).toBe("2026-09-21T00:00:00.000Z");
        expect(result.points[0]!.value).toBeCloseTo(10 + 0.05 * 480, 0);
        expect(result.backtest).toMatchObject({
            method: "rolling-origin",
            origins: 7,
            holdoutHours: 168,
            holdoutShorterThanHorizon: false,
        });
    });

    it("picks a seasonal model for a weekly pattern, and survives gaps", () => {
        const result = forecast(
            series(
                28,
                gappy((i) => 30 + 0.02 * i + weekly(i) + noise(i)),
            ),
            { horizonHours: 168, percent: true },
        );
        expect(result.model).not.toBe("linear-trend");
        const score = (name: string) =>
            result.backtest.scores.find((s) => s.model === name)!.mae!;
        expect(score(result.model)).toBeLessThan(score("linear-trend") / 3);
        expect(result.backtest.scores.every((s) => s.points > 0)).toBe(true);
        for (const p of result.points) {
            expect(Number.isFinite(p.value)).toBe(true);
            expect(p.lower).toBeLessThanOrEqual(p.upper);
        }
        expect(result.note).toBe("Forecasts are estimates, not a guarantee.");
    });

    it("clamps percentages to 0-100 and reports threshold crossings", () => {
        // 75% at the end of the history, rising 1 point a day
        const result = forecast(
            series(20, (i) => 55 + i / 24),
            { horizonHours: 720, percent: true },
        );
        expect(result.backtest.holdoutShorterThanHorizon).toBe(true);
        expect(result.thresholds).toEqual([
            {
                percent: 80,
                crossesAt: "2026-09-26T00:00:00.000Z",
                alreadyAbove: false,
            },
            {
                percent: 90,
                crossesAt: "2026-10-06T00:00:00.000Z",
                alreadyAbove: false,
            },
            {
                percent: 100,
                crossesAt: "2026-10-16T00:00:00.000Z",
                alreadyAbove: false,
            },
        ]);
        expect(Math.max(...result.points.map((p) => p.upper))).toBe(100);
        expect(result.points.at(-1)!.value).toBe(100);
    });

    it("keeps throughput non-negative and skips thresholds for it", () => {
        const result = forecast(
            series(20, (i) => Math.max(0, 50 - i / 5)),
            { horizonHours: 168, percent: false },
        );
        expect(result.thresholds).toBeNull();
        expect(Math.min(...result.points.map((p) => p.lower))).toBe(0);
    });

    it("marks thresholds the series is already above", () => {
        const points = [{ timestamp: "t", value: 95 }];
        expect(crossings(points, 85)).toEqual([
            { percent: 80, crossesAt: "t", alreadyAbove: true },
            { percent: 90, crossesAt: "t", alreadyAbove: false },
            { percent: 100, crossesAt: null, alreadyAbove: false },
        ]);
    });

    it("skips Holt-Winters without two weeks of training", () => {
        const result = forecast(
            series(14, (i) => 20 + weekly(i)),
            {
                horizonHours: 168,
                percent: true,
            },
        );
        expect(result.backtest.scores[2]).toMatchObject({
            model: "holt-winters",
            mae: null,
            skipped: "needs 14 days of training",
        });
        expect(result.model).not.toBe("holt-winters");
    });

    it("explains instead of crashing when every model is skipped", () => {
        expect(() =>
            forecast(
                series(14, (i) => 20 + weekly(i)),
                {
                    horizonHours: 168,
                    percent: true,
                    models: [holtWinters],
                },
            ),
        ).toThrow("No model has enough training data to backtest");
    });

    it("refuses fewer than 14 days of readings, counting only hours with data", () => {
        // 20 days long but only half the hours have readings
        const sparse = series(20, (i) => (i % 2 ? 10 : null));
        expect(observedDays(sparse.values)).toBe(10);
        expect(() =>
            forecast(sparse, { horizonHours: 24, percent: true }),
        ).toThrow(InsufficientHistory);
        expect(() =>
            forecast(
                series(7, () => 1),
                { horizonHours: 24, percent: true },
            ),
        ).toThrow(
            "Forecasting needs at least 14 days of readings for this host; it has 7.0.",
        );
    });
});

describe("compareCapacity", () => {
    const at = (day: number | null) =>
        day === null
            ? null
            : `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;
    // crossings for 80, 90 and 100%; "now" is already above
    const row = (
        host: string,
        metric: string,
        ...days: (number | null | "now")[]
    ) => ({
        host,
        metric,
        thresholds: days.map((d) => ({
            alreadyAbove: d === "now",
            crossesAt: d === "now" ? null : at(d),
        })),
    });

    it("puts the soonest 100%, then 90%, then 80% first, ties by host and metric", () => {
        const insufficient = { host: "a-01", metric: "diskPercent" };
        const rows = [
            insufficient,
            row("web-02", "ramPercent", null, null, null),
            row("web-02", "diskPercent", null, null, null),
            row("db-01", "ramPercent", 5, null, null),
            row("db-01", "diskPercent", 3, 9, null),
            row("app-01", "diskPercent", "now", "now", 20),
            row("web-01", "diskPercent", "now", 6, 13),
        ];
        expect(
            rows.toSorted(compareCapacity).map((r) => `${r.host} ${r.metric}`),
        ).toEqual([
            "web-01 diskPercent",
            "app-01 diskPercent",
            "db-01 diskPercent",
            "db-01 ramPercent",
            "web-02 diskPercent",
            "web-02 ramPercent",
            "a-01 diskPercent",
        ]);
    });
});
