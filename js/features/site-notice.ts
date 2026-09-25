// Site transfer notice: warns users before a domain move, since IndexedDB is
// scoped per-origin and nothing carries over automatically to a new domain.
// The notice itself is js/app/dialogs/account.tsx.

import { queueAutoModal } from '../core/modal-queue.ts';
import { closeDialog, openDialog } from '../app/dialogs.tsx';

const DISMISSED_KEY = 'woogidex.siteTransferNotice.dismissed.v1';

/** Shows the transfer notice unless dismissed before; queued so it doesn't stack with other auto-modals. */
export function maybeShowSiteTransferNotice() {
    try { if (localStorage.getItem(DISMISSED_KEY) === 'true') return; } catch { /* private mode */ }
    queueAutoModal(() => openDialog('site-transfer', {}));
}

/** The notice's Got it; neverShow: "Don't show this again" was ticked. */
export function closeSiteTransferNotice(neverShow = false) {
    if (neverShow) {
        try { localStorage.setItem(DISMISSED_KEY, 'true'); } catch { /* private mode */ }
    }
    closeDialog('site-transfer');
}
