// Account deletion (client half of the account_deletion migration, which owns
// the actual scheduling/grace-period logic).
//
//   * Settings -> Account offers "Delete Account", scheduling it.
//   * The row becomes "Cancel Deletion" during the grace week, with a
//     once-per-session sign-in notice -- an account must never be quietly
//     destroyed under someone actively using it.
//   * Every boot sweeps and destroys past-due accounts (no server cron here).

import { log } from '../core/log.ts';
import { state, api } from '../core/app.ts';
import { getClient } from './auth.ts';
import { queueAutoModal } from '../core/modal-queue.ts';
import { notify } from '../app/store.ts';
import { closeDialog, openDialog } from '../app/dialogs.tsx';

// mirrors the DB's account_deletion_grace() -- the DB is authoritative, this is just for display text; keep in sync
export const ACCOUNT_DELETION_GRACE_DAYS = 7;

const ANNOUNCED_KEY = 'woogidex.accountDeletion.announced';

/**
 * When the signed-in account is due to be destroyed.
 * @returns null when no deletion is scheduled
 */
export function accountDeletionDueAt(): Date|null {
    const requested = state.user?.deletionRequestedAt;
    if (!requested) return null;
    const due = new Date(requested);
    if (Number.isNaN(due.getTime())) return null;
    due.setDate(due.getDate() + ACCOUNT_DELETION_GRACE_DAYS);
    return due;
}

export function formatDue(date) {
    try {
        return date.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
    } catch {
        return date.toISOString().slice(0, 10);
    }
}

/**
 * Destroys accounts past their deletion date. Fire-and-forget per boot;
 * failures are logged and ignored since the loading visitor isn't the person to tell.
 */
export async function sweepExpiredAccountDeletions(): Promise<void> {
    try {
        const client = await getClient();
        const { data, error } = await client.rpc('purge_expired_account_deletions');
        if (error) throw error;
        if (data) log.info('ACCOUNT', 'Purged accounts past their deletion date', { count: data });
    } catch (err: any) {
        log.warn('ACCOUNT', 'Could not run the account deletion sweep', err);
    }
}

// ---- the settings row -------------------------------------------------------

/** The Settings row (js/app/pages/SettingsPage.tsx) reads the state above; this re-renders it. */
export function updateAccountDeletionUI() {
    notify();
}

// ---- scheduling and cancelling ----------------------------------------------

export function openDeleteAccountModal() {
    openDialog('delete-account', { when: formatDue(new Date(Date.now() + ACCOUNT_DELETION_GRACE_DAYS * 86400000)) });
}

export function closeDeleteAccountModal() {
    closeDialog('delete-account');
}

/**
 * Schedules the signed-in account for deletion; account keeps working during the grace period.
 * @returns a problem to show, or '' once it's scheduled
 */
export async function confirmDeleteAccount(): Promise<string> {
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
        return '';
    } catch (err: any) {
        log.error('ACCOUNT', 'Could not schedule account deletion', err);
        return err?.message || 'Could not schedule the deletion. Please try again.';
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
    } catch (err: any) {
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
    queueAutoModal(() => openDialog('account-deletion-notice', { when: formatDue(due) }));
}

export function closeAccountDeletionNotice() {
    closeDialog('account-deletion-notice');
}
