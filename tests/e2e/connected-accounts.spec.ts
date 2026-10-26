import { randomUUID } from "node:crypto";
import {
    expect,
    test,
    type APIRequestContext,
    type Page,
} from "@playwright/test";
import type { Contract } from "../../backend/src/prisma/contract.d";
import { testEnvironment } from "../environment.mjs";

const mailpit = process.env.TEST_MAILPIT_URL || "http://127.0.0.1:58025";
const password = "A password for my Google account!";

// A verified, licensed account that only signs in with Google. Like
// sessions.spec.ts, this file opens its own database client.
async function seedSocialAccount() {
    Object.assign(process.env, testEnvironment());
    const { default: postgres } =
        await import("../../backend/node_modules/@prisma/orm-postgres/dist/runtime.mjs");
    const { default: contractJson } = await import(
        "../../backend/src/prisma/contract.json",
        { with: { type: "json" } }
    );
    const db = postgres<Contract>({
        contractJson,
        url: process.env["DATABASE_URL"]!,
    });
    const now = new Date().toISOString();
    const email = `e2e-linking-${randomUUID()}@example.com`;
    const sub = `g-e2e-${randomUUID()}`;
    const user = await db.orm.public.User.create({
        email,
        passwordHash: null,
        emailVerifiedAt: now,
        licensePlan: "lifetime",
        licensedAt: now,
    });
    await db.orm.public.OAuthAccount.create({
        provider: "google",
        providerUserId: sub,
        userId: user.id,
        email,
    });
    return {
        email,
        sub,
        cleanup: async () => {
            await db.orm.public.User.where({ id: user.id }).delete();
            await db.close();
        },
    };
}

let account: Awaited<ReturnType<typeof seedSocialAccount>>;
test.beforeAll(async () => {
    account = await seedSocialAccount();
});
test.afterAll(async ({ request }) => {
    await account.cleanup();
    const search = await request.get(`${mailpit}/api/v1/search`, {
        params: { query: `to:${account.email}` },
    });
    const ids = ((await search.json()).messages ?? []).map(
        (m: { ID: string }) => m.ID,
    );
    if (ids.length)
        await request.delete(`${mailpit}/api/v1/messages`, {
            data: { IDs: ids },
        });
});

// Stands in for Google's consent page: sends the browser straight back to
// the callback, with the profile tests/google.mjs should return as the code
function consent(googleUrl: string): string {
    const url = new URL(googleUrl);
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.searchParams.set(
        "code",
        Buffer.from(
            JSON.stringify({ sub: account.sub, email: account.email }),
        ).toString("base64url"),
    );
    back.searchParams.set("state", url.searchParams.get("state")!);
    return back.toString();
}

async function playGoogle(page: Page) {
    // linking opens Google's page directly
    await page.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
            status: 302,
            headers: { location: consent(route.request().url()) },
        }),
    );
    // signing in gets there through a redirect, which routes don't see, so
    // the redirect itself is rewritten (keeping its state cookie)
    await page.route(
        (url) => url.pathname === "/api/auth/oauth/google",
        async (route) => {
            const response = await route.fetch({ maxRedirects: 0 });
            await route.fulfill({
                response,
                headers: {
                    ...response.headers(),
                    location: consent(response.headers()["location"]!),
                },
            });
        },
    );
}

async function findMail(request: APIRequestContext, subject: string) {
    let id: string | undefined;
    await expect
        .poll(
            async () => {
                const response = await request.get(`${mailpit}/api/v1/search`, {
                    params: {
                        query: `to:${account.email} subject:"${subject}"`,
                    },
                });
                id = (await response.json()).messages?.[0]?.ID;
                return id;
            },
            { timeout: 15000 },
        )
        .toBeTruthy();
    return (await request.get(`${mailpit}/api/v1/message/${id}`)).json();
}

test("a Google-only account sets a password, then disconnects and reconnects Google", async ({
    page,
    request,
}) => {
    await playGoogle(page);
    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expect(page).toHaveURL("/overview");

    await page.goto("/settings");
    const connected = page.locator("#connected-accounts");
    const google = connected.getByRole("listitem");
    await expect(google).toHaveCount(1);
    await expect(google).toContainText("Google");
    await expect(google).toContainText(account.email);
    // the only way to log in can't be removed
    const disconnect = google.getByRole("button", {
        name: /^Disconnect Google/,
    });
    await expect(disconnect).toBeDisabled();
    await expect(page.locator("#password-form")).toBeHidden();

    // Set a password through the emailed reset link
    await page
        .getByRole("button", { name: "Email me a link to set a password" })
        .click();
    await expect(page.locator("#set-password .success")).toContainText(
        `We sent a link to ${account.email}`,
    );
    const setup = await findMail(request, "Set a password for PulseBoard");
    const link = setup.Text.match(
        /http:\/\/127\.0\.0\.1:\d+\/reset-password\?purpose=set&token=[\w-]+/,
    )?.[0];
    expect(link).toBeTruthy();
    await page.goto(link!);
    await expect(page).toHaveURL("/reset-password");
    await page.locator('cds-text-input[name="password"] input').fill(password);
    await page.locator('cds-text-input[name="confirm"] input').fill(password);
    await page
        .getByRole("button", { name: "Set password", exact: true })
        .click();
    await expect(page).toHaveURL("/overview");
    await findMail(request, "A password was set for your PulseBoard account");

    // Now Google can go, and the change password form is offered
    await page.goto("/settings");
    await expect(page.locator("#password-form")).toBeVisible();
    await expect(page.locator("#set-password")).toBeHidden();
    await expect(disconnect).toBeEnabled();
    // disconnecting asks for the new password
    await disconnect.click();
    await expect(
        connected.getByText("Enter your current password to disconnect Google"),
    ).toBeVisible();
    const currentPassword = connected.locator(
        'cds-text-input[name="currentPassword"] input',
    );
    await currentPassword.fill(password);
    await disconnect.click();
    await expect(connected.locator(".success")).toHaveText(
        "Google disconnected. Other devices have been signed out.",
    );
    await expect(google).toHaveCount(0);
    await findMail(
        request,
        "Google was disconnected from your PulseBoard account",
    );

    // Connecting it again (the password is still filled in)
    await connected.getByRole("button", { name: "Connect Google" }).click();
    await expect(page).toHaveURL("/settings");
    await expect(connected.locator(".success")).toHaveText(
        "Google account connected.",
    );
    await expect(google).toHaveCount(1);
    await findMail(request, "Google was connected to your PulseBoard account");

    // and both ways in work
    const login = await page.request.post("/api/auth/login", {
        data: { email: account.email, password },
    });
    expect(login.status()).toBe(200);
});
