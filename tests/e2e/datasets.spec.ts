import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { testEnvironment } from "../environment.mjs";

// Playwright runs from the repository root
const sample = (name: string) => resolve("samples", name);

// The account is seeded straight into the test database: onboarding.spec.ts
// already covers registering, verifying and paying.
async function seedAccount() {
    Object.assign(process.env, testEnvironment());
    const { db } = await import("../../backend/src/prisma/db.js");
    const { sessionIdFor } = await import("../../backend/src/auth/session.js");
    const now = new Date().toISOString();
    const user = await db.orm.public.User.create({
        email: `e2e-datasets-${randomUUID()}@example.com`,
        emailVerifiedAt: now,
        licensePlan: "lifetime",
        licensedAt: now,
    });
    const token = randomBytes(32).toString("base64url");
    await db.orm.public.Session.create({
        id: sessionIdFor(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    return {
        token,
        cleanup: async () => {
            await db.orm.public.User.where({ id: user.id }).delete();
            await db.close();
        },
    };
}

test("import CSV files, see the error report and delete a dataset", async ({
    page,
    context,
}) => {
    const account = await seedAccount();
    try {
        await context.addCookies([
            {
                name: "session",
                value: account.token,
                url: testEnvironment().PUBLIC_URL,
            },
        ]);
        await page.goto("/datasets");
        await expect(page.locator("#empty")).toBeVisible();

        // more than 5% broken: nothing is imported, the problems are listed
        await page
            .locator("#file")
            .setInputFiles(sample("invalid-10-percent.csv"));
        await page.locator("#import-button").click();
        await expect(page.locator("#import-error")).toBeVisible();
        await expect(page.locator("#report-summary")).toContainText(
            "59 of 672 rows have mistakes, so nothing was imported",
        );
        await expect(page.locator("#report-rows tr")).toHaveCount(59);
        await expect(page.locator("#empty")).toBeVisible();

        // under 5% broken: the valid rows are imported, the rest reported
        await page
            .locator("#file")
            .setInputFiles(sample("invalid-3-percent.csv"));
        // the previous file's report goes away as soon as another is chosen
        await expect(page.locator("#report")).toBeHidden();
        await expect(page.locator("#import-error")).toBeHidden();
        await page
            .locator('cds-text-input[name="name"] input')
            .fill("Web server");
        await page.locator("#import-button").click();
        await expect(page.locator("#import-success")).toHaveText(
            'Imported 650 rows into "Web server".',
        );
        await expect(page.locator("#report-summary")).toContainText(
            "22 of 672 rows were skipped",
        );
        const row = page.locator("#list-rows tr");
        await expect(row).toHaveCount(1);
        await expect(row).toContainText("Web server");
        await expect(row).toContainText("invalid-3-percent.csv");
        await expect(row).toContainText("650");
        await expect(row).toContainText("1 Sept 2026 – 7 Sept 2026");
        await expect(page.locator("#dataset-limit")).toHaveText(
            "Up to 5 datasets per account. You have 1.",
        );

        page.once("dialog", (dialog) => dialog.accept());
        await row.getByRole("button", { name: "Delete" }).click();
        await expect(page.locator("#empty")).toBeVisible();
        await expect(page.locator("#list-rows tr")).toHaveCount(0);
    } finally {
        await account.cleanup();
    }
});
