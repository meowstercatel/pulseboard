import { describe, expect, it } from "vitest";
import { accountChangedTemplate } from "../../src/mail/accountChangedTemplate.js";
import { claimAccountTemplate } from "../../src/mail/claimAccountTemplate.js";
import { escapeHtml } from "../../src/mail/layout.js";
import { setPasswordTemplate } from "../../src/mail/setPasswordTemplate.js";

const settings = "https://pulseboard.example/settings";

describe("accountChangedTemplate", () => {
    it.each([
        [{ kind: "linked", provider: "Google" }, "Google was connected"],
        [
            { kind: "unlinked", provider: "Facebook" },
            "Facebook was disconnected",
        ],
        [{ kind: "password_set" }, "A password was set"],
    ] as const)("describes %j", (change, subject) => {
        const mail = accountChangedTemplate(change, "a@example.com", settings);
        expect(mail.subject).toContain(subject);
        expect(mail.text).toContain("a@example.com");
        expect(mail.text).toContain(settings);
        expect(mail.text).toContain("If this wasn't you");
        expect(mail.html).toContain(`href="${settings}"`);
    });

    it("says other devices were signed out only when they were", () => {
        const linked = accountChangedTemplate(
            { kind: "linked", provider: "Google" },
            "a@example.com",
            settings,
        );
        expect(linked.text).not.toContain("signed out");
        const unlinked = accountChangedTemplate(
            { kind: "unlinked", provider: "Google" },
            "a@example.com",
            settings,
        );
        expect(unlinked.text).toContain("other devices were signed out");
    });

    it("escapes the address in the HTML", () => {
        const mail = accountChangedTemplate(
            { kind: "password_set" },
            '<img src=x onerror="alert(1)">@example.com',
            settings,
        );
        expect(mail.html).not.toContain("<img");
        expect(mail.html).toContain("&#60;img");
    });
});

describe("setPasswordTemplate", () => {
    it("links to the reset page and escapes the address", () => {
        const link =
            "https://pulseboard.example/reset-password?purpose=set&token=abc";
        const mail = setPasswordTemplate(link, "<b>@example.com", []);
        expect(mail.subject).toBe("Set a password for PulseBoard");
        expect(mail.text).toContain(link);
        expect(mail.html).toContain(">set password</a>");
        expect(mail.html).toContain("&#38;token=abc");
        expect(mail.html).not.toContain("<b>@");
    });

    it("names the logins already connected", () => {
        const mail = setPasswordTemplate(
            "https://x.example/l",
            "a@example.com",
            ["Facebook (<i>@example.com)"],
        );
        expect(mail.text).toContain(
            "It can already be logged in to with: Facebook (<i>@example.com).",
        );
        expect(mail.html).toContain("Facebook (&#60;i&#62;@example.com)");
        expect(
            setPasswordTemplate("https://x.example/l", "a@example.com", [])
                .text,
        ).not.toContain("already be logged in");
    });
});

describe("claimAccountTemplate", () => {
    const link =
        "https://pulseboard.example/reset-password?purpose=set&token=abc#email=a%40example.com";

    it("explains what happened and links to choosing a password", () => {
        const mail = claimAccountTemplate(link, "a@example.com");
        expect(mail.subject).toBe("Choose a password for PulseBoard");
        expect(mail.text).toContain(
            "didn't create the PulseBoard account for a@example.com",
        );
        expect(mail.text).toContain("signed out");
        expect(mail.text).toContain(link);
        expect(mail.text).toContain("Forgot password?");
        expect(mail.html).toContain(`href="${escapeHtml(link)}"`);
    });

    it("escapes the address in the HTML", () => {
        const mail = claimAccountTemplate(link, "<b>@example.com");
        expect(mail.html).not.toContain("<b>@example.com");
        expect(mail.html).toContain("&#60;b&#62;@example.com");
    });
});
