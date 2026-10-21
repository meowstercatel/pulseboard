import { Window } from "happy-dom";
import { beforeEach, expect, it, vi } from "vitest";
import {
    chartCoordinates,
    dashboardGet,
    initDashboard,
    metricFields,
    type Metrics,
    type Reading,
} from "../src/lib/dashboard";

let window: Window;
let doc: Document;
const reading = (timestamp: string, cpuPercent = 42): Reading => ({
    timestamp,
    cpuPercent,
    ramPercent: 61.5,
    diskPercent: 88,
    netInMbps: 12.25,
    netOutMbps: 3.75,
});
const points = [
    reading("2026-09-01T00:00:00.000Z", 10),
    reading("2026-09-01T00:10:00.000Z", 20),
    reading("2026-09-01T01:00:00.000Z", 30),
];
const metrics = (host = "web", values = points): Metrics => ({
    datasetId: 1,
    host,
    range: "all",
    points: values,
    latest: values.at(-1) ?? null,
    total: values.length,
    sampling: "none",
    maxPoints: 600,
});
const datasetList = {
    datasets: [
        { id: 1, name: "First" },
        { id: 2, name: "Second" },
    ],
    limits: {},
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const el = (id: string) => doc.getElementById(id)!;
function select(id: string, value: string) {
    (el(id) as HTMLSelectElement).value = value;
    el(id).dispatchEvent(new window.Event("change") as unknown as Event);
}
beforeEach(() => {
    window = new Window({ url: "http://localhost/overview?dataset=1" });
    doc = window.document as unknown as Document;
    vi.stubGlobal("document", doc);
    vi.stubGlobal("location", window.location);
    vi.stubGlobal("history", window.history);
    doc.body.innerHTML = `
        <select id="dataset" disabled></select><select id="host" disabled></select><div id="host-filter" hidden><input id="host-search"/></div>
        <select id="range"><option value="all">All</option><option value="1h">Hour</option><option value="7d">Week</option></select>
        <p id="host-hint"></p>
        <p id="status"></p><p id="dashboard-error" hidden></p><button id="retry" hidden>Retry</button>
        <div id="results" hidden><h2 id="selection-title"></h2><p id="reading-time"></p><p id="sampling"></p>
        ${metricFields.map(([field]) => `<p id="value-${field}"></p><div class="chart" id="chart-${field}"><span class="scale"></span><div class="plot"><svg></svg><span class="hover-line" hidden></span><span class="hover-dot" hidden></span><div class="chart-tooltip" hidden><p class="inspection"></p></div></div><span class="axis-start"></span><span class="axis-end"></span></div>`).join("")}
        <table><tbody id="reading-rows"></tbody></table></div>`;
});
it("positions irregular readings by timestamp and handles a single reading", () => {
    const chart = chartCoordinates(points, "cpuPercent");
    expect(chart.coordinates.map((p) => p.x)).toEqual([0, 100, 600]);
    expect(chart.max).toBe(100);
    expect(chartCoordinates([points[0]!], "netInMbps").coordinates).toEqual([
        { x: 300, y: 0 },
    ]);
    expect(chartCoordinates([], "netInMbps").coordinates).toEqual([]);
});
it("renders imported values, original timestamps and keyboard inspection", async () => {
    vi.stubGlobal(
        "fetch",
        vi
            .fn()
            .mockResolvedValueOnce(Response.json(datasetList))
            .mockResolvedValueOnce(
                Response.json({ hosts: ["web"], hasMore: false }),
            )
            .mockResolvedValueOnce(Response.json(metrics())),
    );
    await initDashboard(doc);
    expect(el("results").hidden).toBe(false);
    expect(el("value-cpuPercent").textContent).toBe("30 %");
    expect(el("value-netInMbps").textContent).toBe("12.25 Mbps");
    expect(el("reading-time").textContent).toContain("2026-09-01 01:00:00 UTC");
    expect(el("sampling").textContent).toContain("All 3 readings");
    expect(el("reading-rows").children).toHaveLength(3);
    const plot = el("chart-cpuPercent").querySelector(".plot")!;
    plot.dispatchEvent(
        new window.KeyboardEvent("keydown", {
            key: "Home",
        }) as unknown as Event,
    );
    expect(
        el("chart-cpuPercent").querySelector(".inspection")!.textContent,
    ).toBe("2026-09-01 00:00:00 UTC · 10 %");
    expect(doc.body.textContent).not.toMatch(
        /just now|Online|Top processes|Ubuntu|Services/,
    );
});
it("clears values immediately and ignores late host and time-range responses", async () => {
    let resolveOld!: (response: Response) => void;
    const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json(datasetList))
        .mockResolvedValueOnce(Response.json({ hosts: ["web", "db"] }))
        .mockResolvedValueOnce(Response.json(metrics()))
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveOld = resolve;
                }),
        )
        .mockResolvedValueOnce(
            Response.json(metrics("db", [reading("2026-09-02T00:00:00Z", 77)])),
        );
    vi.stubGlobal("fetch", fetch);
    await initDashboard(doc);
    select("host", "db");
    expect(el("results").hidden).toBe(true);
    expect(el("value-cpuPercent").textContent).toBe("");
    select("range", "1h");
    await flush();
    expect(el("value-cpuPercent").textContent).toBe("77 %");
    resolveOld(
        Response.json(metrics("db", [reading("2026-09-01T00:00:00Z", 99)])),
    );
    await flush();
    expect(el("value-cpuPercent").textContent).toBe("77 %");
    expect(fetch.mock.calls[3]![1].signal.aborted).toBe(true);
    expect(fetch.mock.calls[4]![0]).toContain("host=db&range=1h");
});
it("ignores stale host lists when switching datasets", async () => {
    let resolveOld!: (response: Response) => void;
    const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json(datasetList))
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveOld = resolve;
                }),
        )
        .mockResolvedValueOnce(Response.json({ hosts: ["new-host"] }))
        .mockResolvedValueOnce(Response.json(metrics("new-host")));
    vi.stubGlobal("fetch", fetch);
    const initial = initDashboard(doc);
    await flush();
    select("dataset", "2");
    await flush();
    resolveOld(Response.json({ hosts: ["stale-host"] }));
    await initial;
    expect((el("host") as HTMLSelectElement).value).toBe("new-host");
    expect(el("selection-title").textContent).toBe("new-host");
    expect(window.location.search).toBe("?dataset=2");
    expect(fetch.mock.calls[3]![0]).toContain("/api/datasets/2/metrics");
});
it.each(["no datasets", "no hosts", "no readings"])(
    "handles %s",
    async (state) => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce(
                    Response.json(
                        state === "no datasets"
                            ? { datasets: [], limits: {} }
                            : datasetList,
                    ),
                )
                .mockResolvedValueOnce(
                    Response.json({
                        hosts: state === "no hosts" ? [] : ["web"],
                    }),
                )
                .mockResolvedValueOnce(Response.json(metrics("web", []))),
        );
        await initDashboard(doc);
        expect(el("results").hidden).toBe(true);
        expect(el("status").textContent).toMatch(
            /No datasets|no readings|No readings/,
        );
    },
);
it("renders a single point without invalid SVG and labels sampling", async () => {
    const data = metrics("web", [points[0]!]);
    vi.stubGlobal(
        "fetch",
        vi
            .fn()
            .mockResolvedValueOnce(Response.json(datasetList))
            .mockResolvedValueOnce(Response.json({ hosts: ["web"] }))
            .mockResolvedValueOnce(Response.json(data))
            .mockResolvedValueOnce(
                Response.json({
                    ...metrics(),
                    total: 500000,
                    sampling: "uniform-rows",
                }),
            ),
    );
    await initDashboard(doc);
    expect(el("sampling").textContent).toContain("Only one reading");
    for (const [field] of metricFields) {
        expect(el(`chart-${field}`).innerHTML).not.toMatch(/NaN|Infinity/);
        expect(el(`chart-${field}`).querySelector("circle")).not.toBeNull();
    }
    select("range", "7d");
    await flush();
    expect(el("sampling").textContent).toContain("Sampled: 3 of 500,000");
    expect(el("sampling").textContent).toContain("short peaks may be omitted");
});
it("shows errors, supports retry, and does not substitute an unavailable dataset", async () => {
    vi.stubGlobal(
        "fetch",
        vi
            .fn()
            .mockResolvedValueOnce(Response.json(datasetList))
            .mockResolvedValueOnce(new Response("Bad gateway", { status: 502 }))
            .mockResolvedValueOnce(Response.json({ hosts: ["web"] }))
            .mockResolvedValueOnce(Response.json(metrics())),
    );
    await initDashboard(doc);
    expect(el("dashboard-error").textContent).toContain("502");
    expect(el("retry").hidden).toBe(false);
    el("retry").click();
    await flush();
    expect(el("results").hidden).toBe(false);
    window.location.href = "http://localhost/overview?dataset=999";
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(datasetList));
    vi.stubGlobal("fetch", fetch);
    await initDashboard(doc);
    expect(el("status").textContent).toContain("unavailable");
    expect(el("results").hidden).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([
    [401, "/login"],
    [402, "/buy"],
    [403, "/verify-email"],
])("redirects access failure %s", async (status, path) => {
    const replace = vi.fn();
    vi.stubGlobal("location", { replace });
    vi.stubGlobal(
        "fetch",
        vi
            .fn()
            .mockResolvedValue(
                Response.json(
                    { error: "Access denied" },
                    { status: Number(status) },
                ),
            ),
    );
    await expect(
        dashboardGet("/api/datasets/1/hosts", new AbortController().signal),
    ).rejects.toThrow("Access denied");
    expect(replace).toHaveBeenCalledWith(path);
});

it("uses a native select and exposes filtering only for large host lists", async () => {
    const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json(datasetList))
        .mockResolvedValueOnce(
            Response.json({ hosts: ["web", "db"], hasMore: true }),
        )
        .mockResolvedValueOnce(Response.json(metrics()))
        .mockResolvedValueOnce(
            Response.json({ hosts: ["remote-01"], hasMore: false }),
        )
        .mockResolvedValueOnce(Response.json(metrics("remote-01")));
    vi.stubGlobal("fetch", fetch);
    await initDashboard(doc);
    expect(el("host").tagName).toBe("SELECT");
    expect(el("host-filter").hidden).toBe(false);
    const input = el("host-search") as HTMLInputElement;
    input.value = "remote";
    input.dispatchEvent(new window.Event("input") as unknown as Event);
    expect(el("results").hidden).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fetch.mock.calls[3]![0]).toContain("hosts?q=remote");
    expect(el("host-filter").hidden).toBe(false);
    expect(el("results").hidden).toBe(true);
    select("host", "remote-01");
    await flush();
    expect(el("selection-title").textContent).toBe("remote-01");
    expect(el("results").hidden).toBe(false);
});

it("keeps the standard host selector free of extra search controls", async () => {
    vi.stubGlobal(
        "fetch",
        vi
            .fn()
            .mockResolvedValueOnce(Response.json(datasetList))
            .mockResolvedValueOnce(
                Response.json({ hosts: ["web", "db"], hasMore: false }),
            )
            .mockResolvedValueOnce(Response.json(metrics())),
    );
    await initDashboard(doc);
    expect(el("host-filter").hidden).toBe(true);
    expect((el("host") as HTMLSelectElement).options.length).toBe(2);
});

it("tracks the nearest timestamp with a dot and cursor tooltip, then hides on leave", async () => {
    vi.stubGlobal(
        "fetch",
        vi
            .fn()
            .mockResolvedValueOnce(Response.json(datasetList))
            .mockResolvedValueOnce(Response.json({ hosts: ["web"] }))
            .mockResolvedValueOnce(Response.json(metrics())),
    );
    await initDashboard(doc);
    const chart = el("chart-cpuPercent");
    const plot = chart.querySelector<HTMLElement>(".plot")!;
    const dot = chart.querySelector<HTMLElement>(".hover-dot")!;
    const tooltip = chart.querySelector<HTMLElement>(".chart-tooltip")!;
    vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
        left: 10,
        top: 20,
        width: 600,
        height: 160,
    } as DOMRect);
    Object.defineProperty(tooltip, "offsetWidth", { value: 200 });
    Object.defineProperty(tooltip, "offsetHeight", { value: 40 });
    expect(tooltip.hidden).toBe(true);
    plot.dispatchEvent(
        new window.PointerEvent("pointermove", {
            clientX: 115,
            clientY: 100,
        }) as unknown as Event,
    );
    expect(dot.hidden).toBe(false);
    expect(parseFloat(dot.style.left)).toBeCloseTo(100 / 6);
    expect(dot.style.top).toBe("80%");
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.style.left).toBe("117px");
    expect(tooltip.textContent).toContain("2026-09-01 00:10:00 UTC · 20 %");
    plot.dispatchEvent(
        new window.PointerEvent("pointermove", {
            clientX: 610,
            clientY: 100,
        }) as unknown as Event,
    );
    expect(tooltip.style.left).toBe("388px");
    expect(dot.style.left).toBe("100%");
    plot.dispatchEvent(
        new window.PointerEvent("pointerleave") as unknown as Event,
    );
    expect(tooltip.hidden).toBe(true);
    expect(dot.hidden).toBe(true);
});
