// Several boot-time modules independently decide whether to show a modal
// (account deletion, recovery, site notice, updates), with nothing to
// serialize those decisions - two could open at once and visually collide.
// This is the single door they all go through: a caller hands over a
// function that decides for itself whether to show something, and the queue
// just waits for any open .modal-overlay to close before running the next.
// Polling rather than a MutationObserver since these fire only once or twice
// per session.

const queue = [];
let waiting = false;

function anyModalOpen() {
    return !!document.querySelector('.modal-overlay.active');
}

/**
 * Runs `openFn` once the screen is free of any other `.modal-overlay`, and
 * holds every later call until whatever it opened (if anything) has closed.
 * @param {() => void} openFn decides for itself whether to open a modal
 */
export function queueAutoModal(openFn) {
    queue.push(openFn);
    pump();
}

function pump() {
    if (waiting) return;
    // drains in one tick until a caller actually opens something
    while (queue.length && !anyModalOpen()) {
        const openFn = queue.shift();
        try { openFn(); } catch (e) { console.error('[MODAL-QUEUE] auto-open failed', e); }
    }
    if (queue.length) waitForClose();
}

function waitForClose(attempt = 0) {
    waiting = true;
    if (!anyModalOpen()) { waiting = false; pump(); return; }
    // dialog open this long is probably in active use, not stuck; give up
    // rather than popping a stale notice in minutes later
    if (attempt > 400) { waiting = false; queue.length = 0; return; }
    setTimeout(() => waitForClose(attempt + 1), 500);
}
