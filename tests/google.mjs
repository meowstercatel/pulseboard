import nock from "nock";

// Google's token and profile endpoints. The browser test plays Google's
// consent page and puts the profile it wants in the code (base64url JSON),
// which comes back here as the access token.
export function mockGoogle() {
    nock("https://oauth2.googleapis.com")
        .persist()
        .post("/token")
        .reply(200, async (request) => ({
            access_token: new URLSearchParams(await request.text()).get("code"),
        }));
    nock("https://openidconnect.googleapis.com")
        .persist()
        .get("/v1/userinfo")
        .reply((request) => {
            const token = String(request.headers.get("authorization")).replace(
                /^Bearer /,
                "",
            );
            const profile = JSON.parse(
                Buffer.from(token, "base64url").toString(),
            );
            return [200, { email_verified: true, name: "E2E", ...profile }];
        });
}
