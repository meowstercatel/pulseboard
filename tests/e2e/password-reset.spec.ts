import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const mailpit = process.env.TEST_MAILPIT_URL || "http://127.0.0.1:58025";

test("reset a forgotten password from the emailed link", async ({
    page,
    request,
    baseURL,
}) => {
    const email = `e2e-reset-${randomUUID()}@example.com`;
    const oldPassword = "The password I forgot!";
    const newPassword = "A freshly reset password!";
    try {
        const registered = await page.request.post("/api/auth/register", {
            data: { email, password: oldPassword },
        });
        expect(registered.status()).toBe(202);
        await page.request.post("/api/auth/logout", {
            // a browser sends this itself; the API client does not
            headers: { origin: baseURL! },
        });

        await page.goto("/login");
        await page.getByText("Forgot password?").click();
        await expect(page).toHaveURL("/forgot-password");
        await page.locator('input[name="email"]').fill(email);
        await page
            .getByRole("button", { name: "Send reset link", exact: true })
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
            /http:\/\/127\.0\.0\.1:\d+\/reset-password\?token=[A-Za-z0-9_-]+#email=\S+/,
        )?.[0];
        expect(link).toBeTruthy();

        await page.goto(link!);
        await expect(page).toHaveURL("/reset-password");
        // password managers save the new password for this address
        await expect(
            page.locator('#reset-form input[autocomplete="username"]'),
        ).toHaveValue(email);
        await page.locator('input[name="password"]').fill(newPassword);
        await page.locator('input[name="confirm"]').fill(newPassword);
        await page
            .getByRole("button", { name: "Reset password", exact: true })
            .click();
        // the emailed link verified the address, which starts the free trial
        await expect(page).toHaveURL("/overview");
        const me = await page.request.get("/api/auth/me");
        expect((await me.json()).user).toMatchObject({
            email,
            emailVerified: true,
        });

        await page.request.post("/api/auth/logout", {
            headers: { origin: baseURL! },
        });
        const login = await page.request.post("/api/auth/login", {
            data: { email, password: newPassword },
        });
        expect(login.status()).toBe(200);
    } finally {
        let currentPassword = oldPassword;
        for (const password of [newPassword, oldPassword]) {
            const login = await page.request.post("/api/auth/login", {
                data: { email, password },
            });
            if (login.ok()) {
                currentPassword = password;
                break;
            }
        }
        await page.request.post("/api/auth/delete-account", {
            data: { confirmation: "delete my account", currentPassword },
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
