// The backend's upload and forecast limits, read when the site is built, so
// the pages can't drift from what the API enforces. Only for page frontmatter:
// the forecast module would otherwise end up in the browser bundle.
import { LIMITS } from "../../../backend/src/datasets/limits";
import { MIN_DAYS, THRESHOLDS } from "../../../backend/src/forecast/index";

export const limits = {
    datasets: LIMITS.maxDatasets,
    fileSize: `${LIMITS.maxFileBytes / 1024 / 1024} MB`,
    rows: LIMITS.maxRows.toLocaleString("en"),
    invalidShare: `${LIMITS.maxInvalidShare * 100}%`,
    forecastDays: MIN_DAYS,
    // "80, 90 and 100%"
    thresholds: `${THRESHOLDS.slice(0, -1).join(", ")} and ${THRESHOLDS.at(-1)}%`,
};
