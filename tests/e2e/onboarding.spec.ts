import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const mailpit = process.env.TEST_MAILPIT_URL || "http://127.0.0.1:58025";

test("register, verify email from Mailpit, choose a plan and open the dashboard", async ({
    page,
    request,
}) => {
    const email = `e2e-${randomUUID()}@example.com`;
    const password = "A secure onboarding password!";
    let messageId: string | undefined;
    try {
        await page.goto("/register");
        await page.locator('cds-text-input[name="email"] input').fill(email);
        await page
            .locator('cds-text-input[name="username"] input')
            .fill("E2E user");
        await page
            .locator('cds-text-input[name="password"] input')
            .fill(password);
        await page
            .locator('cds-text-input[name="confirm"] input')
            .fill(password);
        await page
            .getByRole("button", { name: "Register", exact: true })
            .click();
        await expect(page).toHaveURL("/verify-email");
        await expect(page.locator("#pending")).toContainText(email);

        await expect
            .poll(
                async () => {
                    const response = await request.get(
                        `${mailpit}/api/v1/search`,
                        { params: { query: `to:${email}` } },
                    );
                    expect(response.ok()).toBe(true);
                    const data = await response.json();
                    messageId = data.messages?.[0]?.ID;
                    return messageId;
                },
                { timeout: 15000 },
            )
            .toBeTruthy();
        const message = await request.get(
            `${mailpit}/api/v1/message/${messageId}`,
        );
        expect(message.ok()).toBe(true);
        const body = await message.json();
        const link = body.Text.match(
            /http:\/\/127\.0\.0\.1:\d+\/verify-email\?token=[A-Za-z0-9_-]+/,
        )?.[0];
        expect(link).toBeTruthy();
        await page.goto(link!);
        await expect(page.locator("#done")).toBeVisible();
        await page.locator("#continue").click();
        await expect(page).toHaveURL("/buy");
        // Carbon hides the native input; click the drawn box like a user would
        await page.locator("#waiver label").click({ position: { x: 8, y: 8 } });
        await expect(
            page.getByRole("checkbox", { name: /right of withdrawal/ }),
        ).toBeChecked();
        await page.locator('cds-button[data-plan="lifetime"]').click();
        await expect(page).toHaveURL("/overview");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        const me = await page.request.get("/api/auth/me");
        expect(me.status()).toBe(200);
        expect((await me.json()).user).toMatchObject({
            email,
            emailVerified: true,
            licensePlan: "lifetime",
        });
        await page.reload();
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page).toHaveURL("/overview");
    } finally {
        // Delete only this test's account and message, including after a failed assertion.
        await page.request.post("/api/auth/delete-account", {
            data: {
                confirmation: "delete my account",
                currentPassword: password,
            },
        });
        if (messageId)
            await request.delete(`${mailpit}/api/v1/messages`, {
                data: { IDs: [messageId] },
            });
    }
});
