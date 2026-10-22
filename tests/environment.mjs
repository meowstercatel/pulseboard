export function testEnvironment() {
    const databaseUrl =
        process.env.TEST_DATABASE_URL ||
        "postgresql://pulseboard:pulseboard@127.0.0.1:55439/pulseboard_test";
    const url = new URL(databaseUrl);
    if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        !decodeURIComponent(url.pathname).endsWith("_test")
    ) {
        throw new Error(
            "TEST_DATABASE_URL must point to a database ending in _test",
        );
    }
    return {
        NODE_ENV: "test",
        DATABASE_URL: databaseUrl,
        TRUST_PROXY: "true",
        PUBLIC_URL: `http://127.0.0.1:${process.env.TEST_PORT || "4300"}`,
        STATIC_DIR: "",
        SMTP_URL: "",
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "",
        FACEBOOK_APP_ID: "",
        FACEBOOK_APP_SECRET: "",
        STRIPE_SECRET_KEY: "sk_test_pulseboard_fixture",
        STRIPE_PRICE_SUBSCRIPTION: "price_test_subscription",
        STRIPE_PRICE_LIFETIME: "price_test_lifetime",
        STRIPE_WEBHOOK_SECRET: "whsec_test_fixture",
    };
}
