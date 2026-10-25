// Calls load() once, when el comes within rootMargin of the viewport
export function whenVisible(
    el: Element,
    load: () => void,
    rootMargin = "200px",
) {
    const observer = new IntersectionObserver(
        (entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            observer.disconnect();
            load();
        },
        { rootMargin },
    );
    observer.observe(el);
}
