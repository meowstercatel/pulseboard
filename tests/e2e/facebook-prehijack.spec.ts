import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { Contract } from "../../backend/src/prisma/contract.d";
import { testEnvironment } from "../environment.mjs";

const mailpit = process.env.TEST_MAILPIT_URL || "http://127.0.0.1:58025";
const password = "The address owner's own password!";
const sha256 = (value: string) =>
    createHash("sha256").update(value).digest("hex");

// What a Facebook sign-up with someone else's address leaves behind: an
// unverified account without a password, the intruder's Facebook login and
// session, and a pending verification link in the owner's inbox. Facebook is
// disabled in the browser suite, so the rows are seeded; the sign-up itself
// is covered by backend/tests/integration/oauth.test.ts.
async function seedPreHijack() {
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
    const email = `e2e-prehijack-${randomUUID()}@example.com`;
    const user = await db.orm.public.User.create({
        email,
        passwordHash: null,
    });
    await db.orm.public.OAuthAccount.create({
        provider: "facebook",
        providerUserId: `fb-e2e-${randomUUID()}`,
        userId: user.id,
        email,
    });
    const intruderToken = randomBytes(32).toString("base64url");
    const now = Date.now();
    await db.orm.public.Session.create({
        id: sha256(intruderToken),
        userId: user.id,
        expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
    });
    const verifyToken = randomBytes(32).toString("base64url");
    await db.orm.public.EmailVerification.create({
        tokenHash: sha256(verifyToken),
        userId: user.id,
        email,
        expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    });
    return {
        email,
        intruderToken,
        verifyToken,
        cleanup: async () => {
            await db.orm.public.User.where({ id: user.id }).delete();
            await db.close();
        },
    };
}

let account: Awaited<ReturnType<typeof seedPreHijack>>;
test.beforeAll(async () => {
    account = await seedPreHijack();
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

test("the address owner's verification link removes someone else's Facebook login", async ({
    page,
    browser,
    request,
    baseURL,
}) => {
    // the intruder's browser, still signed in to the account
    const intruder = await browser.newContext();
    await intruder.addCookies([
        { name: "session", value: account.intruderToken, url: baseURL! },
    ]);
    expect((await intruder.request.get("/api/auth/me")).status()).toBe(200);

    // the owner opens the link from their inbox in their own browser
    await page.goto(`/verify-email?token=${account.verifyToken}`);
    await expect(page.locator("#verified-message")).toHaveText(
        "Your email address is verified. The Facebook login connected before you verified it was removed, because it may not have been yours. If it was, connect it again in Settings. Set a password in Settings, so you can log in again after you sign out.",
    );
    expect((await intruder.request.get("/api/auth/me")).status()).toBe(401);
    await intruder.close();

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL("/settings");
    await expect(
        page.locator("#connected-accounts").getByRole("listitem"),
    ).toHaveCount(0);

    // Even after signing out, a password can be set from the login page
    await page.request.post("/api/auth/logout");
    await page.goto("/forgot-password");
    await page.locator('input[name="email"]').fill(account.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.locator("#sent")).toBeVisible();
    const setup = await findMail(request, "Set a password for PulseBoard");
    // it lists no logins: the Facebook one is gone
    expect(setup.Text).not.toContain("Facebook");
    const link = setup.Text.match(
        /http:\/\/127\.0\.0\.1:\d+\/reset-password\?purpose=set&token=[\w-]+/,
    )?.[0];
    expect(link).toBeTruthy();
    await page.goto(link!);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('input[name="confirm"]').fill(password);
    await page
        .getByRole("button", { name: "Set password", exact: true })
        .click();
    // verifying the address started the free trial
    await expect(page).toHaveURL("/overview");

    const login = await page.request.post("/api/auth/login", {
        data: { email: account.email, password },
    });
    expect(login.status()).toBe(200);
});
