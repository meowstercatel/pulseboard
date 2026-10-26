// Runs `task` now and then every `intervalMs`, never two runs at once; a
// failed run is logged and the next one goes ahead. The returned stop function
// waits for a run in progress, so the database can be closed right after it.
export function startPeriodic(
    name: string,
    intervalMs: number,
    task: () => Promise<void>,
): () => Promise<void> {
    let running: Promise<void> | undefined;
    const run = () => {
        if (running) return;
        running = task()
            .catch((err) => console.error(`${name} failed`, err))
            .finally(() => (running = undefined));
    };
    run();
    const timer = setInterval(run, intervalMs).unref();
    return async () => {
        clearInterval(timer);
        await running;
    };
}
