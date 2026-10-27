import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "./fixtures";
import type { Contract } from "../../backend/src/prisma/contract.d";
import { testEnvironment } from "../environment.mjs";

const password = "Correct horse battery staple!";
const FIREFOX_LINUX =
    "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";

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
        email: `e2e-sessions-${randomUUID()}@example.com`,
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

async function logIn(page: Page) {
    await page.goto("/login");
    await page.locator('input[name="email"]').fill(account.email);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await expect(page).toHaveURL("/overview");
}

// A second browser with its own cookies, like another device
async function otherDevice(browser: Browser) {
    const context = await browser.newContext({ userAgent: FIREFOX_LINUX });
    const page = await context.newPage();
    await logIn(page);
    return { context, page };
}

async function expectSignedOut(page: Page) {
    await page.goto("/settings");
    await expect(page).toHaveURL("/login?next=%2Fsettings");
}

test("lists devices and signs them out one by one or all at once", async ({
    page,
    browser,
}) => {
    const laptop = await otherDevice(browser);
    await logIn(page);
    await page.goto("/settings#sessions");

    const section = page.locator("#sessions");
    const devices = section.getByRole("listitem");
    await expect(devices).toHaveCount(2);
    await expect(devices.first()).toContainText("Chrome on");
    await expect(devices.first()).toContainText("This device");
    await expect(devices.first()).toContainText("Active now");
    await expect(devices.nth(1)).toContainText("Firefox on Linux");
    await expect(devices.nth(1)).toContainText("IP ");

    await devices
        .nth(1)
        .getByRole("button", { name: /^Sign out Firefox on Linux/ })
        .click();
    await expect(section.locator(".success")).toHaveText(
        "Signed out that device.",
    );
    await expect(devices).toHaveCount(1);
    await expect(
        section.getByRole("button", { name: "Log out everywhere else" }),
    ).toBeDisabled();
    await expectSignedOut(laptop.page);

    const first = await otherDevice(browser);
    const second = await otherDevice(browser);
    await page.reload();
    await expect(devices).toHaveCount(3);
    await section
        .getByRole("button", { name: "Log out everywhere else" })
        .click();
    await expect(section.locator(".success")).toHaveText(
        "Signed out all other devices.",
    );
    await expect(devices).toHaveCount(1);
    await expectSignedOut(first.page);
    await expectSignedOut(second.page);

    // this device is still signed in
    await page.reload();
    await expect(page).toHaveURL("/settings#sessions");
    await expect(devices).toHaveCount(1);

    for (const device of [laptop, first, second]) await device.context.close();
});
