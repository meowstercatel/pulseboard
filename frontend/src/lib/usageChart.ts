// Hover/keyboard crosshair tooltip for a chart rendered by UsageChart.astro
const ago = (minutes: number) => {
    if (minutes === 0) return "now";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h ? `${h}h ` : ""}${m ? `${m}m ` : ""}ago`;
};

export function initUsageChart(chart: HTMLElement) {
    const series: number[] = JSON.parse(chart.dataset.series ?? "[]");
    const interval = Number(chart.dataset.interval ?? 5);
    const plot = chart.querySelector<HTMLElement>(".plot")!;
    const crosshair = chart.querySelector<HTMLElement>(".crosshair")!;
    const dot = chart.querySelector<HTMLElement>(".dot")!;
    const tooltip = chart.querySelector<HTMLElement>(".tooltip")!;
    const value = chart.querySelector<HTMLElement>(".tooltip-value")!;
    const label = chart.querySelector<HTMLElement>(".tooltip-label")!;
    let index = series.length - 1;

    const show = (i: number) => {
        index = Math.max(0, Math.min(series.length - 1, i));
        const xPct = (index / (series.length - 1)) * 100;
        const v = series[index];
        crosshair.style.left = `${xPct}%`;
        dot.style.left = `${xPct}%`;
        dot.style.top = `${100 - v}%`;
        value.textContent = `${v}%`;
        label.textContent = ago((series.length - 1 - index) * interval);
        // Keep the tooltip inside the plot: flip to the left past the midpoint.
        tooltip.style.left = xPct > 50 ? "" : `calc(${xPct}% + 8px)`;
        tooltip.style.right = xPct > 50 ? `calc(${100 - xPct}% + 8px)` : "";
        crosshair.hidden = dot.hidden = tooltip.hidden = false;
    };
    const hide = () => {
        crosshair.hidden = dot.hidden = tooltip.hidden = true;
    };

    plot.addEventListener("pointermove", (e) => {
        const rect = plot.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        show(Math.round(ratio * (series.length - 1)));
    });
    plot.addEventListener("pointerleave", () => {
        if (document.activeElement !== plot) hide();
    });
    plot.addEventListener("focus", () => show(index));
    plot.addEventListener("blur", hide);
    plot.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft") show(index - 1);
        else if (e.key === "ArrowRight") show(index + 1);
        else return;
        e.preventDefault();
    });
}
