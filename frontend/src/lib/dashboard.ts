import {
    dashboardGet,
    initSelection,
    metricFields,
    number,
    timestamp,
} from "./dashboardControls";

export {
    dashboardGet,
    LatestRequest,
    metricFields,
    number,
    timestamp,
} from "./dashboardControls";

export type Reading = {
    timestamp: string;
    cpuPercent: number;
    ramPercent: number;
    diskPercent: number;
    netInMbps: number;
    netOutMbps: number;
};
export type Metrics = {
    datasetId: number;
    host: string;
    range: string;
    total: number;
    points: Reading[];
    latest: Reading | null;
    sampling: "none" | "uniform-rows";
    maxPoints: number;
};

export function chartCoordinates(
    points: Reading[],
    field: keyof Omit<Reading, "timestamp">,
) {
    const times = points.map((p) => Date.parse(p.timestamp));
    const start = times[0] ?? 0;
    const span = (times.at(-1) ?? start) - start;
    const max = field.endsWith("Percent")
        ? 100
        : Math.max(1, ...points.map((p) => p[field]));
    return {
        max,
        coordinates: points.map((p, i) => ({
            x: span ? ((times[i]! - start) / span) * 600 : 300,
            y: 160 - (p[field] / max) * 160,
        })),
    };
}

function renderChart(
    root: HTMLElement,
    points: Reading[],
    field: (typeof metricFields)[number][0],
    label: string,
    unit: string,
) {
    const { max, coordinates } = chartCoordinates(points, field);
    const svg = root.querySelector("svg")!;
    // Only numeric coordinates enter SVG markup. CSV strings use textContent.
    svg.innerHTML =
        [0, 40, 80, 120, 160]
            .map(
                (y) =>
                    `<line x1="0" x2="600" y1="${y}" y2="${y}" class="chart-grid"/>`,
            )
            .join("") +
        `<polyline class="chart-line" points="${coordinates.map((p) => `${p.x},${p.y}`).join(" ")}"/>` +
        (points.length === 1
            ? `<circle cx="300" cy="${coordinates[0]!.y}" r="4" class="chart-point"/>`
            : "");
    root.querySelector(".scale")!.textContent = `0–${number(max)} ${unit}`;
    root.querySelector(".axis-start")!.textContent = timestamp(
        points[0]!.timestamp,
    );
    root.querySelector(".axis-end")!.textContent =
        points.length > 1
            ? timestamp(points.at(-1)!.timestamp)
            : "Single reading";
    const plot = root.querySelector<HTMLElement>(".plot")!;
    const inspect = root.querySelector<HTMLElement>(".inspection")!;
    const dot = root.querySelector<HTMLElement>(".hover-dot")!;
    const crosshair = root.querySelector<HTMLElement>(".hover-line")!;
    const tooltip = root.querySelector<HTMLElement>(".chart-tooltip")!;
    const hide = () => {
        dot.hidden = true;
        crosshair.hidden = true;
        tooltip.hidden = true;
    };
    let index = points.length - 1;
    const show = (cursor?: { x: number; y: number }) => {
        const p = points[index]!;
        inspect.textContent = `${timestamp(p.timestamp)} · ${number(p[field])} ${unit}`;
        plot.setAttribute(
            "aria-label",
            `${label}. ${inspect.textContent}. Use left and right arrows to inspect readings.`,
        );
        const point = coordinates[index]!;
        dot.style.left = crosshair.style.left = `${(point.x / 600) * 100}%`;
        dot.style.top = `${(point.y / 160) * 100}%`;
        dot.hidden = crosshair.hidden = tooltip.hidden = false;
        const rect = plot.getBoundingClientRect();
        const x = cursor?.x ?? (point.x / 600) * rect.width;
        const y = cursor?.y ?? (point.y / 160) * rect.height;
        const width = tooltip.offsetWidth;
        const height = tooltip.offsetHeight;
        const left = x + 12 + width <= rect.width ? x + 12 : x - width - 12;
        tooltip.style.left = `${Math.max(0, Math.min(left, rect.width - width))}px`;
        tooltip.style.top = `${Math.max(0, Math.min(y - height - 12, rect.height - height))}px`;
    };
    show();
    hide();
    plot.onfocus = () => show();
    plot.onblur = hide;
    plot.onpointerleave = hide;
    plot.onkeydown = (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
        event.preventDefault();
        index =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? points.length - 1
                  : Math.max(
                        0,
                        Math.min(
                            points.length - 1,
                            index + (event.key === "ArrowLeft" ? -1 : 1),
                        ),
                    );
        show();
    };
    plot.onpointermove = (event) => {
        const rect = plot.getBoundingClientRect();
        if (!rect.width) return;
        const x = ((event.clientX - rect.left) / rect.width) * 600;
        index = coordinates.reduce(
            (best, p, i) =>
                Math.abs(p.x - x) < Math.abs(coordinates[best]!.x - x)
                    ? i
                    : best,
            0,
        );
        show({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
}

export function initDashboard(doc: Document = document) {
    const byId = <T extends HTMLElement>(id: string) =>
        doc.getElementById(id) as T;
    return initSelection(
        {
            clear() {
                // Remove old values from the DOM as well as hiding them.
                byId("reading-time").textContent = "";
                metricFields.forEach(([field]) => {
                    byId(`value-${field}`).textContent = "";
                });
                doc.querySelectorAll(".chart svg").forEach((svg) =>
                    svg.replaceChildren(),
                );
                byId("reading-rows").replaceChildren();
            },
            async load({ dataset, host, range }, request) {
                const query = new URLSearchParams({ host, range });
                const data = await dashboardGet<Metrics>(
                    `/api/datasets/${dataset.id}/metrics?${query}`,
                    request.signal,
                );
                if (!request.current()) return;
                if (!data.latest)
                    return "No readings for this host and time range.";
                byId("reading-time").textContent =
                    `Latest imported reading: ${timestamp(data.latest.timestamp)}`;
                byId("selection-title").textContent = host;
                metricFields.forEach(([field, label, unit]) => {
                    byId(`value-${field}`).textContent =
                        `${number(data.latest![field])} ${unit}`;
                    renderChart(
                        byId(`chart-${field}`),
                        data.points,
                        field,
                        label,
                        unit,
                    );
                });
                byId("sampling").textContent =
                    data.sampling === "none"
                        ? `All ${number(data.total)} ${data.total === 1 ? "reading" : "readings"} shown. ${data.total === 1 ? "Only one reading is available; no trend can be inferred." : "Points use original CSV timestamps."}`
                        : `Sampled: ${number(data.points.length)} of ${number(data.total)} readings shown, evenly selected by row with first and last retained. Values are not averaged; short peaks may be omitted.`;
                for (const p of data.points) {
                    const tr = doc.createElement("tr");
                    [
                        timestamp(p.timestamp),
                        ...metricFields.map(([field]) => number(p[field])),
                    ].forEach((value) => {
                        const td = doc.createElement("td");
                        td.textContent = value;
                        tr.append(td);
                    });
                    byId("reading-rows").append(tr);
                }
            },
        },
        doc,
    );
}
