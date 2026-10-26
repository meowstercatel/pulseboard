import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "./fixtures";
import type { Contract } from "../../backend/src/prisma/contract.d";
import { testEnvironment } from "../environment.mjs";

const password = "Correct horse battery staple!";
const HOUR = 60 * 60 * 1000;

// A verified, unpaid password account whose trial ends `endsIn` ms from now,
// seeded directly like login-redirect.spec.ts does
async function seedAccount(endsIn: number) {
    Object.assign(process.env, testEnvironment());
    const { default: postgres } =
        await import("../../backend/node_modules/@prisma/orm-postgres/dist/runtime.mjs");
    const { default: contractJson } = await import(
        "../../backend/src/prisma/contract.json",
        { with: { type: "json" } }
    );
    const { hashPassword } = await import("../../backend/src/auth/password.js");
    const db = postgres<Contract>({
        contractJson,
        url: process.env["DATABASE_URL"]!,
    });
    const user = await db.orm.public.User.create({
        email: `e2e-trial-${randomUUID()}@example.com`,
        passwordHash: await hashPassword(password),
        emailVerifiedAt: new Date().toISOString(),
    });
    await db.orm.public.User.where({ id: user.id }).update({
        trialEndsAt: new Date(Date.now() + endsIn).toISOString(),
    });
    return {
        email: user.email,
        cleanup: async () => {
            await db.orm.public.User.where({ id: user.id }).delete();
            await db.close();
        },
    };
}

async function logIn(page: Page, email: string) {
    await page.goto("/login");
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
}

test("a trial user sees the days left in the header and settings", async ({
    page,
}) => {
    const account = await seedAccount(3 * 24 * HOUR - HOUR);
    try {
        await logIn(page, account.email);
        await expect(page).toHaveURL("/overview");
        const badge = page.locator("[data-trial-badge]");
        await expect(badge).toHaveText("Free trial: 3 days left");
        await expect(badge).toHaveAttribute("href", "/buy");

        await page.goto("/datasets");
        await expect(badge).toHaveText("Free trial: 3 days left");

        await page.goto("/settings");
        await expect(page.locator("#plan-status")).toContainText(
            "Free trial, 3 days left (ends ",
        );
        await expect(page.locator("#plan-link")).toHaveText("Choose a plan");
        await expect(page.locator("#back-link")).toHaveAttribute(
            "href",
            "/overview",
        );

        await page.goto("/buy");
        await expect(page.locator("#license-status")).toHaveText(
            "free trial, 3 days left",
        );
        await expect(page.locator("#dashboard-link")).toBeVisible();
        await expect(page.locator("#trial-ended")).toBeHidden();
        // all three plans, none of them blocked
        await expect(page.locator("cds-button[data-plan]")).toHaveCount(3);
        for (const button of await page
            .locator("cds-button[data-plan]")
            .all()) {
            await expect(button).not.toHaveAttribute("disabled");
        }
    } finally {
        await account.cleanup();
    }
});

test("an ended trial sends the user to the plans with a clear notice", async ({
    page,
}) => {
    const account = await seedAccount(-HOUR);
    try {
        await logIn(page, account.email);
        await expect(page).toHaveURL("/buy");
        await expect(page.locator("#license-status")).toHaveText("trial ended");
        const notice = page.locator("#trial-ended");
        await expect(notice).toBeVisible();
        await expect(notice).toHaveAttribute(
            "title",
            "Your free trial has ended",
        );
        await expect(page.locator("#dashboard-link")).toBeHidden();

        // the dashboard and its API are locked again
        await page.goto("/overview");
        await expect(page).toHaveURL("/buy");
        expect((await page.request.get("/api/datasets")).status()).toBe(402);

        await page.goto("/settings");
        await expect(page.locator("#plan-status")).toHaveText(
            "Your free trial has ended.",
        );
        await expect(page.locator("#back-link")).toHaveAttribute(
            "href",
            "/buy",
        );
    } finally {
        await account.cleanup();
    }
});
