// Hover/keyboard crosshair tooltip for a line chart: the landing page's
// UsageChart.astro, or a chart drawn by historyChart.ts with its own data.
const ago = (minutes: number) => {
    if (minutes === 0) return "now";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h ? `${h}h ` : ""}${m ? `${m}m ` : ""}ago`;
};

export type UsageChartData = {
    // x position of each sample, e.g. a timestamp; must be ascending
    times: number[];
    // One series per line; null marks a sample with no value
    lines: (number | null)[][];
    max: number;
    label: (index: number) => string;
    value: (index: number) => string;
};

// The landing chart: one evenly spaced 0-100% series ending "now".
function datasetData(chart: HTMLElement): UsageChartData {
    const series: number[] = JSON.parse(chart.dataset.series ?? "[]");
    const interval = Number(chart.dataset.interval ?? 5);
    return {
        times: series.map((_, i) => i),
        lines: [series],
        max: 100,
        label: (i) => ago((series.length - 1 - i) * interval),
        value: (i) => `${series[i]}%`,
    };
}

export type UsageChartControls = {
    // Shows the crosshair at the n-th sample that has a value
    show: (position: number) => void;
    hide: () => void;
    count: number;
};

export function initUsageChart(
    chart: HTMLElement,
    data: UsageChartData = datasetData(chart),
): UsageChartControls | undefined {
    const { times, lines, max } = data;
    const plot = chart.querySelector<HTMLElement>(".plot")!;
    const crosshair = chart.querySelector<HTMLElement>(".crosshair")!;
    const dots = [...chart.querySelectorAll<HTMLElement>(".dot")];
    const tooltip = chart.querySelector<HTMLElement>(".tooltip")!;
    const value = chart.querySelector<HTMLElement>(".tooltip-value")!;
    const label = chart.querySelector<HTMLElement>(".tooltip-label")!;
    const start = times[0] ?? 0;
    const span = (times.at(-1) ?? start) - start;
    const xPct = (i: number) =>
        span ? ((times[i]! - start) / span) * 100 : 50;
    // Samples with no value on any line are skipped when inspecting.
    const samples = times
        .map((_, i) => i)
        .filter((i) => lines.some((line) => line[i] != null));
    if (!samples.length) return;
    let position = samples.length - 1;

    const show = (p: number) => {
        position = Math.max(0, Math.min(samples.length - 1, p));
        const index = samples[position]!;
        const x = xPct(index);
        crosshair.style.left = `${x}%`;
        dots.forEach((dot, line) => {
            const v = lines[line]?.[index];
            dot.hidden = v == null;
            dot.style.left = `${x}%`;
            if (v != null) dot.style.top = `${100 - (v / max) * 100}%`;
        });
        value.textContent = data.value(index);
        label.textContent = data.label(index);
        // Keep the tooltip inside the plot: flip to the left past the midpoint.
        tooltip.style.left = x > 50 ? "" : `calc(${x}% + 8px)`;
        tooltip.style.right = x > 50 ? `calc(${100 - x}% + 8px)` : "";
        crosshair.hidden = tooltip.hidden = false;
    };
    const hide = () => {
        crosshair.hidden = tooltip.hidden = true;
        dots.forEach((dot) => (dot.hidden = true));
    };

    plot.addEventListener("pointermove", (e) => {
        const rect = plot.getBoundingClientRect();
        const target = start + ((e.clientX - rect.left) / rect.width) * span;
        // Nearest sample; a tie goes to the later one.
        show(
            samples.reduce(
                (best, index, p) =>
                    Math.abs(times[index]! - target) <=
                    Math.abs(times[samples[best]!]! - target)
                        ? p
                        : best,
                0,
            ),
        );
    });
    plot.addEventListener("pointerleave", () => {
        if (document.activeElement !== plot) hide();
    });
    plot.addEventListener("focus", () => show(position));
    plot.addEventListener("blur", hide);
    plot.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft") show(position - 1);
        else if (e.key === "ArrowRight") show(position + 1);
        else if (e.key === "Home") show(0);
        else if (e.key === "End") show(samples.length - 1);
        else return;
        e.preventDefault();
    });
    return { show, hide, count: samples.length };
}

const STEP_MS = 400;

// Walks the crosshair along a chart until the user reaches for `area`, so the
// landing demo shows it is interactive. Skipped with reduced motion.
export function autoplay(
    chart: HTMLElement,
    controls: UsageChartControls,
    area: Element,
) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const plot = chart.querySelector<HTMLElement>(".plot")!;
    const tooltip = chart.querySelector<HTMLElement>(".tooltip")!;
    // The walk isn't worth announcing; the user's own inspection is
    tooltip.removeAttribute("role");
    let position = 0;
    let visible = false;
    const observer = new IntersectionObserver(([entry]) => {
        visible = !!entry?.isIntersecting;
    });
    observer.observe(chart);
    const timer = setInterval(() => {
        if (!visible) return;
        controls.show(position);
        position = (position + 1) % controls.count;
    }, STEP_MS);
    const events = ["pointerenter", "pointerdown", "focusin", "keydown"];
    const stop = () => {
        clearInterval(timer);
        observer.disconnect();
        for (const event of events) area.removeEventListener(event, stop);
        tooltip.setAttribute("role", "status");
        // a focused plot keeps its crosshair; pointermove brings it back on hover
        if (document.activeElement !== plot) controls.hide();
    };
    for (const event of events) area.addEventListener(event, stop);
}
