import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const mailpit = process.env.TEST_MAILPIT_URL || "http://127.0.0.1:58025";

test("reset a forgotten password from the emailed link", async ({
    page,
    request,
}) => {
    const email = `e2e-reset-${randomUUID()}@example.com`;
    const oldPassword = "The password I forgot!";
    const newPassword = "A freshly reset password!";
    try {
        const registered = await page.request.post("/api/auth/register", {
            data: { email, password: oldPassword },
        });
        expect(registered.status()).toBe(201);
        await page.request.post("/api/auth/logout");

        await page.goto("/login");
        await page.getByText("Forgot password?").click();
        await expect(page).toHaveURL("/forgot-password");
        await page.locator('cds-text-input[name="email"] input').fill(email);
        await page
            .getByRole("button", { name: "send reset link", exact: true })
            .click();
        await expect(page.locator("#sent")).toContainText(email);

        let messageId: string | undefined;
        await expect
            .poll(
                async () => {
                    const response = await request.get(
                        `${mailpit}/api/v1/search`,
                        {
                            params: {
                                query: `to:${email} subject:"Reset your PulseBoard password"`,
                            },
                        },
                    );
                    expect(response.ok()).toBe(true);
                    messageId = (await response.json()).messages?.[0]?.ID;
                    return messageId;
                },
                { timeout: 15000 },
            )
            .toBeTruthy();
        const message = await (
            await request.get(`${mailpit}/api/v1/message/${messageId}`)
        ).json();
        expect(message.HTML).toContain(">reset password</a>");
        const link = message.Text.match(
            /http:\/\/127\.0\.0\.1:4300\/reset-password\?token=[A-Za-z0-9_-]+/,
        )?.[0];
        expect(link).toBeTruthy();

        await page.goto(link!);
        await expect(page).toHaveURL("/reset-password");
        await page
            .locator('cds-text-input[name="password"] input')
            .fill(newPassword);
        await page
            .locator('cds-text-input[name="confirm"] input')
            .fill(newPassword);
        await page
            .getByRole("button", { name: "reset password", exact: true })
            .click();
        await expect(page).toHaveURL("/buy");
        const me = await page.request.get("/api/auth/me");
        expect((await me.json()).user).toMatchObject({
            email,
            emailVerified: true,
        });

        await page.request.post("/api/auth/logout");
        const login = await page.request.post("/api/auth/login", {
            data: { email, password: newPassword },
        });
        expect(login.status()).toBe(200);
    } finally {
        for (const password of [newPassword, oldPassword]) {
            const login = await page.request.post("/api/auth/login", {
                data: { email, password },
            });
            if (login.ok()) break;
        }
        await page.request.post("/api/auth/delete-account", {
            data: { confirmation: "delete my account" },
        });
        const search = await request.get(`${mailpit}/api/v1/search`, {
            params: { query: `to:${email}` },
        });
        const ids = ((await search.json()).messages ?? []).map(
            (m: { ID: string }) => m.ID,
        );
        if (ids.length)
            await request.delete(`${mailpit}/api/v1/messages`, {
                data: { IDs: ids },
            });
    }
});
