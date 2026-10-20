export type Dataset = {
    id: number;
    name: string;
    fileName: string | null;
    rowCount: number;
    startsAt: string | null;
    endsAt: string | null;
    createdAt: string;
};

export type ImportReport = {
    totalRows: number;
    importedRows: number;
    invalidRows: number;
    errors: { line: number; message: string }[];
};

export type Limits = {
    maxFileBytes: number;
    maxRows: number;
    maxDatasets: number;
    maxInvalidShare: number;
};

export type ImportResult =
    | { dataset: Dataset; report: ImportReport }
    | { error: string; report?: ImportReport };

// Access problems send the user to the page that fixes them, like the page guards do
function redirectFor(status: number) {
    if (status === 401) location.replace("/login");
    if (status === 403) location.replace("/verify-email");
    if (status === 402) location.replace("/buy");
}

export async function listDatasets(): Promise<
    { datasets: Dataset[]; limits: Limits } | { error: string }
> {
    try {
        const res = await fetch("/api/datasets");
        const data = await res.json().catch(() => null);
        if (res.ok && data?.datasets) return data;
        redirectFor(res.status);
        return {
            error: data?.error ?? `Couldn't load datasets (${res.status})`,
        };
    } catch {
        return { error: "Can't reach the server" };
    }
}

export async function importDataset(
    file: File,
    name: string,
): Promise<ImportResult> {
    const form = new FormData();
    form.set("file", file);
    if (name.trim()) form.set("name", name.trim());
    try {
        const res = await fetch("/api/datasets", {
            method: "POST",
            body: form,
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.dataset) return data;
        redirectFor(res.status);
        return {
            error: data?.error ?? `Couldn't import the file (${res.status})`,
            ...(data?.report ? { report: data.report } : {}),
        };
    } catch {
        return { error: "Can't reach the server" };
    }
}

export async function deleteDataset(id: number): Promise<string | null> {
    try {
        const res = await fetch(`/api/datasets/${id}`, { method: "DELETE" });
        if (res.status === 204) return null;
        redirectFor(res.status);
        const data = await res.json().catch(() => null);
        return data?.error ?? `Couldn't delete the dataset (${res.status})`;
    } catch {
        return "Can't reach the server";
    }
}
