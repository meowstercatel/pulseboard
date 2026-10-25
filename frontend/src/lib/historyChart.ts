// Draws a time-based line chart for /history; hover and keyboard inspection come
// from initUsageChart() in usageChart.ts.
import { number } from "./dashboardControls";
import type { Gap } from "./history";
import { initUsageChart } from "./usageChart";

const W = 600;
const H = 160;

export type ChartLine = {
    values: (number | null)[];
    // CSS class for the line and its dot, e.g. "avg", "max" or "host-2"
    kind: string;
    // Periods without readings: the line breaks across them
    gaps: Gap[];
};
export type HistoryChart = {
    title: string;
    times: number[];
    lines: ChartLine[];
    max: number;
    unit: string;
    // Shaded periods without readings
    bands?: Gap[];
    // Samples drawn with a spike marker, on the first line
    markers?: number[];
    label: (index: number) => string;
    value: (index: number) => string;
    axisLabel: (time: number) => string;
};

export function renderHistoryChart(
    root: HTMLElement,
    chart: HistoryChart,
    doc: Document = document,
) {
    const { times, lines, max, unit } = chart;
    const start = times[0] ?? 0;
    const span = (times.at(-1) ?? start) - start;
    const x = (t: number) =>
        span ? Math.max(0, Math.min(W, ((t - start) / span) * W)) : W / 2;
    const y = (v: number) => H - (v / max) * H;
    const ticks = [0, 0.25, 0.5, 0.75, 1];
    // Only numbers enter SVG markup; text below uses textContent.
    const segments = (line: ChartLine) => {
        const parts: string[][] = [];
        let previous: number | undefined;
        line.values.forEach((v, i) => {
            if (v == null) return;
            const t = times[i]!;
            const broken =
                previous === undefined ||
                line.gaps.some((g) => g.start > previous! && g.end <= t);
            if (broken) parts.push([]);
            parts.at(-1)!.push(`${x(t)},${y(v)}`);
            previous = t;
        });
        // A lone reading is drawn as a dot by a zero-length line's round caps.
        return parts.map((p) => (p.length === 1 ? [p[0]!, p[0]!] : p));
    };
    const svg =
        ticks
            .map(
                (f) =>
                    `<line class="grid" x1="0" x2="${W}" y1="${y(f * max)}" y2="${y(f * max)}"/>`,
            )
            .join("") +
        (chart.bands ?? [])
            .map(
                (g) =>
                    `<rect class="band" x="${x(g.start)}" y="0" width="${Math.max(1, x(g.end) - x(g.start))}" height="${H}"/>`,
            )
            .join("") +
        lines
            .map((line) =>
                segments(line)
                    .map(
                        (p) =>
                            `<polyline class="line ${line.kind}" points="${p.join(" ")}"/>`,
                    )
                    .join(""),
            )
            .join("");

    const el = (tag: string, className: string, text?: string) => {
        const node = doc.createElement(tag);
        node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const yAxis = el("div", "y-axis");
    yAxis.setAttribute("aria-hidden", "true");
    for (const f of ticks) {
        const tick = el("span", "", `${number(f * max)}`);
        tick.style.top = `${(1 - f) * 100}%`;
        yAxis.append(tick);
    }
    const plot = el("div", "plot");
    plot.tabIndex = 0;
    plot.setAttribute("role", "img");
    plot.setAttribute(
        "aria-label",
        `${chart.title}, 0–${number(max)} ${unit}. Use left and right arrow keys to inspect values.`,
    );
    const drawing = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    drawing.setAttribute("viewBox", `0 0 ${W} ${H}`);
    drawing.setAttribute("preserveAspectRatio", "none");
    drawing.setAttribute("aria-hidden", "true");
    drawing.innerHTML = svg;
    plot.append(drawing);
    for (const i of chart.markers ?? []) {
        const v = lines[0]?.values[i];
        if (v == null) continue;
        const marker = el("span", "marker");
        marker.setAttribute("aria-hidden", "true");
        marker.style.left = `${(x(times[i]!) / W) * 100}%`;
        marker.style.top = `${(y(v) / H) * 100}%`;
        plot.append(marker);
    }
    const crosshair = el("div", "crosshair");
    crosshair.hidden = true;
    plot.append(crosshair);
    for (const line of lines) {
        const dot = el("div", `dot ${line.kind}`);
        dot.hidden = true;
        plot.append(dot);
    }
    const tooltip = el("div", "tooltip");
    tooltip.setAttribute("role", "status");
    tooltip.hidden = true;
    tooltip.append(el("strong", "tooltip-value"), el("span", "tooltip-label"));
    plot.append(tooltip);
    const body = el("div", "body");
    body.append(yAxis, plot);

    const xAxis = el("div", "x-axis");
    xAxis.setAttribute("aria-hidden", "true");
    if (times.length) {
        // The middle label goes on the sample nearest the middle of the span.
        const middle = start + span / 2;
        const centre = times.reduce(
            (best, t, i) =>
                Math.abs(t - middle) < Math.abs(times[best]! - middle)
                    ? i
                    : best,
            0,
        );
        const ends = span ? [...new Set([0, centre, times.length - 1])] : [0];
        for (const i of ends) {
            const tick = el("span", "", chart.axisLabel(times[i]!));
            tick.style.left = `${(x(times[i]!) / W) * 100}%`;
            xAxis.append(tick);
        }
    }
    root.replaceChildren(body, xAxis);
    root.classList.add("usage-chart");
    initUsageChart(root, { ...chart, lines: lines.map((l) => l.values) });
}
