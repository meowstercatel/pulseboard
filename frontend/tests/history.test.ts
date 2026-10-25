import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { metricFields } from "../src/lib/dashboardControls";
import {
    bucketSizes,
    duration,
    filled,
    findGaps,
    findSpikes,
    heatmap,
    niceMax,
    pickBucket,
    utc,
    type Bucket,
    type BucketSize,
    type History,
} from "../src/lib/history";
import { initHistory } from "../src/lib/historyPage";

// Bucket a sample CSV the way GET /api/datasets/:id/history does: UTC-aligned
// buckets from the first to the last reading, empty ones with count 0.
const columns = [
    "cpuPercent",
    "ramPercent",
    "diskPercent",
    "netInMbps",
    "netOutMbps",
] as const;
function sampleHistory(file: string, bucket: BucketSize) {
    const ms = bucketSizes[bucket];
    const rows = readFileSync(
        new URL(`../../samples/${file}`, import.meta.url),
        "utf8",
    )
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => line.split(","));
    const hosts = new Map<string, Map<number, number[][]>>();
    for (const [time, host, ...values] of rows) {
        const start = Math.floor(Date.parse(time!) / ms) * ms;
        const byStart = hosts.get(host!) ?? new Map();
        hosts.set(host!, byStart);
        byStart.set(start, [...(byStart.get(start) ?? []), values.map(Number)]);
    }
    return new Map(
        [...hosts].map(([host, byStart]): [string, History] => {
            const starts = [...byStart.keys()];
            const buckets: Bucket[] = [];
            for (
                let t = Math.min(...starts);
                t <= Math.max(...starts);
                t += ms
            ) {
                const readings = byStart.get(t) ?? [];
                buckets.push({
                    start: new Date(t).toISOString(),
                    count: readings.length,
                    ...Object.fromEntries(
                        columns.map((field, i) => {
                            const v = readings.map((r) => r[i]!);
                            return [
                                field,
                                v.length
                                    ? {
                                          avg:
                                              v.reduce((a, b) => a + b, 0) /
                                              v.length,
                                          max: Math.max(...v),
                                      }
                                    : { avg: null, max: null },
                            ];
                        }),
                    ),
                } as Bucket);
            }
            return [
                host,
                { host, range: "all", bucket, from: null, to: null, buckets },
            ];
        }),
    );
}

function analyse(file: string, bucket: BucketSize) {
    return [...sampleHistory(file, bucket)].map(([host, history]) => {
        const { buckets, times, spacing, bucketMs } = filled(history);
        return {
            host,
            gaps: findGaps(times, spacing).map(
                (g) =>
                    `${utc(g.start)} – ${utc(g.end)} (${duration(g.end - g.start)})`,
            ),
            spikes: metricFields.flatMap(([field]) =>
                findSpikes(
                    field,
                    times,
                    buckets.map((b) => b[field].max!),
                    bucketMs,
                    spacing,
                ).map((s) => `${field} ${utc(s.start)} – ${utc(s.end)}`),
            ),
        };
    });
}

describe("samples/gaps-and-anomalies-14d.csv", () => {
    // samples/README.md lists these gaps and spikes.
    const gaps = {
        "web-01": ["2026-09-04 09:00 – 2026-09-04 15:00 (6 h)"],
        "db-01": ["2026-09-09 22:00 – 2026-09-11 04:00 (1 d 6 h)"],
    };
    it.each(["5m", "1h"] as const)(
        "finds every gap and spike exactly with %s buckets",
        (bucket) => {
            expect(analyse("gaps-and-anomalies-14d.csv", bucket)).toEqual([
                {
                    host: "web-01",
                    gaps: gaps["web-01"],
                    spikes: [
                        "cpuPercent 2026-09-03 14:00 – 2026-09-03 16:00",
                        "netInMbps 2026-09-11 19:00 – 2026-09-11 22:00",
                    ],
                },
                {
                    host: "db-01",
                    gaps: gaps["db-01"],
                    spikes: ["ramPercent 2026-09-06 03:00 – 2026-09-06 04:00"],
                },
            ]);
        },
    );
    it("finds the spike days with 1d buckets", () => {
        // Daily buckets only show db-01's empty 09-10; the network spike lifts
        // both directions.
        expect(analyse("gaps-and-anomalies-14d.csv", "1d")).toEqual([
            {
                host: "web-01",
                gaps: [],
                spikes: [
                    "cpuPercent 2026-09-03 00:00 – 2026-09-04 00:00",
                    "netInMbps 2026-09-11 00:00 – 2026-09-12 00:00",
                    "netOutMbps 2026-09-11 00:00 – 2026-09-12 00:00",
                ],
            },
            {
                host: "db-01",
                gaps: ["2026-09-10 00:00 – 2026-09-11 00:00 (1 d)"],
                spikes: ["ramPercent 2026-09-06 00:00 – 2026-09-07 00:00"],
            },
        ]);
    });
});

it.each(["5m", "1h", "1d"] as const)(
    "raises no false alarms on samples/servers-30d.csv with %s buckets",
    (bucket) => {
        for (const result of analyse("servers-30d.csv", bucket))
            expect(result).toEqual({ host: result.host, gaps: [], spikes: [] });
    },
);

it("averages 1h buckets by UTC weekday and hour, weighted by readings", () => {
    const history = sampleHistory("gaps-and-anomalies-14d.csv", "1h").get(
        "web-01",
    )!;
    const cells = heatmap(history.buckets, "cpuPercent");
    // 2026-09-03 is a Thursday: the 14:00 cell holds that spike hour and
    // 2026-09-10 14:00.
    const thursday = history.buckets.filter((b) =>
        ["2026-09-03T14:00:00.000Z", "2026-09-10T14:00:00.000Z"].includes(
            b.start,
        ),
    );
    expect(cells[3]![14]).toEqual({
        value:
            (thursday[0]!.cpuPercent.avg! + thursday[1]!.cpuPercent.avg!) / 2,
        hours: 2,
    });
    // The 2026-09-04 (Friday) gap leaves those hours with one week only.
    expect(cells[4]![10]!.hours).toBe(1);
    const partial = [
        { ...thursday[0]!, count: 1 },
        { ...thursday[1]!, count: 3 },
    ];
    expect(heatmap(partial, "cpuPercent")[3]![14]!.value).toBeCloseTo(
        (thursday[0]!.cpuPercent.avg! + 3 * thursday[1]!.cpuPercent.avg!) / 4,
    );
    expect(
        heatmap([], "ramPercent")
            .flat()
            .every((c) => c.value === null),
    ).toBe(true);
});

it("picks the finest bucket within the API's 2,000-bucket limit", () => {
    const span = (days: number) => ({
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: new Date(
            Date.parse("2026-09-01T00:00:00Z") + days * 86400000 - 900000,
        ).toISOString(),
    });
    expect(pickBucket("1h", span(30))).toBe("5m");
    expect(pickBucket("24h", span(30))).toBe("5m");
    expect(pickBucket("7d", span(30))).toBe("1h");
    expect(pickBucket("30d", span(30))).toBe("1h");
    expect(pickBucket("all", span(6))).toBe("5m");
    expect(pickBucket("all", span(14))).toBe("1h");
    expect(pickBucket("all", span(30))).toBe("1h");
    expect(pickBucket("all", span(365))).toBe("1d");
    expect(pickBucket("all", { startsAt: null, endsAt: null })).toBe("5m");
});

it("formats durations and axis maxima", () => {
    expect(duration(6 * 3600000)).toBe("6 h");
    expect(duration(30 * 3600000)).toBe("1 d 6 h");
    expect(duration(45 * 60000)).toBe("45 min");
    expect([0, 0.4, 7, 15.85, 675.44].map(niceMax)).toEqual([
        1, 0.5, 10, 20, 1000,
    ]);
});

describe("history page", () => {
    let window: Window;
    let doc: Document;
    const el = (id: string) => doc.getElementById(id)!;
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const texts = (id: string) =>
        [...el(id).children].map((r) =>
            [...r.children].map((c) => c.textContent),
        );
    const sample = sampleHistory("gaps-and-anomalies-14d.csv", "1h");
    const statsFor = (host: string, count = 1320) => ({
        host,
        range: "all",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-14T23:45:00.000Z",
        metrics: Object.fromEntries(
            metricFields.map(([field]) => [
                field,
                {
                    count,
                    min: 1,
                    avg: 2,
                    max: 3,
                    p95: 2.5,
                    ...(field.endsWith("Percent") && {
                        shareAbove80: 0.006,
                        shareAbove90: 0,
                    }),
                },
            ]),
        ),
    });
    // Routes API requests to sample-backed responses; overrides win.
    function api(
        overrides: Record<string, () => Response | Promise<Response>> = {},
    ) {
        const fetch = vi.fn((input: string) => {
            const url = new URL(input, "http://localhost");
            const key = Object.keys(overrides).find((k) => input.includes(k));
            if (key) return Promise.resolve(overrides[key]!());
            if (url.pathname === "/api/datasets")
                return Promise.resolve(
                    Response.json({
                        datasets: [
                            {
                                id: 1,
                                name: "gaps",
                                startsAt: "2026-09-01T00:00:00.000Z",
                                endsAt: "2026-09-14T23:45:00.000Z",
                            },
                        ],
                        limits: {},
                    }),
                );
            if (url.pathname.endsWith("/hosts"))
                return Promise.resolve(
                    Response.json({
                        hosts: ["web-01", "db-01"],
                        hasMore: false,
                    }),
                );
            const host = url.searchParams.get("host")!;
            if (url.pathname.endsWith("/stats"))
                return Promise.resolve(Response.json(statsFor(host)));
            return Promise.resolve(
                Response.json({
                    ...(sample.get(host) ?? sample.get("web-01")),
                    host,
                }),
            );
        });
        vi.stubGlobal("fetch", fetch);
        return fetch;
    }
    beforeEach(() => {
        window = new Window({ url: "http://localhost/history?dataset=1" });
        doc = window.document as unknown as Document;
        vi.stubGlobal("document", doc);
        vi.stubGlobal("location", window.location);
        vi.stubGlobal("history", window.history);
        const table = (id: string) =>
            `<table><thead id="${id}-head"></thead><tbody id="${id}-rows"></tbody></table>`;
        doc.body.innerHTML = `
            <a href="/overview" data-dataset-link></a>
            <select id="dataset"></select><select id="host"></select><div id="host-filter" hidden><input id="host-search"/></div>
            <select id="range"><option value="all">All</option><option value="24h">Day</option></select>
            <p id="host-hint"></p><p id="status"></p><p id="dashboard-error" hidden></p><button id="retry" hidden></button>
            <div id="results" hidden><h2 id="selection-title"></h2><p id="summary"></p>${table("stats")}
            ${metricFields.map(([field]) => `<div id="chart-${field}"></div><table><tbody id="chart-rows-${field}"></tbody></table>`).join("")}
            <p id="gap-note"></p><p id="gap-empty"></p><div id="gap-table">${table("gap")}</div>
            <p id="spike-empty"></p><div id="spike-table">${table("spike")}</div>
            <select id="heatmap-metric"><option value="cpuPercent">CPU</option><option value="ramPercent">RAM</option></select>
            <p id="heatmap-status"></p><div id="heatmap-content"><div id="heatmap"></div><table><caption id="heatmap-caption"></caption><tbody id="heatmap-rows"></tbody></table></div>
            <select id="compare-metric"></select><select id="compare-series"><option value="avg">Average</option><option value="max">Maximum</option></select>
            <p id="compare-status"></p><div id="compare-content"><ul id="compare-legend"></ul><div id="compare-chart"></div>
            <table><caption id="compare-caption"></caption><thead id="compare-head"></thead><tbody id="compare-rows"></tbody></table></div></div>`;
    });

    it("renders statistics, charts, gaps, spikes, heatmap and compared hosts", async () => {
        const fetch = api();
        await initHistory(doc);
        await flush();
        expect(el("results").hidden).toBe(false);
        expect(el("selection-title").textContent).toBe("web-01");
        expect(el("summary").textContent).toBe(
            "1,320 readings · 2026-09-01 00:00 – 2026-09-14 23:45 UTC · 1-hour buckets",
        );
        expect(texts("stats-rows")[0]).toEqual([
            "CPU usage",
            "1 %",
            "2 %",
            "3 %",
            "2.5 %",
            "0.6%",
            "0%",
        ]);
        expect(texts("stats-rows")[3]!.slice(5)).toEqual(["–", "–"]);
        expect(texts("gap-rows")).toEqual([
            ["2026-09-04 09:00", "2026-09-04 15:00", "6 h"],
        ]);
        expect(texts("spike-rows").map((r) => r.slice(0, 3))).toEqual([
            ["CPU usage", "2026-09-03 14:00", "2026-09-03 16:00"],
            ["Incoming network", "2026-09-11 19:00", "2026-09-11 22:00"],
        ]);
        // Avg and max lines, broken at the gap, with markers on both CPU spike hours.
        const cpu = el("chart-cpuPercent");
        expect(cpu.querySelectorAll("polyline.max")).toHaveLength(2);
        expect(cpu.querySelectorAll("rect.band")).toHaveLength(1);
        expect(cpu.querySelectorAll(".marker")).toHaveLength(2);
        expect(cpu.innerHTML).not.toMatch(/NaN|Infinity/);
        expect(el("chart-rows-cpuPercent").children).toHaveLength(330);
        // 1h buckets already: the heatmap reuses them without a second request.
        expect(
            fetch.mock.calls.filter(([u]) => u.includes("/history?")),
        ).toHaveLength(3);
        expect(texts("heatmap-rows")).toHaveLength(7);
        expect(el("heatmap").querySelectorAll(".cell")).toHaveLength(168);
        expect(el("heatmap-caption").textContent).toContain("CPU usage");
        (el("heatmap-metric") as HTMLSelectElement).value = "ramPercent";
        el("heatmap-metric").dispatchEvent(
            new window.Event("change") as unknown as Event,
        );
        expect(el("heatmap-caption").textContent).toContain("RAM usage");
        expect(
            [...el("compare-legend").children].map((li) => li.textContent),
        ).toEqual(["web-01", "db-01"]);
        expect(el("compare-chart").querySelectorAll(".dot")).toHaveLength(2);
        expect(texts("compare-rows")[0]).toHaveLength(3);
        expect(
            doc.querySelector("[data-dataset-link]")!.getAttribute("href"),
        ).toBe("/overview?dataset=1");
    });

    it("keyboard-inspects buckets and skips empty ones", async () => {
        api();
        await initHistory(doc);
        const chart = el("chart-cpuPercent");
        const plot = chart.querySelector<HTMLElement>(".plot")!;
        const key = (k: string) =>
            plot.dispatchEvent(
                new window.KeyboardEvent("keydown", {
                    key: k,
                }) as unknown as Event,
            );
        plot.dispatchEvent(new window.FocusEvent("focus") as unknown as Event);
        key("Home");
        expect(chart.querySelector(".tooltip-label")!.textContent).toBe(
            "2026-09-01 00:00 UTC · 4 readings",
        );
        expect(chart.querySelector(".tooltip-value")!.textContent).toMatch(
            /^Max .* %\nAvg .* %$/,
        );
    });

    it("uses 5m buckets for a day, fetches 1h buckets for the heatmap, and keeps the page when that fails", async () => {
        const fetch = api({
            "bucket=1h": () =>
                Response.json({ error: "Too many buckets" }, { status: 400 }),
        });
        await initHistory(doc);
        (el("range") as HTMLSelectElement).value = "24h";
        el("range").dispatchEvent(
            new window.Event("change") as unknown as Event,
        );
        await flush();
        await flush();
        expect(
            fetch.mock.calls.some(([u]) => u.includes("range=24h&bucket=5m")),
        ).toBe(true);
        expect(el("results").hidden).toBe(false);
        expect(el("heatmap-status").textContent).toBe("Too many buckets");
        expect(el("heatmap-content").hidden).toBe(true);
    });

    it("compares at most 10 hosts", async () => {
        const hosts = Array.from(
            { length: 12 },
            (_, i) => `host-${String(i).padStart(2, "0")}`,
        );
        api({ "hosts?q=": () => Response.json({ hosts, hasMore: false }) });
        await initHistory(doc);
        await flush();
        expect(el("compare-legend").children).toHaveLength(10);
        expect(el("compare-status").textContent).toBe(
            "Showing the first 10 of 12 hosts, sorted by name.",
        );
    });

    it("ignores a slower response for an earlier selection", async () => {
        let resolveOld!: (r: Response) => void;
        let calls = 0;
        api({
            "/stats?host=web-01": () =>
                ++calls === 1
                    ? new Promise<Response>((resolve) => (resolveOld = resolve))
                    : Response.json(statsFor("web-01")),
        });
        const loading = initHistory(doc);
        await flush();
        (el("host") as HTMLSelectElement).value = "db-01";
        el("host").dispatchEvent(
            new window.Event("change") as unknown as Event,
        );
        await flush();
        await flush();
        expect(el("selection-title").textContent).toBe("db-01");
        resolveOld(Response.json(statsFor("web-01")));
        await loading;
        await flush();
        expect(el("selection-title").textContent).toBe("db-01");
        expect(texts("spike-rows").map((r) => r[0])).toEqual(["RAM usage"]);
    });

    it("reports a host without readings in the range", async () => {
        api({ "/stats": () => Response.json(statsFor("web-01", 0)) });
        await initHistory(doc);
        expect(el("results").hidden).toBe(true);
        expect(el("status").textContent).toBe(
            "No readings for this host and time range.",
        );
    });
});
