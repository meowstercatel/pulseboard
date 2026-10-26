import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { Contract } from "../../backend/src/prisma/contract.d";
import { LIMITS } from "../../backend/src/datasets/limits";
import {
    CAPACITY_HORIZON_HOURS,
    THRESHOLDS,
} from "../../backend/src/forecast/index";
import { contactEmail } from "../../frontend/src/lib/legal";
import { plans, price } from "../../frontend/src/lib/pricing";
import { testEnvironment } from "../environment.mjs";

const password = "Correct horse battery staple!";

// A verified, licensed password account, seeded directly like
// login-redirect.spec.ts does
async function seedAccount() {
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
    const now = new Date().toISOString();
    const user = await db.orm.public.User.create({
        email: `e2e-landing-${randomUUID()}@example.com`,
        passwordHash: await hashPassword(password),
        emailVerifiedAt: now,
        licensePlan: "lifetime",
        licensedAt: now,
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
    await page.locator('cds-text-input[name="email"] input').fill(email);
    await page.locator('cds-text-input[name="password"] input').fill(password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await expect(page).toHaveURL("/overview");
}

const hero = (page: Page) => page.locator(".hero");
const getStarted = (page: Page) => page.locator("[data-get-started]");

test("a visitor can start, see prices, limits and the FAQ", async ({
    page,
}) => {
    await page.goto("/");
    // the guest buttons appear once the session check has answered
    await expect(page.locator(".nav-account")).toHaveAttribute(
        "data-auth",
        "guest",
    );
    await expect(getStarted(page)).toHaveCount(2);
    for (const link of await getStarted(page).all()) {
        await expect(link).toHaveAttribute("href", "/register");
    }
    // /buy needs an account, so guests get the pricing section instead
    await expect(
        hero(page).getByRole("link", { name: "See pricing" }),
    ).toHaveAttribute("href", "/#pricing");
    // the demo invitation is still there, further down
    await expect(page.locator(".closing cds-button")).toHaveAttribute(
        "href",
        "#demo",
    );

    const pricing = page.locator("#pricing");
    const cards = pricing.locator("article");
    await expect(cards).toHaveCount(plans.length);
    for (const [i, plan] of plans.entries()) {
        await expect(
            cards.nth(i).getByRole("heading", { name: plan.name }),
        ).toBeVisible();
        await expect(cards.nth(i).locator(".price")).toContainText(
            `${price(plan)} ${plan.period}`,
        );
    }

    const data = page.locator("#data");
    await expect(data).toContainText(
        `${LIMITS.maxDatasets} datasets per account`,
    );
    await expect(data).toContainText(
        `${LIMITS.maxFileBytes / 1024 / 1024} MB per file`,
    );
    await expect(data).toContainText(
        `${LIMITS.maxRows.toLocaleString("en")} rows per file`,
    );
    await expect(
        data.getByRole("link", { name: "Download sample files" }),
    ).toHaveAttribute("href", "/samples");

    for (const tool of ["Netdata", "Beszel", "Grafana", "Uptime Kuma"]) {
        await expect(
            page.locator("#why").getByRole("heading", { name: tool }),
        ).toBeVisible();
    }

    const question = page.getByText("Do I need to install anything");
    const answer = page.getByText("PulseBoard doesn’t connect to");
    await expect(answer).toBeHidden();
    await question.click();
    await expect(answer).toBeVisible();
});

test("the plans on /buy match the landing page", async ({ page }) => {
    const account = await seedAccount();
    try {
        await logIn(page, account.email);

        await page.goto("/");
        await expect(page.locator(".nav-account")).toHaveAttribute(
            "data-auth",
            "user",
        );
        for (const link of await getStarted(page).all()) {
            await expect(link).toHaveAttribute("href", "/overview");
        }
        // signed in, the pricing links go straight to the plans
        await expect(
            hero(page).getByRole("link", { name: "See pricing" }),
        ).toHaveAttribute("href", "/buy");
        await expect(
            page
                .locator("footer.site-footer")
                .getByRole("link", { name: "Pricing", exact: true }),
        ).toHaveAttribute("href", "/buy");

        await page.goto("/buy");
        const prices = page.locator(".license .price");
        await expect(prices).toHaveCount(plans.length);
        for (const [i, plan] of plans.entries()) {
            await expect(prices.nth(i)).toContainText(price(plan));
            await expect(page.locator(".license h4").nth(i)).toHaveText(
                plan.name,
            );
        }
    } finally {
        await account.cleanup();
    }
});

test("the footer is shared by the landing and legal pages", async ({
    page,
}) => {
    for (const path of ["/", "/privacy", "/terms", "/pl/privacy", "/samples"]) {
        await page.goto(path);
        const footer = page.locator("footer.site-footer");
        const links = {
            Register: "/register",
            "Log in": "/login",
            Pricing: "/#pricing",
            Privacy: "/privacy",
            Terms: "/terms",
            "Polityka prywatności": "/pl/privacy",
            Regulamin: "/pl/terms",
            [contactEmail]: `mailto:${contactEmail}`,
        };
        for (const [name, href] of Object.entries(links)) {
            await expect(
                footer.getByRole("link", { name, exact: true }),
                `${name} on ${path}`,
            ).toHaveAttribute("href", href);
        }
        // a proof of concept: no seller details
        await expect(footer).not.toContainText(/NIP|REGON|KRS|sp\. z o\.o\./i);
    }
});

test("guests following a pricing link see prices, not the login page", async ({
    page,
}) => {
    await page.goto("/");
    await hero(page).getByRole("link", { name: "See pricing" }).click();
    await expect(page).toHaveURL("/#pricing");
    await expect(page.locator("#pricing")).toBeInViewport();

    for (const path of ["/terms", "/samples"]) {
        await page.goto(path);
        await page
            .locator("footer.site-footer")
            .getByRole("link", { name: "Pricing", exact: true })
            .click();
        await expect(page).toHaveURL("/#pricing");
        await expect(page.locator("#pricing")).toBeInViewport();
    }
});

test("the landing page checks the session once", async ({ page }) => {
    let checks = 0;
    page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/auth/me") checks++;
    });
    await page.goto("/");
    await expect(page.locator(".nav-account")).toHaveAttribute(
        "data-auth",
        "guest",
    );
    await page.waitForLoadState("networkidle");
    // the header and the footer's pricing links share one request
    expect(checks).toBe(1);
});

test("the terms state the same prices in both languages", async ({ page }) => {
    await page.goto("/terms");
    const terms = page.locator("article");
    for (const plan of plans) await expect(terms).toContainText(price(plan));
    await expect(terms).toContainText(
        "US dollars (USD), including any taxes due",
    );
    await expect(terms).toContainText("14-day free trial");
    await expect(terms).not.toContainText("PLN");

    await page.goto("/pl/terms");
    const pl = page.locator("article");
    for (const plan of plans) {
        await expect(pl).toContainText(`${plan.amount} USD`);
    }
    await expect(pl).toContainText("14-dniowy bezpłatny okres próbny");
    await expect(pl).not.toContainText("PLN");
});

test("/samples offers the repository's sample files", async ({ page }) => {
    await page.goto("/samples");
    const links = page.locator("a[download]");
    await expect(links).toHaveCount(5);
    for (const link of await links.all()) {
        const file = (await link.getAttribute("download"))!;
        const res = await page.request.get((await link.getAttribute("href"))!);
        expect(res.ok()).toBe(true);
        expect(res.headers()["content-type"]).toMatch(/^text\/csv/);
        // Playwright runs from the repository root
        const expected = await readFile(join("samples", file));
        expect(Buffer.compare(await res.body(), expected), file).toBe(0);
    }
});

test("the demo shows only what PulseBoard shows for a CSV", async ({
    page,
}) => {
    await page.goto("/");
    const demo = page.locator(".dashboard");
    // nothing a CSV import can't know
    for (const text of ["Online", "Uptime", "Ubuntu", "Services", "/var"]) {
        await expect(demo).not.toContainText(text);
    }
    // the readings /overview shows
    for (const label of [
        "CPU usage",
        "RAM usage",
        "Disk usage",
        "Incoming network",
        "Outgoing network",
    ]) {
        await expect(demo.locator(".kpis")).toContainText(label);
    }
    await expect(demo).toContainText("Latest imported reading:");
    // history with a gap and a spike, as /history lists them
    await expect(demo.locator(".usage-chart")).toHaveCount(2);
    await expect(demo.locator(".usage-chart .band")).toHaveCount(2);
    await expect(demo.locator(".usage-chart .marker")).toHaveCount(1);
    await expect(
        demo.getByRole("columnheader", { name: "Duration" }),
    ).toBeVisible();
    await expect(
        demo.getByRole("columnheader", { name: "Typical" }),
    ).toBeVisible();
    // capacity dates for every host at the backend's thresholds and horizon
    const capacity = demo.locator(".tile").filter({
        hasText: "Disk and RAM capacity",
    });
    await expect(capacity).toContainText(
        `${CAPACITY_HORIZON_HOURS / 24} days past its latest reading`,
    );
    for (const percent of THRESHOLDS) {
        await expect(
            capacity.getByRole("columnheader", { name: `Reaches ${percent}%` }),
        ).toBeVisible();
    }
    for (const host of ["web-01", "web-02", "db-01"]) {
        await expect(
            capacity.getByRole("cell", { name: host, exact: true }),
        ).toHaveCount(2);
    }
    await expect(capacity).toContainText("Already above");
    // the preview needs no Carbon components of its own
    expect(
        await demo
            .locator("*")
            .evaluateAll(
                (els) =>
                    els.filter((el) => el.localName.startsWith("cds-")).length,
            ),
    ).toBe(0);
});

test("the demo chart can be inspected by keyboard", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const chart = page.locator(".usage-chart").first();
    await chart.scrollIntoViewIfNeeded();
    await chart.locator(".plot").focus();
    const tooltip = chart.locator(".tooltip");
    await expect(tooltip).toContainText("33 %");
    await expect(tooltip).toContainText("2026-09-30 23:00 UTC");
    // back across the gap: 12:00 is followed by 08:00
    for (let i = 0; i < 11; i++) await page.keyboard.press("ArrowLeft");
    await expect(tooltip).toContainText("2026-09-30 12:00 UTC");
    await page.keyboard.press("ArrowLeft");
    await expect(tooltip).toContainText("2026-09-30 08:00 UTC");
    await page.keyboard.press("End");
    for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
    await expect(tooltip).toContainText("91 %");
    await expect(tooltip).toContainText("15:00 UTC · spike");
});

test("the demo moves on its own until the visitor reaches for it", async ({
    page,
}) => {
    await page.goto("/");
    const chart = page.locator(".usage-chart").first();
    await chart.scrollIntoViewIfNeeded();
    const crosshair = chart.locator(".crosshair");
    await expect(crosshair).toBeVisible();
    // the walk isn't announced to screen readers
    await expect(chart.locator(".tooltip")).not.toHaveAttribute("role");

    await page.locator(".preview-header").hover();
    await expect(crosshair).toBeHidden();
    await expect(chart.locator(".tooltip")).toHaveAttribute("role", "status");
    await page.waitForTimeout(1000);
    await expect(crosshair).toBeHidden();
});

test("the demo stays still with reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const chart = page.locator(".usage-chart").first();
    await chart.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    await expect(chart.locator(".crosshair")).toBeHidden();
});

test("public pages fit a phone screen", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    for (const path of ["/", "/samples", "/privacy", "/terms"]) {
        await page.goto(path);
        const overflow = await page.evaluate(
            () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth,
        );
        expect(overflow, path).toBe(0);
    }
});
