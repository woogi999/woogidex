// ==================== confirm dialog ====================
// The site's own "Are you sure?" box, in place of the browser's confirm():
// that one can't be styled, reads like a system warning, and some browsers
// let a page suppress it. This one is a promise, so callers read the same:
//
//     if (!await confirmDialog({ title: 'Delete this Fakemon?' })) return;
//
// The box itself is js/app/dialogs/confirm.tsx.

import { openDialog } from '../app/dialogs.tsx';

let settle: any = null;       // resolves the open question's promise

function answer(yes) {
    const done = settle;
    settle = null;
    done?.(yes);
}

/**
 * Asks a yes/no question in the site's own modal.
 * @param {{title?: string, message?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean}} opts
 *   danger (the default) paints the confirm button red, for anything that deletes or can't be undone.
 * @returns true when confirmed
 */
export function confirmDialog({ title = '', message = '', confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true }: { title?: any; message?: any; confirmLabel?: any; cancelLabel?: any; danger?: any } = {}): Promise<boolean> {
    if (settle) answer(false);          // a second question replaces the first
    const asked = new Promise<boolean>(resolve => { settle = resolve; });
    openDialog('confirm', { title: title || 'Are you sure?', message, confirmLabel, cancelLabel, danger, answer });
    return asked;
}
