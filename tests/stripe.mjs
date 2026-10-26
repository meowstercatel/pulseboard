import { randomUUID } from "node:crypto";
import nock from "nock";

// Keep the real Stripe SDK and replace only its external HTTP responses.
// `sessions` holds the Checkout Sessions created, `checkoutParams` the form
// fields each was created with, `customerUpdates` the customer id and fields of
// each update.
export function mockStripe() {
    const sessions = new Map();
    const checkoutParams = new Map();
    const customerUpdates = [];
    nock.disableNetConnect();
    nock.enableNetConnect(/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/);
    nock("https://api.stripe.com")
        .persist()
        .post("/v1/customers")
        .reply(200, () => ({ id: `cus_${randomUUID()}`, object: "customer" }))
        // checkout keeps an existing customer's email current
        .post(/^\/v1\/customers\/cus_[\w-]+$/)
        .reply(200, async (request) => {
            const id = new URL(request.url).pathname.split("/").at(-1);
            customerUpdates.push({
                id,
                fields: new URLSearchParams(await request.text()),
            });
            return { id, object: "customer" };
        })
        .post("/v1/checkout/sessions")
        .reply(200, async (request) => {
            const fields = new URLSearchParams(await request.text());
            const id = `cs_test_${randomUUID()}`;
            const session = {
                id,
                object: "checkout.session",
                mode: fields.get("mode"),
                customer: fields.get("customer"),
                client_reference_id: fields.get("client_reference_id"),
                metadata: { plan: fields.get("metadata[plan]") },
                payment_status: "paid",
                subscription: null,
                url: fields
                    .get("success_url")
                    .replace("{CHECKOUT_SESSION_ID}", id),
            };
            sessions.set(id, session);
            checkoutParams.set(id, fields);
            return session;
        })
        .get(/^\/v1\/checkout\/sessions\/cs_test_[\w-]+$/)
        .reply((request) => {
            const session = sessions.get(
                new URL(request.url).pathname.split("/").at(-1),
            );
            return session
                ? [200, session]
                : [404, { error: { message: "Unknown test session" } }];
        });
    return {
        sessions,
        checkoutParams,
        customerUpdates,
        close() {
            nock.cleanAll();
            nock.enableNetConnect();
        },
    };
}
