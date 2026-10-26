import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { Contract } from "../../backend/src/prisma/contract.d";
import { testEnvironment } from "../environment.mjs";

const mailpit = process.env.TEST_MAILPIT_URL || "http://127.0.0.1:58025";
// set by whoever registers the address
const password = "The registering password!";
const ownersPassword = "The address owner's own password!";

async function findMail(
    request: APIRequestContext,
    email: string,
    subject: string,
) {
    let id: string | undefined;
    await expect
        .poll(
            async () => {
                const response = await request.get(`${mailpit}/api/v1/search`, {
                    params: { query: `to:${email} subject:"${subject}"` },
                });
                id = (await response.json()).messages?.[0]?.ID;
                return id;
            },
            { timeout: 15000 },
        )
        .toBeTruthy();
    return (await request.get(`${mailpit}/api/v1/message/${id}`)).json();
}

async function deleteMail(request: APIRequestContext, email: string) {
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

async function verificationLink(request: APIRequestContext, email: string) {
    const message = await findMail(
        request,
        email,
        "Verify your PulseBoard email address",
    );
    const link = message.Text.match(
        /http:\/\/127\.0\.0\.1:\d+\/verify-email\?token=[\w-]+/,
    )?.[0];
    expect(link).toBeTruthy();
    return link as string;
}

test("a link opened in another browser asks for the account's password", async ({
    page,
    request,
}) => {
    const email = `e2e-verify-password-${randomUUID()}@example.com`;
    try {
        // registered on another device; this browser has no session
        expect(
            (
                await request.post("/api/auth/register", {
                    data: { email, password },
                })
            ).status(),
        ).toBe(202);
        await page.goto(await verificationLink(request, email));

        await expect(page.locator("#confirm-email")).toHaveText(email);
        // native inputs a password manager can fill
        const username = page.locator("#confirm-username");
        await expect(username).toHaveAttribute("autocomplete", "username");
        await expect(username).toHaveValue(email);
        const field = page.locator("#confirm-password");
        await expect(field).toHaveAttribute("autocomplete", "current-password");
        await expect(field).toHaveAttribute("type", "password");
        // nothing is verified or signed in yet
        expect((await page.request.get("/api/auth/me")).status()).toBe(401);

        await field.fill("not the password");
        await field.press("Enter");
        await expect(page.locator("#confirm-form")).toContainText(
            "Wrong password",
        );
        await field.fill(password);
        await page
            .getByRole("button", { name: "Verify and sign in", exact: true })
            .click();
        await expect(page.locator("#verified-message")).toHaveText(
            "Your email address is verified.",
        );
        await page.getByRole("button", { name: "Continue" }).click();
        // verifying started the free trial
        await expect(page).toHaveURL("/overview");
        const me = await (await page.request.get("/api/auth/me")).json();
        expect(me.user).toMatchObject({ email, emailVerified: true });
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
        await deleteMail(request, email);
    }
});

test("“I didn't create this account” locks out whoever registered the address", async ({
    page,
    browser,
    request,
}) => {
    const email = `e2e-not-mine-${randomUUID()}@example.com`;
    // the intruder registers the owner's address and logs in
    const intruder = await browser.newContext();
    try {
        expect(
            (
                await intruder.request.post("/api/auth/register", {
                    data: { email, password },
                })
            ).status(),
        ).toBe(202);
        expect(
            (
                await intruder.request.post("/api/auth/login", {
                    data: { email, password },
                })
            ).status(),
        ).toBe(200);

        // the owner opens the link from their inbox
        await page.goto(await verificationLink(request, email));
        await expect(page.locator("#confirm-email")).toHaveText(email);
        await page
            .getByRole("button", { name: "I didn't create this account" })
            .click();
        await expect(page.locator("#disowned-message")).toContainText(
            `We sent a link to ${email} to choose your own password.`,
        );
        // the intruder is out, and their password no longer works
        expect((await intruder.request.get("/api/auth/me")).status()).toBe(401);
        expect(
            (
                await intruder.request.post("/api/auth/login", {
                    data: { email, password },
                })
            ).status(),
        ).toBe(401);

        const message = await findMail(
            request,
            email,
            "Choose a password for PulseBoard",
        );
        const link = message.Text.match(
            /http:\/\/127\.0\.0\.1:\d+\/reset-password\?purpose=set&token=[\w-]+#email=[^\s]+/,
        )?.[0];
        expect(link).toBeTruthy();
        await page.goto(link!);
        await expect(page.locator("#reset-username")).toHaveValue(email);
        await page.locator('input[name="password"]').fill(ownersPassword);
        await page.locator('input[name="confirm"]').fill(ownersPassword);
        await page
            .getByRole("button", { name: "Set password", exact: true })
            .click();
        // the trial started when the address was verified
        await expect(page).toHaveURL("/overview");
        await expect(page.locator("[data-trial-badge]")).toHaveText(
            "Free trial: 14 days left",
        );
        expect(
            (
                await intruder.request.post("/api/auth/login", {
                    data: { email, password },
                })
            ).status(),
        ).toBe(401);
    } finally {
        await intruder.close();
        for (const currentPassword of [ownersPassword, password]) {
            await page.request.post("/api/auth/login", {
                data: { email, password: currentPassword },
            });
            await page.request.post("/api/auth/delete-account", {
                data: { confirmation: "delete my account", currentPassword },
            });
        }
        await deleteMail(request, email);
    }
});

// An unverified account with a password and a pending verification link, as
// registering leaves it. Seeded, because the suite's registrations from one
// IP already reach the hourly limit.
async function seedRegistration() {
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
    const email = `e2e-verify-reset-${randomUUID()}@example.com`;
    const salt = randomBytes(16);
    const user = await db.orm.public.User.create({
        email,
        // the format from before scrypt parameters were stored, which the
        // backend still accepts
        passwordHash: `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 64).toString("hex")}`,
    });
    const token = randomBytes(32).toString("base64url");
    await db.orm.public.EmailVerification.create({
        tokenHash: createHash("sha256").update(token).digest("hex"),
        userId: user.id,
        email,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    return {
        email,
        link: `/verify-email?token=${token}`,
        cleanup: async () => {
            await db.orm.public.User.where({ id: user.id }).delete();
            await db.close();
        },
    };
}

test("a confirm form left open after a reset verified the address says so", async ({
    page,
    request,
}) => {
    const { email, link, cleanup } = await seedRegistration();
    try {
        await page.goto(link);
        await expect(page.locator("#confirm-email")).toHaveText(email);

        // meanwhile, in another tab of this browser: "Forgot password?",
        // whose link verifies the address and signs in
        await page.request.post("/api/auth/password-reset", {
            data: { email },
        });
        const reset = await findMail(
            request,
            email,
            "Reset your PulseBoard password",
        );
        const token = reset.Text.match(/reset-password\?token=([\w-]+)/)?.[1];
        expect(
            (
                await page.request.post("/api/auth/password-reset/confirm", {
                    data: { token, newPassword: ownersPassword },
                })
            ).status(),
        ).toBe(200);

        await page.locator("#confirm-password").fill(ownersPassword);
        await page
            .getByRole("button", { name: "Verify and sign in", exact: true })
            .click();
        await expect(page.locator("#verified-message")).toContainText(
            "already has a verified email address",
        );
        await expect(page.locator("#failed")).toBeHidden();
    } finally {
        await cleanup();
        await deleteMail(request, email);
    }
});
