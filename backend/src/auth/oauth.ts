import { createHash, createHmac } from "node:crypto";

export type OAuthProfile = {
    id: string;
    email: string | null;
    // only a verified email is used to find an existing account
    emailVerified: boolean;
    name: string | null;
};

export type OAuthProvider = {
    clientId: string;
    // whether its verified email proves the address: it may then sign in to an
    // existing account with it, and new accounts start out verified
    linksByEmail: boolean;
    // the URL to send the browser to; `verifier` is the PKCE code verifier
    authorizeUrl(redirectUri: string, state: string, verifier: string): string;
    // trades the callback `code` for the user's profile
    fetchProfile(
        code: string,
        redirectUri: string,
        verifier: string,
    ): Promise<OAuthProfile>;
};

// Sent to /login as ?oauth_error=, which maps each code to a fixed message
export type OAuthErrorCode =
    "cancelled" | "expired" | "no_verified_email" | "email_taken" | "failed";

// Thrown for anything the user should see as a sign-in error
export class OAuthError extends Error {
    constructor(
        readonly code: OAuthErrorCode,
        message: string = code,
    ) {
        super(message);
    }
}

async function getJson(res: Response, what: string): Promise<any> {
    const data: any = await res.json().catch(() => null);
    if (!res.ok || !data) {
        console.error(`OAuth ${what} failed (${res.status})`, data);
        throw new OAuthError("failed", `Couldn't ${what}`);
    }
    return data;
}

function google(clientId: string, clientSecret: string): OAuthProvider {
    return {
        clientId,
        linksByEmail: true,
        authorizeUrl(redirectUri, state, verifier) {
            const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
            url.search = new URLSearchParams({
                client_id: clientId,
                redirect_uri: redirectUri,
                response_type: "code",
                scope: "openid email profile",
                state,
                code_challenge: createHash("sha256")
                    .update(verifier)
                    .digest("base64url"),
                code_challenge_method: "S256",
                prompt: "select_account",
            }).toString();
            return url.toString();
        },
        async fetchProfile(code, redirectUri, verifier) {
            const token = await getJson(
                await fetch("https://oauth2.googleapis.com/token", {
                    method: "POST",
                    body: new URLSearchParams({
                        code,
                        client_id: clientId,
                        client_secret: clientSecret,
                        redirect_uri: redirectUri,
                        grant_type: "authorization_code",
                        code_verifier: verifier,
                    }),
                }),
                "get a Google access token",
            );
            const info = await getJson(
                await fetch(
                    "https://openidconnect.googleapis.com/v1/userinfo",
                    {
                        headers: {
                            authorization: `Bearer ${token.access_token}`,
                        },
                    },
                ),
                "read your Google profile",
            );
            return {
                id: String(info.sub),
                email: typeof info.email === "string" ? info.email : null,
                emailVerified: info.email_verified === true,
                name: typeof info.name === "string" ? info.name : null,
            };
        },
    };
}

const FACEBOOK_API = "v23.0";

function facebook(appId: string, appSecret: string): OAuthProvider {
    return {
        clientId: appId,
        linksByEmail: false,
        authorizeUrl(redirectUri, state) {
            const url = new URL(
                `https://www.facebook.com/${FACEBOOK_API}/dialog/oauth`,
            );
            url.search = new URLSearchParams({
                client_id: appId,
                redirect_uri: redirectUri,
                response_type: "code",
                scope: "email public_profile",
                state,
            }).toString();
            return url.toString();
        },
        async fetchProfile(code, redirectUri) {
            const tokenUrl = new URL(
                `https://graph.facebook.com/${FACEBOOK_API}/oauth/access_token`,
            );
            tokenUrl.search = new URLSearchParams({
                client_id: appId,
                client_secret: appSecret,
                redirect_uri: redirectUri,
                code,
            }).toString();
            const token = await getJson(
                await fetch(tokenUrl),
                "get a Facebook access token",
            );

            const meUrl = new URL(
                `https://graph.facebook.com/${FACEBOOK_API}/me`,
            );
            meUrl.search = new URLSearchParams({
                fields: "id,name,email",
                access_token: token.access_token,
                appsecret_proof: createHmac("sha256", appSecret)
                    .update(token.access_token)
                    .digest("hex"),
            }).toString();
            const me = await getJson(
                await fetch(meUrl),
                "read your Facebook profile",
            );
            return {
                id: String(me.id),
                email: typeof me.email === "string" ? me.email : null,
                // Facebook has no verified flag, so its email never links an
                // existing account, and new accounts must verify it by email
                emailVerified: typeof me.email === "string",
                name: typeof me.name === "string" ? me.name : null,
            };
        },
    };
}

function configured(): Record<string, OAuthProvider> {
    const env = process.env;
    // no prototype, so /oauth/constructor isn't a provider
    const providers: Record<string, OAuthProvider> = Object.create(null);
    if (env["GOOGLE_CLIENT_ID"] && env["GOOGLE_CLIENT_SECRET"]) {
        providers["google"] = google(
            env["GOOGLE_CLIENT_ID"],
            env["GOOGLE_CLIENT_SECRET"],
        );
    }
    if (env["FACEBOOK_APP_ID"] && env["FACEBOOK_APP_SECRET"]) {
        providers["facebook"] = facebook(
            env["FACEBOOK_APP_ID"],
            env["FACEBOOK_APP_SECRET"],
        );
    }
    return providers;
}

// Only providers with credentials in the environment are enabled
export const providers = configured();

export const PROVIDER_NAMES: Record<string, string> = {
    google: "Google",
    facebook: "Facebook",
};
