async function post<T>(
    path: string,
    body: unknown,
): Promise<T | { error: string }> {
    try {
        const res = await fetch(`/api/billing/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data) return data as T;
        return { error: data?.error ?? `Something went wrong (${res.status})` };
    } catch {
        return { error: "Can't reach the server" };
    }
}

// Opens Stripe Checkout for the plan; the license is granted after payment.
// Only call this once the buyer has ticked the withdrawal waiver.
export function checkout(plan: "subscription" | "lifetime") {
    return post<{ url: string }>("checkout", { plan, withdrawalWaiver: true });
}

// Lets the backend check the session with Stripe right after the redirect back.
export function confirmCheckout(sessionId: string) {
    return post<{ paymentStatus: string }>("confirm", { sessionId });
}

// Stripe's customer portal: cancel the subscription or change the card.
export function billingPortal() {
    return post<{ url: string }>("portal", {});
}
