// Dataset, host and time-range selection shared by /overview, /history and
// /forecast.
import { listDatasets, type Dataset } from "./datasets";

export const metricFields = [
    ["cpuPercent", "CPU usage", "%"],
    ["ramPercent", "RAM usage", "%"],
    ["diskPercent", "Disk usage", "%"],
    ["netInMbps", "Incoming network", "Mbps"],
    ["netOutMbps", "Outgoing network", "Mbps"],
] as const;
export type MetricField = (typeof metricFields)[number][0];
export const number = (value: number) =>
    new Intl.NumberFormat("en", { maximumFractionDigits: 3 }).format(value);
export const timestamp = (value: string) =>
    value.replace("T", " ").replace(".000Z", " UTC").replace("Z", " UTC");

// A generation guard is needed even when a transport ignores AbortSignal or
// finishes parsing a response after a newer selection has started.
export class LatestRequest {
    private controller?: AbortController;
    private generation = 0;
    start() {
        this.controller?.abort();
        const controller = (this.controller = new AbortController());
        const generation = ++this.generation;
        return {
            signal: controller.signal,
            current: () => generation === this.generation,
        };
    }
}
export type Request = ReturnType<LatestRequest["start"]>;

// A failed dashboard request, with its HTTP status.
export class DashboardError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export async function dashboardGet<T>(
    url: string,
    signal: AbortSignal,
): Promise<T> {
    const res = await fetch(url, { signal, cache: "no-store" });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
        if (res.status === 401) location.replace("/login");
        if (res.status === 402) location.replace("/buy");
        if (res.status === 403) location.replace("/verify-email");
        throw new DashboardError(
            body?.error ?? `Couldn't load dashboard (${res.status})`,
            res.status,
        );
    }
    return body;
}

export function fillOptions(
    doc: Document,
    select: HTMLSelectElement,
    values: { value: string; label: string }[],
) {
    select.replaceChildren(
        ...values.map((v) => {
            const option = doc.createElement("option");
            option.value = v.value;
            option.textContent = v.label;
            return option;
        }),
    );
}

export type Selection = { dataset: Dataset; host: string; range: string };
export type SelectionHooks = {
    // Remove the previous selection's values from the DOM.
    clear(): void;
    // Render a selection. Return a message to show instead of the results.
    load(selection: Selection, request: Request): Promise<string | void>;
};

// Header links marked data-dataset-link keep the selected ?dataset= across pages.
function updateDatasetLinks(doc: Document, id: string) {
    doc.querySelectorAll("[data-dataset-link]").forEach((link) => {
        const url = new URL(link.getAttribute("href")!, location.href);
        if (id) url.searchParams.set("dataset", id);
        else url.searchParams.delete("dataset");
        link.setAttribute("href", url.pathname + url.search);
    });
}

export function initSelection(hooks: SelectionHooks, doc: Document = document) {
    const byId = <T extends HTMLElement>(id: string) =>
        doc.getElementById(id) as T;
    const dataset = byId<HTMLSelectElement>("dataset");
    const host = byId<HTMLSelectElement>("host");
    const search = byId<HTMLInputElement>("host-search");
    let selectedHost = "";
    let datasets: Dataset[] = [];
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    // A page without a time range always asks for all readings.
    const range = doc.getElementById("range") as HTMLSelectElement | null;
    const results = byId("results");
    const status = byId("status");
    const error = byId("dashboard-error");
    const retry = byId("retry");
    const requests = new LatestRequest();
    let retryAction: () => unknown;
    const options = (
        select: HTMLSelectElement,
        values: { value: string; label: string }[],
    ) => fillOptions(doc, select, values);
    function clear(message: string) {
        results.hidden = true;
        hooks.clear();
        status.textContent = message;
        error.hidden = true;
        retry.hidden = true;
    }
    function fail(reason: unknown) {
        status.textContent = "";
        error.textContent =
            reason instanceof Error ? reason.message : "Can't reach the server";
        error.hidden = false;
        retry.hidden = false;
    }
    async function loadSelection() {
        const request = requests.start();
        retryAction = loadSelection;
        clear("Loading imported readings…");
        if (!selectedHost) {
            status.textContent =
                "No hosts match this search, or this dataset has no readings.";
            return;
        }
        try {
            const message = await hooks.load(
                {
                    dataset: datasets.find(
                        (d) => String(d.id) === dataset.value,
                    )!,
                    host: selectedHost,
                    range: range?.value ?? "all",
                },
                request,
            );
            if (!request.current()) return;
            if (message) {
                status.textContent = message;
                return;
            }
            status.textContent = "";
            results.hidden = false;
        } catch (reason) {
            if (request.current()) fail(reason);
        }
    }
    async function loadHosts(autoSelect = true) {
        clearTimeout(searchTimer);
        const request = requests.start();
        retryAction = () => loadHosts(autoSelect);
        clear("Loading hosts…");
        selectedHost = "";
        host.disabled = true;
        if (range) range.disabled = true;
        options(host, []);
        byId("host-hint").textContent = "";
        try {
            const data = await dashboardGet<{
                hosts: string[];
                hasMore: boolean;
            }>(
                `/api/datasets/${dataset.value}/hosts?${new URLSearchParams({ q: search.value })}`,
                request.signal,
            );
            if (!request.current()) return;
            options(host, [
                ...(!autoSelect && data.hosts.length
                    ? [{ value: "", label: "Select a host" }]
                    : []),
                ...data.hosts.map((value) => ({ value, label: value })),
            ]);
            byId("host-filter").hidden = !data.hasMore && !search.value;
            byId("host-hint").textContent = data.hasMore
                ? "First 100 matches. Filter by hostname to find others."
                : data.hosts.length
                  ? ""
                  : "No matching hosts.";
            host.disabled = !data.hosts.length;
            if (autoSelect && data.hosts[0]) {
                selectedHost = data.hosts[0];
                if (range) range.disabled = false;
                await loadSelection();
            } else {
                status.textContent = data.hosts.length
                    ? "Select a host to view its readings."
                    : "No hosts match this search, or this dataset has no readings.";
            }
        } catch (reason) {
            if (request.current()) fail(reason);
        }
    }
    async function loadDatasets() {
        const request = requests.start();
        retryAction = loadDatasets;
        clear("Loading datasets…");
        const data = await listDatasets();
        if (!request.current()) return;
        if ("error" in data) {
            fail(new Error(data.error));
            return;
        }
        datasets = data.datasets;
        options(
            dataset,
            data.datasets.map((d) => ({ value: String(d.id), label: d.name })),
        );
        dataset.disabled = !data.datasets.length;
        if (!data.datasets.length) {
            status.textContent =
                "No datasets yet. Import a CSV file to see your metrics.";
            return;
        }
        const requested = new URLSearchParams(location.search).get("dataset");
        if (requested) {
            if (!data.datasets.some((d) => String(d.id) === requested)) {
                dataset.value = "";
                status.textContent =
                    "This dataset is unavailable. Choose a dataset or import a CSV file.";
                return;
            }
            dataset.value = requested;
        }
        updateDatasetLinks(doc, dataset.value);
        await loadHosts();
    }
    dataset.addEventListener("change", () => {
        clearTimeout(searchTimer);
        search.value = "";
        byId("host-filter").hidden = true;
        host.value = "";
        host.disabled = true;
        const url = new URL(location.href);
        url.searchParams.set("dataset", dataset.value);
        history.replaceState(null, "", url);
        updateDatasetLinks(doc, dataset.value);
        void loadHosts();
    });
    search.addEventListener("input", () => {
        clearTimeout(searchTimer);
        requests.start();
        selectedHost = "";
        host.disabled = true;
        if (range) range.disabled = true;
        options(host, []);
        clear("Searching hosts…");
        searchTimer = setTimeout(() => void loadHosts(false), 200);
    });
    host.addEventListener("change", () => {
        selectedHost = host.value;
        if (range) range.disabled = !selectedHost;
        void loadSelection();
    });
    range?.addEventListener("change", () => void loadSelection());
    // A page's own options, marked data-reloads-selection, reload it too.
    doc.querySelectorAll("[data-reloads-selection]").forEach((select) =>
        select.addEventListener("change", () => void loadSelection()),
    );
    retry.addEventListener("click", () => retryAction?.());
    return loadDatasets();
}
