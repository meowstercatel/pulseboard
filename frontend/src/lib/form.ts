type Field = HTMLElement & { value: string };

export function bindForm(
    form: HTMLFormElement,
    onSubmit: (field: (name: string) => string) => Promise<string | null>,
) {
    const button = form.querySelector("cds-button") as HTMLElement & {
        disabled: boolean;
    };
    const error = form.querySelector(
        "cds-inline-notification",
    ) as HTMLElement & {
        subtitle: string;
    };
    const field = (name: string) =>
        (form.querySelector(`[name="${name}"]`) as Field | null)?.value ?? "";

    let busy = false;
    const submit = async () => {
        if (busy) return;
        busy = true;
        button.disabled = true;
        error.hidden = true;

        const message = await onSubmit(field);

        busy = false;
        button.disabled = false;
        if (message) {
            error.subtitle = message;
            error.hidden = false;
        }
    };

    form.addEventListener("submit", (e) => e.preventDefault());
    button.addEventListener("click", submit);
    form.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
    });
}
