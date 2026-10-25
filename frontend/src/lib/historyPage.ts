// Controller for /history; analysis lives in history.ts.
import {
    dashboardGet,
    fillOptions,
    initSelection,
    metricFields,
    number,
    type MetricField,
    type Request,
    type Selection,
} from "./dashboardControls";
import {
    duration,
    filled,
    findGaps,
    findSpikes,
    heatmap,
    niceMax,
    pickBucket,
    utc,
    weekdays,
    type BucketSize,
    type History,
    type Stats,
} from "./history";
import { renderHistoryChart } from "./historyChart";

export const MAX_COMPARED_HOSTS = 10;
const bucketNames: Record<BucketSize, string> = {
    "5m": "5-minute",
    "1h": "1-hour",
    "1d": "1-day",
};
const heatmapSteps = [20, 40, 60, 80, 100];
const unitOf = (field: MetricField) =>
    metricFields.find(([f]) => f === field)![2];
const labelOf = (field: MetricField) =>
    metricFields.find(([f]) => f === field)![1];
const scaleMax = (field: MetricField, values: (number | null)[]) =>
    field.endsWith("Percent")
        ? 100
        : niceMax(Math.max(0, ...values.map((v) => v ?? 0)));
const share = (value: number | null | undefined) =>
    value == null ? "–" : `${number(Math.round(value * 1000) / 10)}%`;

export function initHistory(doc: Document = document) {
    const byId = <T extends HTMLElement>(id: string) =>
        doc.getElementById(id) as T;
    const cell = (tag: "td" | "th", text: string) => {
        const node = doc.createElement(tag);
        node.textContent = text;
        return node;
    };
    const row = (cells: string[], header = false) => {
        const tr = doc.createElement("tr");
        cells.forEach((text, i) =>
            tr.append(cell(header || (i === 0 && !header) ? "th" : "td", text)),
        );
        if (!header) tr.firstElementChild!.setAttribute("scope", "row");
        return tr;
    };
    const heatmapMetric = byId<HTMLSelectElement>("heatmap-metric");
    const compareMetric = byId<HTMLSelectElement>("compare-metric");
    const compareSeries = byId<HTMLSelectElement>("compare-series");
    fillOptions(
        doc,
        compareMetric,
        metricFields.map(([value, label]) => ({ value, label })),
    );
    let heatmapData: History | null = null;
    let compared: { histories: History[]; note: string } | null = null;

    function clear() {
        byId("selection-title").textContent = "";
        byId("summary").textContent = "";
        byId("stats-rows").replaceChildren();
        for (const [field] of metricFields) {
            byId(`chart-${field}`).replaceChildren();
            byId(`chart-rows-${field}`).replaceChildren();
        }
        for (const id of ["gap", "spike"]) {
            byId(`${id}-rows`).replaceChildren();
            byId(`${id}-table`).hidden = true;
            byId(`${id}-empty`).textContent = "";
        }
        byId("gap-note").textContent = "";
        heatmapData = null;
        compared = null;
        renderHeatmap();
        renderCompare("");
    }

    function renderStats(stats: Stats) {
        for (const [field, label, unit] of metricFields) {
            const m = stats.metrics[field];
            const value = (v: number | null) =>
                v == null ? "–" : `${number(v)} ${unit}`;
            byId("stats-rows").append(
                row([
                    label,
                    value(m.min),
                    value(m.avg),
                    value(m.max),
                    value(m.p95),
                    share(m.shareAbove80),
                    share(m.shareAbove90),
                ]),
            );
        }
    }

    function renderHost(history: History) {
        const { buckets, times, spacing, bucketMs } = filled(history);
        const gaps = findGaps(times, spacing);
        const spikes = metricFields.flatMap(([field]) =>
            findSpikes(
                field,
                times,
                buckets.map((b) => b[field].max!),
                bucketMs,
                spacing,
            ),
        );
        for (const [field, label, unit] of metricFields) {
            const avg = buckets.map((b) => b[field].avg);
            const max = buckets.map((b) => b[field].max);
            const fieldSpikes = spikes.filter((s) => s.field === field);
            renderHistoryChart(
                byId(`chart-${field}`),
                {
                    title: label,
                    times,
                    lines: [
                        { values: max, kind: "max", gaps },
                        { values: avg, kind: "avg", gaps },
                    ],
                    max: scaleMax(field, max),
                    unit,
                    bands: gaps,
                    markers: times
                        .map((t, i) => i)
                        .filter((i) =>
                            fieldSpikes.some(
                                (s) =>
                                    times[i]! >= s.start && times[i]! < s.end,
                            ),
                        ),
                    label: (i) =>
                        `${utc(times[i]!)} UTC · ${number(buckets[i]!.count)} ${buckets[i]!.count === 1 ? "reading" : "readings"}`,
                    value: (i) =>
                        `Max ${number(max[i]!)} ${unit}\nAvg ${number(avg[i]!)} ${unit}`,
                    axisLabel: utc,
                },
                doc,
            );
            const rows = byId(`chart-rows-${field}`);
            buckets.forEach((b, i) =>
                rows.append(
                    row([
                        utc(times[i]!),
                        number(b.count),
                        number(avg[i]!),
                        number(max[i]!),
                    ]),
                ),
            );
        }
        byId("gap-note").textContent =
            `Detected from ${bucketNames[history.bucket]} buckets, so start and end are accurate to ${duration(spacing)}.`;
        for (const g of gaps)
            byId("gap-rows").append(
                row([utc(g.start), utc(g.end), duration(g.end - g.start)]),
            );
        byId("gap-table").hidden = !gaps.length;
        byId("gap-empty").textContent = gaps.length
            ? ""
            : "No gaps in this range.";
        spikes.sort((a, b) => a.start - b.start);
        for (const s of spikes) {
            const unit = unitOf(s.field);
            byId("spike-rows").append(
                row([
                    labelOf(s.field),
                    utc(s.start),
                    utc(s.end),
                    `${number(s.peak)} ${unit}`,
                    `${number(Math.round(s.typical * 10) / 10)} ${unit}`,
                ]),
            );
        }
        byId("spike-table").hidden = !spikes.length;
        byId("spike-empty").textContent = spikes.length
            ? ""
            : "No spikes in this range.";
    }

    function renderHeatmap(error = "") {
        const grid = byId("heatmap");
        const rows = byId("heatmap-rows");
        grid.replaceChildren();
        rows.replaceChildren();
        byId("heatmap-content").hidden = !heatmapData;
        byId("heatmap-status").textContent = error;
        if (!heatmapData) return;
        const field = heatmapMetric.value as MetricField;
        const cells = heatmap(heatmapData.buckets, field);
        const label = labelOf(field);
        grid.setAttribute(
            "aria-label",
            `Average ${label} by UTC weekday and hour. The table below lists the values.`,
        );
        byId("heatmap-caption").textContent =
            `Average ${label} (%) by UTC weekday and hour`;
        grid.append(doc.createElement("span"));
        for (let h = 0; h < 24; h++) {
            const hour = doc.createElement("span");
            hour.className = "hour";
            hour.textContent = String(h).padStart(2, "0");
            grid.append(hour);
        }
        cells.forEach((day, d) => {
            const name = doc.createElement("span");
            name.className = "day";
            name.textContent = weekdays[d]!;
            grid.append(name);
            day.forEach((c, h) => {
                const square = doc.createElement("span");
                const step =
                    c.value == null
                        ? -1
                        : heatmapSteps.findIndex(
                              (s) => c.value! < s || s === 100,
                          );
                square.className =
                    step < 0 ? "cell empty" : `cell step-${step}`;
                const hours = `${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00`;
                square.dataset.tip =
                    c.value == null
                        ? `${weekdays[d]} ${hours} UTC · No readings`
                        : `${weekdays[d]} ${hours} UTC · ${number(Math.round(c.value * 10) / 10)}% average over ${c.hours} ${c.hours === 1 ? "hour" : "hours"}`;
                grid.append(square);
            });
            rows.append(
                row([
                    weekdays[d]!,
                    ...day.map((c) =>
                        c.value == null
                            ? "–"
                            : number(Math.round(c.value * 10) / 10),
                    ),
                ]),
            );
        });
    }

    function renderCompare(status: string) {
        const chart = byId("compare-chart");
        const legend = byId("compare-legend");
        const head = byId("compare-head");
        const rows = byId("compare-rows");
        chart.replaceChildren();
        legend.replaceChildren();
        head.replaceChildren();
        rows.replaceChildren();
        byId("compare-status").textContent = compared?.note || status;
        byId("compare-content").hidden = !compared;
        if (!compared) return;
        const field = compareMetric.value as MetricField;
        const series = compareSeries.value as "avg" | "max";
        const unit = unitOf(field);
        const hosts = compared.histories.map((history) => {
            const { buckets, times, spacing } = filled(history);
            return {
                name: history.host,
                values: new Map(
                    buckets.map((b, i) => [times[i]!, b[field][series]]),
                ),
                gaps: findGaps(times, spacing),
            };
        });
        const times = [
            ...new Set(hosts.flatMap((h) => [...h.values.keys()])),
        ].sort((a, b) => a - b);
        const lines = hosts.map((h, i) => ({
            values: times.map((t) => h.values.get(t) ?? null),
            kind: `host-${i}`,
            gaps: h.gaps,
        }));
        const title = `${series === "avg" ? "Average" : "Maximum"} ${labelOf(field)}`;
        renderHistoryChart(
            chart,
            {
                title,
                times,
                lines,
                max: scaleMax(
                    field,
                    lines.flatMap((l) => l.values),
                ),
                unit,
                label: (i) => `${utc(times[i]!)} UTC`,
                value: (i) =>
                    hosts
                        .map((h, k) =>
                            lines[k]!.values[i] == null
                                ? `${h.name}: no readings`
                                : `${h.name}: ${number(lines[k]!.values[i]!)} ${unit}`,
                        )
                        .join("\n"),
                axisLabel: utc,
            },
            doc,
        );
        hosts.forEach((h, i) => {
            const item = doc.createElement("li");
            const swatch = doc.createElement("span");
            swatch.className = `swatch host-${i}`;
            swatch.setAttribute("aria-hidden", "true");
            item.append(swatch, h.name);
            legend.append(item);
        });
        head.append(
            row(
                [
                    `Bucket start (UTC)`,
                    ...hosts.map((h) => `${h.name} (${unit})`),
                ],
                true,
            ),
        );
        byId("compare-caption").textContent = `${title} (${unit}) per host`;
        times.forEach((t, i) =>
            rows.append(
                row([
                    utc(t),
                    ...lines.map((l) =>
                        l.values[i] == null ? "–" : number(l.values[i]!),
                    ),
                ]),
            ),
        );
    }

    async function loadCompare(
        { dataset, range }: Selection,
        bucket: BucketSize,
        request: Request,
    ) {
        renderCompare("Loading hosts…");
        try {
            const { hosts, hasMore } = await dashboardGet<{
                hosts: string[];
                hasMore: boolean;
            }>(`/api/datasets/${dataset.id}/hosts?q=`, request.signal);
            const shown = hosts.slice(0, MAX_COMPARED_HOSTS);
            const histories: History[] = new Array(shown.length);
            // Four requests at a time.
            let next = 0;
            await Promise.all(
                Array.from({ length: Math.min(4, shown.length) }, async () => {
                    while (next < shown.length) {
                        const i = next++;
                        histories[i] = await dashboardGet<History>(
                            `/api/datasets/${dataset.id}/history?${new URLSearchParams({ host: shown[i]!, range, bucket })}`,
                            request.signal,
                        );
                    }
                }),
            );
            if (!request.current()) return;
            compared = {
                histories,
                note:
                    hosts.length > shown.length || hasMore
                        ? `Showing the first ${MAX_COMPARED_HOSTS} of ${hasMore ? "more than 100" : hosts.length} hosts, sorted by name.`
                        : "",
            };
            renderCompare("");
        } catch (reason) {
            if (!request.current()) return;
            compared = null;
            renderCompare(
                reason instanceof Error
                    ? reason.message
                    : "Can't reach the server",
            );
        }
    }

    heatmapMetric.addEventListener("change", () => renderHeatmap());
    compareMetric.addEventListener("change", () => renderCompare(""));
    compareSeries.addEventListener("change", () => renderCompare(""));

    return initSelection(
        {
            clear,
            async load(selection, request) {
                const { dataset, host, range } = selection;
                const bucket = pickBucket(range, dataset);
                const url = (
                    path: string,
                    extra: Record<string, string> = {},
                ) =>
                    `/api/datasets/${dataset.id}/${path}?${new URLSearchParams({ host, range, ...extra })}`;
                const [stats, history, hourly] = await Promise.all([
                    dashboardGet<Stats>(url("stats"), request.signal),
                    dashboardGet<History>(
                        url("history", { bucket }),
                        request.signal,
                    ),
                    bucket === "1h"
                        ? null
                        : dashboardGet<History>(
                              url("history", { bucket: "1h" }),
                              request.signal,
                          ).catch((reason: unknown) =>
                              reason instanceof Error ? reason : new Error(),
                          ),
                ]);
                if (!request.current()) return;
                const readings = stats.metrics.cpuPercent.count;
                if (!readings)
                    return "No readings for this host and time range.";
                byId("selection-title").textContent = host;
                byId("summary").textContent =
                    `${number(readings)} ${readings === 1 ? "reading" : "readings"} · ${utc(Date.parse(stats.from!))} – ${utc(Date.parse(stats.to!))} UTC · ${bucketNames[bucket]} buckets`;
                renderStats(stats);
                renderHost(history);
                if (hourly instanceof Error) {
                    heatmapData = null;
                    renderHeatmap(
                        hourly.message ||
                            "Couldn't load hourly readings for the heatmap.",
                    );
                } else {
                    heatmapData = hourly ?? history;
                    renderHeatmap();
                }
                void loadCompare(selection, bucket, request);
            },
        },
        doc,
    );
}
