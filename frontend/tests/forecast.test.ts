import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { metricFields } from "../src/lib/dashboardControls";
import {
    crossingText,
    describeModel,
    initForecast,
    type Capacity,
    type Forecast,
} from "../src/lib/forecastPage";
import type { History } from "../src/lib/history";

const HOUR = 3600000;
const end = Date.parse("2026-09-30T23:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

// 72 hourly buckets ending at the last reading, the 10th one empty.
function historyFor(host: string): History {
    return {
        host,
        range: "30d",
        bucket: "1h",
        from: iso(end - 71 * HOUR),
        to: iso(end),
        buckets: Array.from({ length: 72 }, (_, i) => {
            const empty = i === 10;
            const value = (avg: number) => ({
                avg: empty ? null : avg,
                max: empty ? null : avg + 1,
            });
            return {
                start: iso(end - (71 - i) * HOUR),
                count: empty ? 0 : 4,
                cpuPercent: value(30),
                ramPercent: value(50),
                diskPercent: value(60 + i / 10),
                netInMbps: value(12),
                netOutMbps: value(4),
            };
        }),
    };
}

function forecastFor(
    host: string,
    metric: string,
    horizon: Forecast["horizon"],
): Forecast {
    const hours = { "24h": 24, "7d": 168, "30d": 720 }[horizon];
    return {
        host,
        metric: metric as Forecast["metric"],
        horizon,
        history: {
            from: "2026-09-01T00:00:00.000Z",
            to: iso(end),
            days: 30,
        },
        model: "hour-of-week-trend",
        backtest: {
            method: horizon === "24h" ? "rolling-origin" : "holdout",
            origins: horizon === "24h" ? 7 : 1,
            holdoutHours: horizon === "30d" ? 360 : 168,
            holdoutShorterThanHorizon: horizon === "30d",
            scores: [
                { model: "linear-trend", mae: 2.5, mape: 3.1, skipped: null },
                {
                    model: "hour-of-week-trend",
                    mae: 1.23,
                    mape: 1.9,
                    skipped: null,
                },
                { model: "holt-winters", mae: 1.8, mape: 2.4, skipped: null },
            ],
        },
        band: { level: 0.8 },
        points: Array.from({ length: hours }, (_, h) => ({
            timestamp: iso(end + (h + 1) * HOUR),
            value: 67 + h / 10,
            lower: 65 + h / 10,
            upper: 69 + h / 10,
        })),
        thresholds: null,
        note: "Forecasts are estimates, not a guarantee.",
    };
}

const capacity: Capacity = {
    datasetId: 1,
    thresholds: [80, 90, 100],
    note: "Forecasts are estimates, not a guarantee.",
    rows: [
        {
            host: "web-01",
            metric: "diskPercent",
            model: "linear-trend",
            latest: 91.5,
            thresholds: [
                { percent: 80, crossesAt: null, alreadyAbove: true },
                { percent: 90, crossesAt: null, alreadyAbove: true },
                {
                    percent: 100,
                    crossesAt: "2026-10-12T14:00:00.000Z",
                    alreadyAbove: false,
                },
            ],
        },
        {
            host: "web-01",
            metric: "ramPercent",
            model: "holt-winters",
            latest: 52.26,
            thresholds: [80, 90, 100].map((percent) => ({
                percent,
                crossesAt: null,
                alreadyAbove: false,
            })),
        },
        {
            host: "new-01",
            metric: "diskPercent",
            insufficient: { days: 7, requiredDays: 14 },
        },
    ],
};

describe("forecast page", () => {
    let window: Window;
    let doc: Document;
    const el = (id: string) => doc.getElementById(id)!;
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const texts = (id: string) =>
        [...el(id).children].map((r) =>
            [...r.children].map((c) => c.textContent),
        );
    const change = (id: string, value: string) => {
        (el(id) as HTMLSelectElement).value = value;
        el(id).dispatchEvent(new window.Event("change") as unknown as Event);
    };
    // Routes API requests to synthetic responses; overrides win.
    function api(
        overrides: Record<string, () => Response | Promise<Response>> = {},
    ) {
        const fetch = vi.fn((input: string, _init?: RequestInit) => {
            const url = new URL(input, "http://localhost");
            const key = Object.keys(overrides).find((k) => input.includes(k));
            if (key) return Promise.resolve(overrides[key]!());
            if (url.pathname === "/api/datasets")
                return Promise.resolve(
                    Response.json({
                        datasets: [1, 2].map((id) => ({
                            id,
                            name: `servers-${id}`,
                            startsAt: "2026-09-01T00:00:00.000Z",
                            endsAt: iso(end),
                        })),
                        limits: {},
                    }),
                );
            if (url.pathname.endsWith("/hosts"))
                return Promise.resolve(
                    Response.json({
                        hosts: ["web-01", "new-01"],
                        hasMore: false,
                    }),
                );
            if (url.pathname.endsWith("/capacity"))
                return Promise.resolve(Response.json(capacity));
            const host = url.searchParams.get("host")!;
            if (url.pathname.endsWith("/forecast"))
                return Promise.resolve(
                    Response.json(
                        forecastFor(
                            host,
                            url.searchParams.get("metric")!,
                            url.searchParams.get(
                                "horizon",
                            ) as Forecast["horizon"],
                        ),
                    ),
                );
            return Promise.resolve(Response.json(historyFor(host)));
        });
        vi.stubGlobal("fetch", fetch);
        return fetch;
    }
    const urls = (fetch: ReturnType<typeof api>) =>
        fetch.mock.calls.map(([u]) => u);

    beforeEach(() => {
        window = new Window({ url: "http://localhost/forecast?dataset=1" });
        doc = window.document as unknown as Document;
        vi.stubGlobal("document", doc);
        vi.stubGlobal("location", window.location);
        vi.stubGlobal("history", window.history);
        doc.body.innerHTML = `
            <a href="/history" data-dataset-link></a>
            <select id="dataset"></select><select id="host"></select><div id="host-filter" hidden><input id="host-search"/></div>
            <p id="host-hint"></p>
            <select id="metric" data-reloads-selection>${metricFields.map(([f]) => `<option value="${f}">${f}</option>`).join("")}</select>
            <select id="horizon" data-reloads-selection><option value="24h">24h</option><option value="7d" selected>7d</option><option value="30d">30d</option></select>
            <p id="status"></p><p id="dashboard-error" hidden></p><button id="retry" hidden></button>
            <div id="results" hidden><h2 id="selection-title"></h2><p id="summary"></p>
            <span id="band-label"></span><div id="chart"></div>
            <table><caption id="chart-caption"></caption><tbody id="chart-rows"></tbody></table>
            <div id="model"></div><p id="note"></p></div>
            <div id="capacity" hidden><p id="capacity-status"></p>
            <div id="capacity-table" hidden><table><tbody id="capacity-rows"></tbody></table></div><p id="capacity-note"></p></div>`;
    });

    it("draws history and the forecast with its band, the model and the capacity table", async () => {
        const fetch = api();
        await initForecast(doc);
        await flush();
        expect(el("results").hidden).toBe(false);
        expect(el("status").textContent).toBe("");
        expect(urls(fetch)).toContain(
            "/api/datasets/1/forecast?host=web-01&metric=cpuPercent&horizon=7d",
        );
        expect(urls(fetch)).toContain(
            "/api/datasets/1/history?host=web-01&range=30d&bucket=1h",
        );
        // all readings: no time range on this page
        expect(urls(fetch).some((u) => u.includes("range=all"))).toBe(false);
        expect(el("selection-title").textContent).toBe("web-01");

        const chart = el("chart");
        // history broken at the empty hour, then one dashed forecast line and band
        expect(chart.querySelectorAll("polyline.avg")).toHaveLength(2);
        expect(chart.querySelectorAll("polyline.forecast")).toHaveLength(1);
        expect(chart.querySelectorAll("polygon.area.forecast")).toHaveLength(1);
        expect(chart.querySelectorAll("rect.band")).toHaveLength(1);
        expect(chart.innerHTML).not.toMatch(/NaN|Infinity/);
        // the forecast starts at the last reading, so it joins the history line
        const forecastLine = chart
            .querySelector("polyline.forecast")!
            .getAttribute("points")!
            .split(" ");
        const history = chart
            .querySelectorAll("polyline.avg")[1]!
            .getAttribute("points")!
            .split(" ");
        expect(forecastLine[0]).toBe(history.at(-1));
        expect(forecastLine).toHaveLength(169);

        expect(el("chart-rows").children).toHaveLength(168);
        expect(texts("chart-rows")[0]).toEqual([
            "2026-10-01 00:00",
            "67",
            "65",
            "69",
        ]);
        expect(el("band-label").textContent).toBe("80% range");
        expect([...el("model").children].map((p) => p.textContent)).toEqual([
            "Model: a trend plus the usual level for each hour of the week, the most accurate of 3 models tested.",
            "Tested by forecasting the last 7 days of readings from the ones before: off by 1.23 percentage points on average (MAE), or 1.9% of the actual value (MAPE).",
        ]);
        expect(el("note").textContent).toBe(
            "Forecasts are estimates, not a guarantee.",
        );

        expect(el("capacity").hidden).toBe(false);
        expect(el("capacity-table").hidden).toBe(false);
        expect(texts("capacity-rows")).toEqual([
            [
                "web-01",
                "Disk",
                "91.5 %",
                "Already above",
                "Already above",
                "2026-10-12 14:00",
            ],
            [
                "web-01",
                "RAM",
                "52.3 %",
                "Not within 30 days",
                "Not within 30 days",
                "Not within 30 days",
            ],
            ["new-01", "Disk", "Not enough history: 7 of 14 days"],
        ]);
        expect(
            el("capacity-rows").children[2]!.lastElementChild!.getAttribute(
                "colspan",
            ),
        ).toBe("4");
    });

    it("keeps loading hosts when the metric or horizon changes meanwhile", async () => {
        let resolveHosts!: (r: Response) => void;
        const fetch = api({
            "/hosts": () =>
                new Promise<Response>((resolve) => (resolveHosts = resolve)),
        });
        const loading = initForecast(doc);
        await flush();
        expect(el("status").textContent).toBe("Loading hosts…");
        change("horizon", "24h");
        change("metric", "diskPercent");
        resolveHosts(
            Response.json({ hosts: ["web-01", "new-01"], hasMore: false }),
        );
        await loading;
        await flush();
        expect((el("host") as HTMLSelectElement).value).toBe("web-01");
        expect(el("results").hidden).toBe(false);
        // the first selection already uses the new options
        expect(urls(fetch).filter((u) => u.includes("/forecast"))).toEqual([
            "/api/datasets/1/forecast?host=web-01&metric=diskPercent&horizon=24h",
        ]);
    });

    it("refetches the forecast for a new metric or horizon, not the capacity", async () => {
        const fetch = api();
        await initForecast(doc);
        await flush();
        change("horizon", "24h");
        await flush();
        await flush();
        expect(urls(fetch)).toContain(
            "/api/datasets/1/forecast?host=web-01&metric=cpuPercent&horizon=24h",
        );
        // a week of history before a day ahead
        expect(urls(fetch)).toContain(
            "/api/datasets/1/history?host=web-01&range=7d&bucket=1h",
        );
        expect(el("chart-rows").children).toHaveLength(24);
        expect(el("model").children[1]!.textContent).toBe(
            "Tested by forecasting each of the last 7 days from the readings before it: off by 1.23 percentage points on average (MAE), or 1.9% of the actual value (MAPE).",
        );
        change("metric", "netInMbps");
        await flush();
        await flush();
        expect(el("model").children[1]!.textContent).toContain("1.23 Mbps");
        expect(urls(fetch).filter((u) => u.endsWith("/capacity"))).toHaveLength(
            1,
        );
    });

    it("shows the API's reason instead of a chart when the host has under 14 days", async () => {
        api({
            "/forecast?host=web-01": () =>
                Response.json(
                    {
                        error: "Forecasting needs at least 14 days of readings for this host; it has 7.0.",
                        days: 7,
                        requiredDays: 14,
                    },
                    { status: 422 },
                ),
        });
        await initForecast(doc);
        await flush();
        expect(el("results").hidden).toBe(true);
        expect(el("dashboard-error").hidden).toBe(true);
        expect(el("status").textContent).toBe(
            "Forecasting needs at least 14 days of readings for this host; it has 7.0.",
        );
        expect(el("chart").children).toHaveLength(0);
        // the dataset's capacity table is still shown
        expect(el("capacity-table").hidden).toBe(false);
    });

    it("reports other errors with a retry", async () => {
        api({
            "/forecast?host=web-01": () =>
                Response.json({ error: "Server error" }, { status: 500 }),
        });
        await initForecast(doc);
        await flush();
        expect(el("results").hidden).toBe(true);
        expect(el("dashboard-error").textContent).toBe("Server error");
        expect(el("retry").hidden).toBe(false);
    });

    it("reloads the capacity table for another dataset and ignores the old one", async () => {
        let resolveOld!: (r: Response) => void;
        const fetch = api({
            "/datasets/1/capacity": () =>
                new Promise<Response>((resolve) => (resolveOld = resolve)),
            "/datasets/2/capacity": () =>
                Response.json({
                    ...capacity,
                    datasetId: 2,
                    rows: [capacity.rows[2]],
                }),
        });
        await initForecast(doc);
        await flush();
        expect(el("capacity-status").textContent).toBe(
            "Forecasting disk and RAM for every host…",
        );
        change("dataset", "2");
        await flush();
        await flush();
        resolveOld(Response.json(capacity));
        await flush();
        expect(texts("capacity-rows")).toEqual([
            ["new-01", "Disk", "Not enough history: 7 of 14 days"],
        ]);
        expect(urls(fetch)).toContain("/api/datasets/2/capacity");
    });
});

it("counts only the models the backtest could score", () => {
    const f = forecastFor("web-01", "diskPercent", "7d");
    f.backtest.scores[2] = {
        model: "holt-winters",
        mae: null,
        mape: null,
        skipped: "needs 14 days of training",
    };
    expect(describeModel(f)[0]).toBe(
        "Model: a trend plus the usual level for each hour of the week, the most accurate of 2 models tested.",
    );
});

it("describes a backtest shorter than the horizon", () => {
    const f = forecastFor("web-01", "diskPercent", "30d");
    expect(describeModel(f)).toEqual([
        "Model: a trend plus the usual level for each hour of the week, the most accurate of 3 models tested.",
        "Tested by forecasting the last 15 days of readings from the ones before: off by 1.23 percentage points on average (MAE), or 1.9% of the actual value (MAPE).",
        "That test covers 15 days, less than the 30 days ahead, so later hours may be further off.",
    ]);
    expect(
        describeModel({
            ...f,
            backtest: {
                ...f.backtest,
                scores: [
                    {
                        model: "hour-of-week-trend",
                        mae: 0.5,
                        mape: null,
                        skipped: null,
                    },
                ],
            },
        })[1],
    ).toBe(
        "Tested by forecasting the last 15 days of readings from the ones before: off by 0.5 percentage points on average (MAE).",
    );
    expect(
        crossingText({ percent: 90, crossesAt: null, alreadyAbove: false }),
    ).toBe("Not within 30 days");
});
