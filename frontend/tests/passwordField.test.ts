import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearField, mountPasswordFields } from "../src/lib/passwordField";
import { passwordStrength } from "../src/lib/passwordStrength";

describe("passwordStrength", () => {
    it("follows the backend's 8–256 character limit", () => {
        expect(passwordStrength("")).toEqual({ score: 0, label: "" });
        expect(passwordStrength("Ab1!xyz")).toEqual({
            score: 0,
            label: "Too short",
        });
        expect(passwordStrength("x".repeat(257)).label).toBe("Too long");
        expect(passwordStrength("mbvtrqwz").score).toBeGreaterThan(0);
    });

    it("rates longer and more varied passwords higher", () => {
        expect(passwordStrength("mbvtrqwz").label).toBe("Weak");
        expect(passwordStrength("mbvtrqwzlkpd").label).toBe("Fair");
        expect(passwordStrength("Mbvtrqwz-lkp").label).toBe("Good");
        expect(passwordStrength("Correct horse battery staple!").label).toBe(
            "Strong",
        );
    });

    it("keeps repeated and well-known passwords weak", () => {
        expect(passwordStrength("aaaaaaaaaaaaaaaaaaaa").label).toBe("Weak");
        expect(passwordStrength("Password1234567!").label).toBe("Weak");
        expect(passwordStrength("Qwerty-is-my-pass-9").label).toBe("Weak");
    });
});

describe("mountPasswordFields", () => {
    let window: Window;
    let doc: Document;

    beforeEach(() => {
        window = new Window({ url: "http://localhost/register" });
        doc = window.document as unknown as Document;
        vi.stubGlobal("document", doc);
        vi.stubGlobal("Event", window.Event);
        doc.body.innerHTML = `
            <form>
                <div class="field">
                    <input id="pw" type="password" />
                    <button type="button" data-password-toggle aria-controls="pw" aria-label="Show password">
                        <svg></svg><svg hidden></svg>
                    </button>
                    <div data-strength-for="pw"><p class="strength-label"></p></div>
                </div>
            </form>`;
        mountPasswordFields(doc);
    });
    afterEach(async () => {
        vi.unstubAllGlobals();
        await window.happyDOM.close();
    });

    const input = () => doc.getElementById("pw") as HTMLInputElement;
    const toggle = () =>
        doc.querySelector<HTMLButtonElement>("[data-password-toggle]")!;
    const meter = () => doc.querySelector<HTMLElement>("[data-strength-for]")!;
    const type = (value: string) => {
        input().value = value;
        input().dispatchEvent(new Event("input"));
    };

    it("shows and hides the password without changing it", () => {
        type("Correct horse");
        toggle().click();
        expect(input().type).toBe("text");
        expect(toggle().getAttribute("aria-label")).toBe("Hide password");
        const [show, hide] = toggle().querySelectorAll("svg");
        expect(show!.hasAttribute("hidden")).toBe(true);
        expect(hide!.hasAttribute("hidden")).toBe(false);
        toggle().click();
        expect(input().type).toBe("password");
        expect(toggle().getAttribute("aria-label")).toBe("Show password");
        expect(input().value).toBe("Correct horse");
    });

    it("rates the password as it is typed", () => {
        expect(meter().dataset.score).toBe("0");
        expect(meter().textContent!.trim()).toBe("");
        type("short");
        expect(meter().textContent!.trim()).toBe("Strength: Too short");
        type("Correct horse battery staple!");
        expect(meter().dataset.score).toBe("4");
        expect(meter().textContent!.trim()).toBe("Strength: Strong");
    });

    it("clears a revealed password, hides it again and resets the meter", () => {
        const onInput = vi.fn();
        doc.querySelector("form")!.addEventListener("input", onInput);
        type("Correct horse battery staple!");
        toggle().click();
        onInput.mockClear();

        clearField(input());

        expect(input().value).toBe("");
        expect(input().type).toBe("password");
        expect(meter().dataset.score).toBe("0");
        // pages clear their "saved" message on input, so none is sent
        expect(onInput).not.toHaveBeenCalled();
    });
});
