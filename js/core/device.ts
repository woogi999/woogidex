// What this device can comfortably do. Cheap phones and old laptops get the
// same site with the costly extras toned down: no backdrop blur, flat sprites
// instead of 3D models, and the multi-megabyte background downloads left until
// something actually needs them.
//
// index.html runs the same test before first paint and sets .low-end on
// <html>; this reads it back so the two can never disagree.

export function isLowEndDevice(): boolean {
    return document.documentElement.classList.contains('low-end');
}

/** The visitor asked their browser to save data (Android "Data Saver" and friends). */
export function prefersSavingData(): boolean {
    return !!(navigator as any).connection?.saveData;
}

/**
 * Runs `fn` once the page has a quiet moment, so background work doesn't
 * compete with the first render and the first taps. `timeout` caps the wait.
 */
export function whenIdle(fn: () => void, timeout = 2000) {
    const ric = (window as any).requestIdleCallback;
    if (ric) ric(fn, { timeout });
    else setTimeout(fn, Math.min(timeout, 300));
}
