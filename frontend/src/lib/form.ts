type Field = HTMLElement & { value: string };
type Button = HTMLElement & { disabled: boolean };

// Wires a form whose submit button is a native <button type="submit"> (the
// credential forms, so password managers see a real submission) or a
// <cds-button>. The page stays put: onSubmit does the work and returns an
// error message, or null. Native buttons start out disabled in the HTML, so
// Enter can't post the form natively before this runs; updateButton enables
// them.
export function bindForm(
    form: HTMLFormElement,
    onSubmit: (field: (name: string) => string) => Promise<string | null>,
    canSubmit: () => boolean = () => true,
) {
    const native = form.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
    );
    const button: Button = native ?? form.querySelector<Button>("cds-button")!;
    const error = form.querySelector(
        "cds-inline-notification",
    ) as HTMLElement & {
        subtitle: string;
    };
    const field = (name: string) =>
        (form.querySelector(`[name="${name}"]`) as Field | null)?.value ?? "";

    let busy = false;
    const updateButton = () => {
        button.disabled = busy || !canSubmit();
    };
    const submit = async () => {
        if (busy || !canSubmit()) return;
        busy = true;
        button.disabled = true;
        error.hidden = true;

        let message: string | null;
        try {
            message = await onSubmit(field);
        } catch {
            message = "Something went wrong, please try again";
        }

        busy = false;
        updateButton();
        if (message) {
            error.subtitle = message;
            error.hidden = false;
        }
    };

    // Enter in a native input and the native button both submit the form
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        submit();
    });
    form.addEventListener("input", updateButton);
    form.addEventListener("change", updateButton);
    if (!native) button.addEventListener("click", submit);
    updateButton();
    return updateButton;
}
