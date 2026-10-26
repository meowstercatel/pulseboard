import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const mailpit = process.env.TEST_MAILPIT_URL || "http://127.0.0.1:58025";

test("register, verify email from Mailpit, start the free trial, then buy a plan", async ({
    page,
    request,
}) => {
    const email = `e2e-${randomUUID()}@example.com`;
    const password = "A secure onboarding password!";
    let messageId: string | undefined;
    try {
        await page.goto("/register");
        await page.locator('input[name="email"]').fill(email);
        await page.locator('input[name="username"]').fill("E2E user");
        await page.locator('input[name="password"]').fill(password);
        await page.locator('input[name="confirm"]').fill(password);
        await page
            .getByRole("button", { name: "Create account", exact: true })
            .click();
        await expect(page.locator("#sent")).toContainText(email);
        await expect(page).toHaveURL("/register");
        // the verification link below is what signs the new account in
        expect((await page.request.get("/api/auth/me")).status()).toBe(401);

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
        // registering doesn't sign in, so the link asks for the password; a
        // password manager knows which account from the hidden username
        await expect(page.locator("#confirm-email")).toHaveText(email);
        await expect(page.locator("#confirm-username")).toHaveValue(email);
        await page.locator("#confirm-password").fill(password);
        await page
            .getByRole("button", { name: "Verify and sign in", exact: true })
            .click();
        await expect(page.locator("#done")).toBeVisible();
        await page.locator("#continue").click();
        // verifying started the 14-day trial, so the dashboard opens right away
        await expect(page).toHaveURL("/overview");
        await expect(page.locator("[data-trial-badge]")).toHaveText(
            "Free trial: 14 days left",
        );
        await page.locator("[data-trial-badge]").click();
        await expect(page).toHaveURL("/buy");
        await expect(page.locator("#license-status")).toHaveText(
            "free trial, 14 days left",
        );
        await expect(page.locator("#trial-ended")).toBeHidden();
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
        // a paid account has no trial badge
        await expect(page.locator("[data-trial-badge]")).toBeHidden();
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
