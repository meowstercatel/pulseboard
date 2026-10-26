import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "./fixtures";
import type { Contract } from "../../backend/src/prisma/contract.d";
import { testEnvironment } from "../environment.mjs";

const password = "Correct horse battery staple!";

// A verified, licensed password account, seeded with a client of its own
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
        email: `e2e-next-${randomUUID()}@example.com`,
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

let account: Awaited<ReturnType<typeof seedAccount>>;
test.beforeAll(async () => {
    account = await seedAccount();
});
test.afterAll(async () => {
    await account.cleanup();
});

// Carbon keeps the notification text in a property, not an attribute
const subtitle = (notification: Locator) =>
    notification.evaluate(
        (el) => (el as HTMLElement & { subtitle: string }).subtitle,
    );

async function logIn(page: Page, email: string) {
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
}

test("login returns to the protected page that asked for it", async ({
    page,
}) => {
    await page.goto("/history?range=7d");
    await expect(page).toHaveURL("/login?next=%2Fhistory%3Frange%3D7d");
    await expect(page).toHaveTitle("Log in · PulseBoard");
    await expect(
        page.getByRole("link", { name: "Create account" }),
    ).toHaveAttribute("href", "/register?next=%2Fhistory%3Frange%3D7d");

    await logIn(page, account.email);
    await expect(page).toHaveURL("/history?range=7d");
    await expect(page).toHaveTitle("History · PulseBoard");
    await expect(page.locator("html")).not.toHaveAttribute("data-auth-pending");
});

test("login ignores a next page on another site", async ({ page }) => {
    for (const next of ["//evil.example", "/\\evil.example"]) {
        await page.context().clearCookies();
        await page.goto(`/login?${new URLSearchParams({ next })}`);
        await logIn(page, account.email);
        await expect(page).toHaveURL("/overview");
    }
});

test("an OAuth error shows a fixed message and keeps the next page", async ({
    page,
}) => {
    await page.context().clearCookies();
    const crafted = "Your account is locked, call +1 555 0100";
    await page.goto(
        `/login?${new URLSearchParams({ oauth_error: crafted, provider: "google", next: "/history" })}`,
    );
    const error = page.locator("#login-form cds-inline-notification");
    await expect(error).toBeVisible();
    expect(await subtitle(error)).toBe("Couldn't sign in, please try again");
    await expect(page.getByText(crafted)).toHaveCount(0);
    await expect(page).toHaveURL("/login?next=%2Fhistory");

    await page.goto(
        "/login?oauth_error=cancelled&provider=google&next=%2Fhistory",
    );
    expect(await subtitle(error)).toBe("Google sign-in was cancelled");
    await logIn(page, account.email);
    await expect(page).toHaveURL("/history");
});

test("a protected page stays hidden until the session is checked", async ({
    page,
}) => {
    // hold the session check so the page can be inspected before the redirect
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/auth/me", async (route) => {
        await held;
        await route.continue();
    });

    await page.goto("/settings");
    await expect(page.locator("h1")).toHaveText("Account settings");
    expect(
        await page.evaluate(() => getComputedStyle(document.body).visibility),
    ).toBe("hidden");

    release();
    await expect(page).toHaveURL("/login?next=%2Fsettings");
});
