// The /capacity horizon and row order. No imports, so the frontend can use them
// too: /forecast and the landing preview show the same horizon and order.

// How far ahead /capacity forecasts disk and RAM for every host
export const CAPACITY_HORIZON_HOURS = 720;
export const CAPACITY_HORIZON_DAYS = CAPACITY_HORIZON_HOURS / 24;

type CapacityRow = {
    host: string;
    metric: string;
    // absent when the host has too little history to forecast
    thresholds?: { crossesAt: string | null; alreadyAbove: boolean }[];
};

// [100%, 90%, 80%] as ms; already above is 0, never within the horizon is Infinity.
const urgency = (row: CapacityRow) =>
    row.thresholds
        ?.toReversed()
        .map((t) =>
            t.alreadyAbove
                ? 0
                : t.crossesAt === null
                  ? Infinity
                  : Date.parse(t.crossesAt),
        ) ?? null;
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Soonest trouble first: by when each host reaches 100%, then 90%, then 80%. A
// host already above a threshold reaches it now. Hosts that reach none follow,
// then hosts with too little history; ties go by host, then metric.
export function compareCapacity(a: CapacityRow, b: CapacityRow) {
    const ua = urgency(a);
    const ub = urgency(b);
    if (!ua || !ub) {
        if (ua || ub) return ua ? -1 : 1;
    } else {
        const i = ua.findIndex((t, k) => t !== ub[k]);
        if (i >= 0) return ua[i]! < ub[i]! ? -1 : 1;
    }
    return order(a.host, b.host) || order(a.metric, b.metric);
}
