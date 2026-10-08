import { Hono } from "hono";
import { requireAuth, toAuthUser, type AuthEnv } from "../auth/session.js";
import { db } from "../prisma/db.js";

const PLANS = ["subscription", "lifetime"] as const;
type Plan = (typeof PLANS)[number];

function isPlan(value: unknown): value is Plan {
    return PLANS.includes(value as Plan);
}

export const billing = new Hono<AuthEnv>();

// right now this grants the license without taking any payment.
billing.post("/purchase", requireAuth, async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const plan = (body as { plan?: unknown } | null)?.plan;
    if (!isPlan(plan)) return c.json({ error: "Unknown plan" }, 400);

    const current = c.get("user");
    if (current.licensePlan === "lifetime") {
        return c.json({ user: current });
    }

    const user = await db.orm.public.User.where({ id: current.id }).update({
        licensePlan: plan,
        licensedAt: new Date().toISOString(),
    });
    if (!user) return c.json({ error: "User not found" }, 404);
    return c.json({ user: toAuthUser(user) });
});
