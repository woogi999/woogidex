// Account deletion (client half of the account_deletion migration, which owns
// the actual scheduling/grace-period logic).
//
//   * Settings -> Account offers "Delete Account", scheduling it.
//   * The row becomes "Cancel Deletion" during the grace week, with a
//     once-per-session sign-in notice -- an account must never be quietly
//     destroyed under someone actively using it.
//   * Every boot sweeps and destroys past-due accounts (no server cron here).

import { log } from '../core/log.js';
import { state, api } from '../core/app.js';
import { getClient } from './auth.js';
import { queueAutoModal } from '../core/modal-queue.js';

// mirrors the DB's account_deletion_grace() -- the DB is authoritative, this is just for display text; keep in sync
export const ACCOUNT_DELETION_GRACE_DAYS = 7;

const ANNOUNCED_KEY = 'woogidex.accountDeletion.announced';

/**
 * When the signed-in account is due to be destroyed.
 * @returns {Date|null} null when no deletion is scheduled
 */
export function accountDeletionDueAt() {
    const requested = state.user?.deletionRequestedAt;
    if (!requested) return null;
    const due = new Date(requested);
    if (Number.isNaN(due.getTime())) return null;
    due.setDate(due.getDate() + ACCOUNT_DELETION_GRACE_DAYS);
    return due;
}

function formatDue(date) {
    try {
        return date.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
    } catch {
        return date.toISOString().slice(0, 10);
    }
}

/**
 * Destroys accounts past their deletion date. Fire-and-forget per boot;
 * failures are logged and ignored since the loading visitor isn't the person to tell.
 * @returns {Promise<void>}
 */
export async function sweepExpiredAccountDeletions() {
    try {
        const client = await getClient();
        const { data, error } = await client.rpc('purge_expired_account_deletions');
        if (error) throw error;
        if (data) log.info('ACCOUNT', 'Purged accounts past their deletion date', { count: data });
    } catch (err) {
        log.warn('ACCOUNT', 'Could not run the account deletion sweep', err);
    }
}

// ---- the settings row -------------------------------------------------------

/** Shows the Account group when signed in; toggles delete/cancel based on pending state. */
export function updateAccountDeletionUI() {
    const group = document.getElementById('settings-account-group');
    const desc = document.getElementById('settings-delete-account-desc');
    const btn = document.getElementById('settings-delete-account-btn');
    if (!group || !desc || !btn) return;

    if (!state.user) { group.style.display = 'none'; return; }
    group.style.display = '';

    const due = accountDeletionDueAt();
    if (due) {
        desc.textContent = `This account is scheduled for permanent deletion on ${formatDue(due)}. Cancel any time before then and nothing is lost.`;
        btn.textContent = 'Cancel Deletion';
        btn.className = 'btn btn-secondary btn-sm';
        btn.onclick = cancelAccountDeletion;
    } else {
        desc.textContent = `Permanently delete your account and everything on it. Nothing is destroyed for ${ACCOUNT_DELETION_GRACE_DAYS} days, so you can change your mind.`;
        btn.textContent = 'Delete Account';
        btn.className = 'btn btn-danger btn-sm';
        btn.onclick = openDeleteAccountModal;
    }
}

// ---- scheduling and cancelling ----------------------------------------------

export function openDeleteAccountModal() {
    const modal = document.getElementById('delete-account-modal');
    if (!modal) return;
    const box = document.getElementById('delete-account-checkbox');
    if (box) box.checked = false; // some browsers restore checkbox state across reloads
    document.getElementById('delete-account-error').textContent = '';
    document.getElementById('delete-account-when').textContent = formatDue(
        new Date(Date.now() + ACCOUNT_DELETION_GRACE_DAYS * 86400000));
    modal.classList.add('active');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

export function closeDeleteAccountModal() {
    document.getElementById('delete-account-modal')?.classList.remove('active');
}

/** Schedules the signed-in account for deletion; account keeps working during the grace period. */
export async function confirmDeleteAccount() {
    const errorEl = document.getElementById('delete-account-error');
    const btn = document.getElementById('delete-account-confirm-btn');
    if (!document.getElementById('delete-account-checkbox')?.checked) {
        errorEl.textContent = 'Please confirm that you understand what happens next.';
        return;
    }
    if (btn) btn.disabled = true;
    try {
        const client = await getClient();
        const { data, error } = await client.rpc('request_account_deletion');
        if (error) throw error;
        // sync local state to the RPC's returned due date, avoiding a refetch
        if (state.user) {
            state.user.deletionRequestedAt = new Date(
                new Date(data).getTime() - ACCOUNT_DELETION_GRACE_DAYS * 86400000).toISOString();
        }
        log.info('ACCOUNT', 'Account deletion scheduled', { due: data });
        closeDeleteAccountModal();
        updateAccountDeletionUI();
        api.showToast?.(`Your account will be deleted on ${formatDue(new Date(data))}. You can cancel until then.`, 'warning');
    } catch (err) {
        log.error('ACCOUNT', 'Could not schedule account deletion', err);
        errorEl.textContent = err?.message || 'Could not schedule the deletion. Please try again.';
    } finally {
        if (btn) btn.disabled = false;
    }
}

/** Calls off a pending deletion. Safe to call when nothing is pending. */
export async function cancelAccountDeletion() {
    try {
        const client = await getClient();
        const { error } = await client.rpc('cancel_account_deletion');
        if (error) throw error;
        if (state.user) state.user.deletionRequestedAt = null;
        log.info('ACCOUNT', 'Account deletion cancelled');
        closeAccountDeletionNotice();
        updateAccountDeletionUI();
        api.showToast?.('Your account is no longer scheduled for deletion.', 'success');
    } catch (err) {
        log.error('ACCOUNT', 'Could not cancel account deletion', err);
        api.showToast?.('Could not cancel the deletion. Please try again.', 'error');
    }
}

// ---- the sign-in notice -----------------------------------------------------

/** Once per session, warns a signed-in user their account is scheduled for deletion. */
export function maybeAnnouncePendingDeletion() {
    const due = accountDeletionDueAt();
    if (!due) return;
    try {
        if (sessionStorage.getItem(ANNOUNCED_KEY) === state.user?.id) return;
        sessionStorage.setItem(ANNOUNCED_KEY, state.user?.id || '1');
    } catch { /* private mode: announce every time rather than not at all */ }

    // queued so it doesn't always win the race to be the first auto-modal shown at boot
    queueAutoModal(() => {
        const modal = document.getElementById('account-deletion-notice-modal');
        const when = document.getElementById('account-deletion-notice-when');
        if (!modal || !when) return;
        when.textContent = formatDue(due);
        modal.classList.add('active');
        if (typeof lucide !== 'undefined') lucide.createIcons();
    });
}

export function closeAccountDeletionNotice() {
    document.getElementById('account-deletion-notice-modal')?.classList.remove('active');
}
