import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "./fixtures";

const mailpit = process.env.TEST_MAILPIT_URL || "http://127.0.0.1:58025";
const password = "A secure verification password!";

async function verificationLink(
    request: APIRequestContext,
    email: string,
    previous?: string,
) {
    let link = "";
    await expect
        .poll(
            async () => {
                const response = await request.get(`${mailpit}/api/v1/search`, {
                    params: { query: `to:${email}` },
                });
                const messages = (await response.json()).messages ?? [];
                for (const message of messages) {
                    const body = await (
                        await request.get(
                            `${mailpit}/api/v1/message/${message.ID}`,
                        )
                    ).json();
                    const candidate = body.Text.match(
                        /http:\/\/127\.0\.0\.1:\d+\/verify-email\?token=[A-Za-z0-9_-]+/,
                    )?.[0];
                    if (candidate && candidate !== previous) {
                        link = candidate;
                        return true;
                    }
                }
                return false;
            },
            { timeout: 15000 },
        )
        .toBe(true);
    return link;
}

test("unverified login stays restricted; replaced and used links recover clearly", async ({
    page,
    request,
    baseURL,
}) => {
    const email = `e2e-verification-${randomUUID()}@example.com`;
    try {
        expect(
            (
                await page.request.post("/api/auth/register", {
                    data: { email, password },
                })
            ).status(),
        ).toBe(202);
        const original = await verificationLink(request, email);
        await page.request.post("/api/auth/logout", {
            // a browser sends this itself; the API client does not
            headers: { origin: baseURL! },
        });
        await page.goto("/login");
        await page.locator('input[name="email"]').fill(email);
        const field = page.locator('.field:has(input[name="password"])');
        await field.locator("input").fill(password);
        await field
            .getByRole("button", { name: "Show password", exact: true })
            .focus();
        await page.keyboard.press("Enter");
        await expect(field.locator("input")).toHaveAttribute("type", "text");
        await expect(field.locator("input")).toHaveValue(password);
        await expect(page).toHaveURL("/login");
        await field
            .getByRole("button", { name: "Hide password", exact: true })
            .click();
        await expect(field.locator("input")).toHaveAttribute(
            "type",
            "password",
        );
        await page.getByRole("button", { name: "Log in", exact: true }).click();
        await expect(page).toHaveURL("/verify-email");
        await expect(page.locator("#pending")).toContainText(email);
        expect(
            (
                await page.request.post("/api/billing/checkout", {
                    data: { plan: "lifetime" },
                })
            ).status(),
        ).toBe(403);
        expect((await page.request.get("/api/datasets/1/hosts")).status()).toBe(
            403,
        );
        await page.goto("/buy");
        await expect(page).toHaveURL("/verify-email");

        await page
            .getByRole("button", { name: "Resend email", exact: true })
            .click();
        await expect(page.locator("#status")).toHaveText(
            "Sent! Check your inbox.",
        );
        const replacement = await verificationLink(request, email, original);
        await page.goto(original);
        await expect(page.locator("#failed")).toContainText(
            "invalid or has expired",
        );
        await page
            .getByRole("link", { name: "Request a new link", exact: true })
            .click();
        await expect(page.locator("#pending")).toContainText(email);

        await page.goto(replacement);
        // #done ships hidden with this text, so wait until the page shows it:
        // leaving earlier would let the next visit use the link first
        await expect(page.locator("#done")).toBeVisible();
        await expect(page.locator("#done")).toContainText(
            "Your email address is verified.",
        );
        await page.goto(replacement);
        await expect(page.locator("#done")).toContainText(
            "already has a verified email address",
        );
        await expect(page.locator("#failed")).toBeHidden();
        await page.goto("/verify-email");
        await expect(page.locator("#done")).toContainText("already verified");
        await page
            .getByRole("button", { name: "Continue", exact: true })
            .click();
        // verifying started the free trial
        await expect(page).toHaveURL("/overview");

        await page.request.post("/api/auth/logout", {
            headers: { origin: baseURL! },
        });
        await page.goto(replacement);
        await expect(page.locator("#failed")).toBeVisible();
        await expect(
            page.getByRole("link", { name: "Log in to request a new link" }),
        ).toHaveAttribute("href", "/login");
    } finally {
        await page.request.post("/api/auth/login", {
            data: { email, password },
        });
        await page.request.post("/api/auth/delete-account", {
            data: {
                confirmation: "delete my account",
                currentPassword: password,
            },
        });
        const messages = await (
            await request.get(`${mailpit}/api/v1/search`, {
                params: { query: `to:${email}` },
            })
        ).json();
        const ids = (messages.messages ?? []).map(
            (message: { ID: string }) => message.ID,
        );
        if (ids.length)
            await request.delete(`${mailpit}/api/v1/messages`, {
                data: { IDs: ids },
            });
    }
});

test("registration password visibility is independent and preserves values", async ({
    page,
}) => {
    await page.goto("/register");
    const first = page.locator('.field:has(input[name="password"])');
    const repeat = page.locator('.field:has(input[name="confirm"])');
    await first.locator("input").fill(password);
    await repeat.locator("input").fill(password);
    await first
        .getByRole("button", { name: "Show password", exact: true })
        .click();
    await expect(first.locator("input")).toHaveAttribute("type", "text");
    await expect(repeat.locator("input")).toHaveAttribute("type", "password");
    await repeat
        .getByRole("button", { name: "Show password", exact: true })
        .click();
    await expect(repeat.locator("input")).toHaveValue(password);
    await expect(repeat.locator("input")).toHaveAttribute("type", "text");
    await expect(page).toHaveURL("/register");
});
