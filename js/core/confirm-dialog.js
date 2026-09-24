// ==================== confirm dialog ====================
// The site's own "Are you sure?" box, in place of the browser's confirm():
// that one can't be styled, reads like a system warning, and some browsers
// let a page suppress it. This one is a promise, so callers read the same:
//
//     if (!await confirmDialog({ title: 'Delete this Fakemon?' })) return;
//
// It builds its markup on first use, so no view file has to carry it.

let root = null;
let settle = null;       // resolves the open dialog's promise
let lastFocus = null;

function build() {
    root = document.createElement('div');
    root.className = 'modal-overlay confirm-dialog-overlay';
    root.id = 'confirm-dialog';
    root.innerHTML = `
        <div class="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message">
            <div class="confirm-dialog-icon" aria-hidden="true"></div>
            <h3 id="confirm-dialog-title"></h3>
            <p id="confirm-dialog-message"></p>
            <div class="confirm-dialog-actions">
                <button type="button" class="btn btn-secondary" data-answer="no"></button>
                <button type="button" class="btn" data-answer="yes"></button>
            </div>
        </div>`;
    root.addEventListener('click', e => {
        if (e.target === root) answer(false);
        const btn = e.target.closest('[data-answer]');
        if (btn) answer(btn.dataset.answer === 'yes');
    });
    root.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); answer(false); }
        // keep Tab inside the two buttons
        if (e.key === 'Tab') {
            const buttons = [...root.querySelectorAll('[data-answer]')];
            const i = buttons.indexOf(document.activeElement);
            e.preventDefault();
            buttons[(i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
        }
    });
    document.body.appendChild(root);
}

function answer(yes) {
    if (!root || !settle) return;
    root.classList.remove('active');
    const done = settle;
    settle = null;
    lastFocus?.focus?.();
    done(yes);
}

const ICONS = {
    danger: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M16.5 4.48v.23c.97.09 1.94.2 2.9.34a.75.75 0 1 1-.22 1.48l-.2-.03-1 13A3 3 0 0 1 15 22.25H9a3 3 0 0 1-2.99-2.75l-1-13-.2.03a.75.75 0 1 1-.22-1.48c.96-.14 1.93-.25 2.9-.34v-.23c0-1.56 1.21-2.9 2.8-2.95a52 52 0 0 1 3.42 0c1.59.05 2.79 1.39 2.79 2.95Z"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M2.25 12a9.75 9.75 0 1 1 19.5 0 9.75 9.75 0 0 1-19.5 0Zm8.7-3.75a1.05 1.05 0 1 1 2.1 0 1.05 1.05 0 0 1-2.1 0ZM12 10.5a.75.75 0 0 1 .75.75v5.25a.75.75 0 0 1-1.5 0v-5.25A.75.75 0 0 1 12 10.5Z" clip-rule="evenodd"/></svg>'
};

/**
 * Asks a yes/no question in the site's own modal.
 * @param {{title: string, message?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean}} opts
 *   danger (the default) paints the confirm button red, for anything that deletes or can't be undone.
 * @returns {Promise<boolean>} true when confirmed
 */
export function confirmDialog({ title, message = '', confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true } = {}) {
    if (!root) build();
    if (settle) answer(false);          // a second question replaces the first
    root.querySelector('#confirm-dialog-title').textContent = title || 'Are you sure?';
    const msg = root.querySelector('#confirm-dialog-message');
    msg.textContent = message;
    msg.hidden = !message;
    root.querySelector('.confirm-dialog-icon').innerHTML = danger ? ICONS.danger : ICONS.info;
    root.querySelector('.confirm-dialog').classList.toggle('is-danger', danger);
    const no = root.querySelector('[data-answer="no"]');
    const yes = root.querySelector('[data-answer="yes"]');
    no.textContent = cancelLabel;
    yes.textContent = confirmLabel;
    yes.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    lastFocus = document.activeElement;
    root.classList.add('active');
    // the safe answer has focus, so a stray Enter doesn't delete anything
    setTimeout(() => no.focus(), 0);
    return new Promise(resolve => { settle = resolve; });
}
