// Site transfer notice: warns users before a domain move, since IndexedDB is
// scoped per-origin and nothing carries over automatically to a new domain.

import { queueAutoModal } from '../core/modal-queue.js';

const DISMISSED_KEY = 'woogidex.siteTransferNotice.dismissed.v1';

/** Shows the transfer notice unless dismissed before; queued so it doesn't stack with other auto-modals. */
export function maybeShowSiteTransferNotice() {
    try { if (localStorage.getItem(DISMISSED_KEY) === 'true') return; } catch { /* private mode */ }
    queueAutoModal(showSiteTransferNoticeNow);
}

function showSiteTransferNoticeNow() {
    const modal = document.getElementById('site-transfer-modal');
    if (!modal) return;
    // some browsers restore checkbox state across reloads -- force unchecked on open
    const neverShowBox = document.getElementById('site-transfer-never-show');
    if (neverShowBox) neverShowBox.checked = false;
    modal.classList.add('active');
    document.body.classList.add('modal-open');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

export function closeSiteTransferNotice() {
    const neverShow = document.getElementById('site-transfer-never-show')?.checked;
    if (neverShow) {
        try { localStorage.setItem(DISMISSED_KEY, 'true'); } catch { /* private mode */ }
    }
    document.getElementById('site-transfer-modal')?.classList.remove('active');
    document.body.classList.remove('modal-open');
}
