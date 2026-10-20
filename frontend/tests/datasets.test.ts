import { expect, it, vi } from "vitest";
import {
    deleteDataset,
    importDataset,
    listDatasets,
} from "../src/lib/datasets";

const report = {
    totalRows: 672,
    importedRows: 0,
    invalidRows: 59,
    errors: [{ line: 4, message: "cpu_percent 140 is over 100" }],
};

it("sends the file and the trimmed name as a form", async () => {
    const fetch = vi
        .fn()
        .mockResolvedValue(
            Response.json({ dataset: { id: 1 }, report }, { status: 201 }),
        );
    vi.stubGlobal("fetch", fetch);
    const file = new File(["a,b"], "metrics.csv");

    expect(await importDataset(file, "  Office  ")).toEqual({
        dataset: { id: 1 },
        report,
    });
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/datasets");
    expect(init.method).toBe("POST");
    expect(init.body.get("file").name).toBe("metrics.csv");
    expect(init.body.get("name")).toBe("Office");
});

it("leaves the name out when it is blank", async () => {
    const fetch = vi
        .fn()
        .mockResolvedValue(Response.json({ dataset: {} }, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await importDataset(new File(["a"], "a.csv"), "   ");
    expect(fetch.mock.calls[0]![1].body.has("name")).toBe(false);
});

it("keeps the error report of a rejected file", async () => {
    vi.stubGlobal(
        "fetch",
        vi
            .fn()
            .mockResolvedValue(
                Response.json(
                    { error: "Too many invalid rows", report },
                    { status: 422 },
                ),
            ),
    );
    expect(await importDataset(new File(["a"], "a.csv"), "")).toEqual({
        error: "Too many invalid rows",
        report,
    });
});

it("handles network failures and non-JSON errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect(await listDatasets()).toEqual({ error: "Can't reach the server" });
    expect(await deleteDataset(1)).toBe("Can't reach the server");

    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("Bad gateway", { status: 502 })),
    );
    expect(await importDataset(new File(["a"], "a.csv"), "")).toEqual({
        error: "Couldn't import the file (502)",
    });
});

it.each([
    [401, "/login"],
    [402, "/buy"],
    [403, "/verify-email"],
])("sends a %i response to %s", async (status, path) => {
    const replace = vi.fn();
    vi.stubGlobal("location", { replace });
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(Response.json({ error: "No" }, { status })),
    );
    await listDatasets();
    expect(replace).toHaveBeenCalledWith(path);
});

it("treats 204 as a successful delete", async () => {
    const fetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    expect(await deleteDataset(7)).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/datasets/7", { method: "DELETE" });
});
