// The backend's upload and forecast limits, read when the site is built, so
// the pages can't drift from what the API enforces. Only for page frontmatter:
// the forecast module would otherwise end up in the browser bundle.
import { LIMITS } from "../../../backend/src/datasets/limits";
import { CAPACITY_HORIZON_DAYS } from "../../../backend/src/forecast/capacity";
import { MIN_DAYS, THRESHOLDS } from "../../../backend/src/forecast/index";

// At most one decimal, so 0.07 * 100 shows as 7 rather than 7.000000000000001
const number = (value: number) =>
    value.toLocaleString("en", { maximumFractionDigits: 1 });

export const limits = {
    datasets: LIMITS.maxDatasets,
    fileSize: `${number(LIMITS.maxFileBytes / 1024 / 1024)} MB`,
    rows: number(LIMITS.maxRows),
    invalidShare: `${number(LIMITS.maxInvalidShare * 100)}%`,
    // the backend's rule: rejected when the invalid share is above the limit
    rejects: (invalidRows: number, totalRows: number) =>
        invalidRows / totalRows > LIMITS.maxInvalidShare,
    forecastDays: MIN_DAYS,
    capacityDays: CAPACITY_HORIZON_DAYS,
    thresholdPercents: THRESHOLDS,
    // "80, 90 and 100%"
    thresholds: `${THRESHOLDS.slice(0, -1).join(", ")} and ${THRESHOLDS.at(-1)}%`,
};
