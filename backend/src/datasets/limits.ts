// Upload limits. No imports, so the frontend build can read them too: the
// landing page and the datasets page show these numbers.

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ROWS = 500_000;
export const MAX_DATASETS = 5;
// Above this share of invalid rows the file is rejected as a whole.
export const MAX_INVALID_SHARE = 0.05;

export const LIMITS = {
    maxFileBytes: MAX_FILE_BYTES,
    maxRows: MAX_ROWS,
    maxDatasets: MAX_DATASETS,
    maxInvalidShare: MAX_INVALID_SHARE,
};
