// Controller for /forecast: one host's history and forecast, and the disk/RAM
// capacity of the whole dataset, from GET /api/datasets/:id/forecast and /capacity.
import {
    DashboardError,
    dashboardGet,
    initSelection,
    LatestRequest,
    metricFields,
    number,
    type MetricField,
} from "./dashboardControls";
import {
    duration,
    filled,
    findGaps,
    niceMax,
    utc,
    type History,
} from "./history";
import { renderHistoryChart } from "./historyChart";

export type ModelName = "linear-trend" | "hour-of-week-trend" | "holt-winters";
export type Crossing = {
    percent: number;
    crossesAt: string | null;
    alreadyAbove: boolean;
};
export type Forecast = {
    host: string;
    metric: MetricField;
    horizon: Horizon;
    history: { from: string; to: string; days: number };
    model: ModelName;
    backtest: {
        method: "holdout" | "rolling-origin";
        origins: number;
        holdoutHours: number;
        holdoutShorterThanHorizon: boolean;
        scores: { model: ModelName; mae: number | null; mape: number | null }[];
    };
    band: { level: number };
    points: {
        timestamp: string;
        value: number;
        lower: number;
        upper: number;
    }[];
    thresholds: Crossing[] | null;
    note: string;
};
export type CapacityRow = {
    host: string;
    metric: "diskPercent" | "ramPercent";
} & (
    | { model: ModelName; latest: number | null; thresholds: Crossing[] }
    | { insufficient: { days: number; requiredDays: number } }
);
export type Capacity = {
    datasetId: number;
    thresholds: number[];
    rows: CapacityRow[];
    note: string;
};

export const horizons = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
export type Horizon = keyof typeof horizons;
// History shown before the forecast: a week for a day ahead, else 30 days.
export const historyRange = (horizon: Horizon) =>
    horizon === "24h" ? "7d" : "30d";

export const modelNames: Record<ModelName, string> = {
    "linear-trend": "a straight-line trend",
    "hour-of-week-trend":
        "a trend plus the usual level for each hour of the week",
    "holt-winters":
        "Holt-Winters: a level, trend and weekly pattern that follow recent readings",
};
const HOUR = 3600000;
const unitOf = (field: MetricField) =>
    metricFields.find(([f]) => f === field)![2];
const labelOf = (field: MetricField) =>
    metricFields.find(([f]) => f === field)![1];
const withUnit = (value: number, field: MetricField) =>
    `${number(value)} ${unitOf(field)}`;
// Whole days in words, other spans like "36 h".
const span = (hours: number) =>
    hours % 24
        ? duration(hours * HOUR)
        : `${hours / 24} ${hours === 24 ? "day" : "days"}`;

// The chosen model and how far off it was when tested, in plain words.
export function describeModel(f: Forecast) {
    const score = f.backtest.scores.find((s) => s.model === f.model);
    const errorUnit = unitOf(f.metric) === "%" ? "percentage points" : "Mbps";
    const tested =
        f.backtest.method === "rolling-origin"
            ? `Tested by forecasting each of the last ${f.backtest.origins} days from the readings before it`
            : `Tested by forecasting the last ${span(f.backtest.holdoutHours)} of readings from the ones before`;
    const error =
        score?.mae == null
            ? ""
            : `: off by ${number(score.mae)} ${errorUnit} on average (MAE)` +
              (score.mape == null
                  ? ""
                  : `, or ${number(score.mape)}% of the actual value (MAPE)`);
    return [
        `Model: ${modelNames[f.model]}, the most accurate of ${f.backtest.scores.length} models tested.`,
        `${tested}${error}.`,
        ...(f.backtest.holdoutShorterThanHorizon
            ? [
                  `That test covers ${span(f.backtest.holdoutHours)}, less than the ${horizons[f.horizon]} ahead, so later hours may be further off.`,
              ]
            : []),
    ];
}

// When a threshold is reached, for a capacity table cell.
export const crossingText = (t: Crossing) =>
    t.alreadyAbove
        ? "Already above"
        : t.crossesAt === null
          ? "Not within 30 days"
          : utc(Date.parse(t.crossesAt));

export function initForecast(doc: Document = document) {
    const byId = <T extends HTMLElement>(id: string) =>
        doc.getElementById(id) as T;
    const metric = byId<HTMLSelectElement>("metric");
    const horizon = byId<HTMLSelectElement>("horizon");
    const capacityRequests = new LatestRequest();
    let capacityFor: number | null = null;
    const row = (cells: string[], span?: number) => {
        const tr = doc.createElement("tr");
        cells.forEach((text, i) => {
            const cell = doc.createElement(i === 0 ? "th" : "td");
            if (i === 0) cell.setAttribute("scope", "row");
            if (span && i === cells.length - 1) cell.colSpan = span;
            cell.textContent = text;
            tr.append(cell);
        });
        return tr;
    };

    function clear() {
        byId("selection-title").textContent = "";
        byId("summary").textContent = "";
        byId("model").replaceChildren();
        byId("note").textContent = "";
        byId("chart").replaceChildren();
        byId("chart-rows").replaceChildren();
    }

    function clearCapacity(message = "") {
        capacityFor = null;
        capacityRequests.start();
        byId("capacity-rows").replaceChildren();
        byId("capacity-table").hidden = true;
        byId("capacity-note").textContent = "";
        byId("capacity-status").textContent = message;
        byId("capacity").hidden = !message;
    }

    async function loadCapacity(id: number) {
        clearCapacity("Forecasting disk and RAM for every host…");
        capacityFor = id;
        const request = capacityRequests.start();
        try {
            const data = await dashboardGet<Capacity>(
                `/api/datasets/${id}/capacity`,
                request.signal,
            );
            if (!request.current()) return;
            const resource = (m: CapacityRow["metric"]) =>
                m === "diskPercent" ? "Disk" : "RAM";
            byId("capacity-rows").replaceChildren(
                ...data.rows.map((r) =>
                    "insufficient" in r
                        ? row(
                              [
                                  r.host,
                                  resource(r.metric),
                                  `Not enough history: ${number(r.insufficient.days)} of ${r.insufficient.requiredDays} days`,
                              ],
                              4,
                          )
                        : row([
                              r.host,
                              resource(r.metric),
                              r.latest == null
                                  ? "–"
                                  : withUnit(
                                        Math.round(r.latest * 10) / 10,
                                        r.metric,
                                    ),
                              ...r.thresholds.map(crossingText),
                          ]),
                ),
            );
            byId("capacity-table").hidden = !data.rows.length;
            byId("capacity-status").textContent = data.rows.length
                ? ""
                : "This dataset has no readings.";
            byId("capacity-note").textContent = data.note;
        } catch (reason) {
            if (!request.current()) return;
            capacityFor = null;
            byId("capacity-status").textContent =
                reason instanceof Error
                    ? reason.message
                    : "Can't reach the server";
        }
    }

    function render(history: History, f: Forecast) {
        const field = f.metric;
        const unit = unitOf(field);
        const { buckets, times: observed, spacing } = filled(history);
        const gaps = findGaps(observed, spacing);
        const ahead = f.points.map((p) => Date.parse(p.timestamp));
        // Hourly history up to the forecast's first hour, so the two never overlap.
        const past = buckets.filter((b) => Date.parse(b.start) < ahead[0]!);
        const times = [...past.map((b) => Date.parse(b.start)), ...ahead];
        const n = past.length;
        const avg = [
            ...past.map((b) => b[field].avg),
            ...ahead.map(() => null),
        ];
        // The forecast and its band start at the last reading, so they join the history.
        const joined = (values: number[]) => [
            ...past.map((_, i) => (i === n - 1 ? avg[i]! : null)),
            ...values,
        ];
        const forecast = joined(f.points.map((p) => p.value));
        const lower = joined(f.points.map((p) => p.lower));
        const upper = joined(f.points.map((p) => p.upper));
        const band = `${Math.round(f.band.level * 100)}% range`;
        renderHistoryChart(
            byId("chart"),
            {
                title: `${labelOf(field)}: history and forecast`,
                times,
                lines: [
                    { values: avg, kind: "avg", gaps },
                    { values: forecast, kind: "forecast", gaps: [] },
                ],
                area: { lower, upper, kind: "forecast" },
                max: field.endsWith("Percent")
                    ? 100
                    : niceMax(
                          Math.max(
                              0,
                              ...avg.map((v) => v ?? 0),
                              ...f.points.map((p) => p.upper),
                          ),
                      ),
                unit,
                bands: gaps,
                label: (i) => `${utc(times[i]!)} UTC`,
                value: (i) =>
                    i < n
                        ? `${withUnit(avg[i]!, field)} average`
                        : `${withUnit(forecast[i]!, field)} forecast\n${band} ${number(lower[i]!)}–${withUnit(upper[i]!, field)}`,
                axisLabel: (t) => utc(t).slice(5, 10),
            },
            doc,
        );
        byId("chart-rows").replaceChildren(
            ...f.points.map((p) =>
                row([
                    utc(Date.parse(p.timestamp)),
                    number(p.value),
                    number(p.lower),
                    number(p.upper),
                ]),
            ),
        );
        byId("chart-caption").textContent =
            `${labelOf(field)} forecast per hour (${unit}), with the ${band}.`;
        byId("band-label").textContent = band;
        byId("selection-title").textContent = f.host;
        byId("summary").textContent =
            `${labelOf(field)} · ${horizons[f.horizon]} ahead · forecast from ${number(f.history.days)} days of hourly averages, ${utc(Date.parse(f.history.from))} – ${utc(Date.parse(f.history.to))} UTC`;
        byId("model").replaceChildren(
            ...describeModel(f).map((text) => {
                const p = doc.createElement("p");
                p.textContent = text;
                return p;
            }),
        );
        byId("note").textContent = f.note;
    }

    byId("dataset").addEventListener("change", () => clearCapacity());

    return initSelection(
        {
            clear,
            async load({ dataset, host }, request) {
                if (capacityFor !== dataset.id) void loadCapacity(dataset.id);
                const ahead = horizon.value as Horizon;
                const query = (extra: Record<string, string>) =>
                    new URLSearchParams({ host, ...extra });
                let f: Forecast;
                let history: History;
                try {
                    [f, history] = await Promise.all([
                        dashboardGet<Forecast>(
                            `/api/datasets/${dataset.id}/forecast?${query({ metric: metric.value, horizon: ahead })}`,
                            request.signal,
                        ),
                        dashboardGet<History>(
                            `/api/datasets/${dataset.id}/history?${query({ range: historyRange(ahead), bucket: "1h" })}`,
                            request.signal,
                        ),
                    ]);
                } catch (reason) {
                    // Too little history: the API's explanation replaces the chart.
                    if (
                        reason instanceof DashboardError &&
                        reason.status === 422
                    )
                        return reason.message;
                    throw reason;
                }
                if (!request.current()) return;
                render(history, f);
            },
        },
        doc,
    );
}
