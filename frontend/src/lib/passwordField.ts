import { passwordStrength } from "./passwordStrength";

// Wires the show/hide buttons and strength meters rendered by Field.astro.
// Safe to call again: anything already wired is skipped.
export function mountPasswordFields(root: ParentNode = document) {
    for (const toggle of root.querySelectorAll<HTMLButtonElement>(
        "[data-password-toggle]:not([data-mounted])",
    )) {
        toggle.dataset.mounted = "";
        const input = document.getElementById(
            toggle.getAttribute("aria-controls")!,
        ) as HTMLInputElement;
        const [show, hide] = toggle.querySelectorAll("svg");
        toggle.addEventListener("click", () => {
            const visible = input.type === "password";
            input.type = visible ? "text" : "password";
            toggle.setAttribute(
                "aria-label",
                visible ? "Hide password" : "Show password",
            );
            show!.toggleAttribute("hidden", visible);
            hide!.toggleAttribute("hidden", !visible);
        });
    }

    for (const meter of root.querySelectorAll<HTMLElement>(
        "[data-strength-for]:not([data-mounted])",
    )) {
        meter.dataset.mounted = "";
        const input = document.getElementById(
            meter.dataset.strengthFor!,
        ) as HTMLInputElement;
        const label = meter.querySelector<HTMLElement>(".strength-label")!;
        const update = () => {
            const { score, label: text } = passwordStrength(input.value);
            meter.dataset.score = String(score);
            const message = text ? `Strength: ${text}` : "";
            // only on change, so screen readers announce each level once
            if (label.textContent !== message) label.textContent = message;
        };
        input.addEventListener("input", update);
        meter.addEventListener("pulse:refresh", update);
        update();
    }
}

// Empties a field from code, hides a revealed password again and resets the
// meter. No input event, so "saved" messages that clear on input stay.
export function clearField(input: HTMLInputElement) {
    input.value = "";
    const field = input.closest(".field");
    if (input.type === "text") {
        field
            ?.querySelector<HTMLButtonElement>("[data-password-toggle]")
            ?.click();
    }
    field
        ?.querySelector("[data-strength-for]")
        ?.dispatchEvent(new Event("pulse:refresh"));
}
