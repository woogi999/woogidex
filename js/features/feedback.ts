// ==================== feedback & bug reports ====================
// The account menu's "Feedback & bug reports" dialog. Sending needs an
// account: reports go in public.feedback as the signed-in user (RLS), which
// is also what lets "My reports" show the status and staff reply for each one.
// Staff read and answer them in the Feedback tab of admin.html
// (js/admin/FeedbackTab.tsx). The dialog is js/app/dialogs/feedback.tsx.

import { state, api } from '../core/app.ts';
import { log } from '../core/log.ts';
import { getClient } from '../core/supabase.ts';
import { closeDialog, openDialog } from '../app/dialogs.tsx';

export const KINDS = [
    { key: 'bug', label: 'Bug', icon: 'bug', hint: 'Something is broken or doesn’t work the way it should.' },
    { key: 'feedback', label: 'Feedback', icon: 'message-square', hint: 'Tell us what you think of something on the site.' },
    { key: 'idea', label: 'Idea', icon: 'lightbulb', hint: 'Something you’d like Woogidex to have or do.' }
];
export const STATUS = {
    open: 'Open', in_progress: 'In progress', resolved: 'Resolved', wont_fix: 'Won’t fix', duplicate: 'Duplicate'
};
export const TITLE_MAX = 120;
export const BODY_MAX = 4000;

/** Opens the dialog; signed-out visitors are asked to sign in first. */
export function openFeedbackModal(which = 'send') {
    openDialog('feedback', { tab: which === 'mine' ? 'mine' : 'send' });
}

export function closeFeedbackModal() {
    closeDialog('feedback');
}

/** Where the reporter is, in words a developer can find: the path plus the open view. */
function currentPlace() {
    const view = document.body.dataset.page || '';
    const editor = document.getElementById('editor-view')?.style.display === 'block' ? ' (editor open)' : '';
    return `${window.location.pathname}${view ? ` · ${view}` : ''}${editor}`.slice(0, 300);
}

/**
 * Sends a report as the signed-in user.
 * @param {{ kind: string, title: string, body: string, withContext: boolean }} report
 * @returns a problem to show, or '' once sent
 */
export async function sendFeedback({ kind, title, body, withContext }: { kind?: any; title?: any; body?: any; withContext?: any }): Promise<string> {
    if (!state.user) return 'Sign in first.';
    title = String(title || '').trim();
    body = String(body || '').trim();
    if (title.length < 3) return 'Give it a title of at least 3 characters.';
    if (body.length < 10) return 'Add a few more details (at least 10 characters).';
    try {
        const client = await getClient();
        const { error } = await client.from('feedback').insert({
            user_id: state.user.id,
            kind: KINDS.some(k => k.key === kind) ? kind : 'feedback',
            title: title.slice(0, TITLE_MAX),
            body: body.slice(0, BODY_MAX),
            page: withContext ? currentPlace() : '',
            user_agent: withContext ? navigator.userAgent.slice(0, 400) : ''
        });
        if (error) throw error;
        log.info('FEEDBACK', 'Report sent', { kind });
        api.showToast?.('Thanks! Your report was sent. You can follow it under My reports.', 'success');
        return '';
    } catch (e: any) {
        log.warn('FEEDBACK', 'Report failed', e);
        return e?.message || 'Your report could not be sent. Please try again.';
    }
}

/**
 * Your own reports, newest first, with their status and any staff reply.
 */
export async function loadMyFeedback(): Promise<{ rows: Array<{ id: string, kind: string, title: string, body: string, status: string, staff_note: string | null, created_at: string }>, error: string }> {
    if (!state.user) return { rows: [] as any[], error: 'Sign in first.' };
    const client = await getClient();
    const { data, error } = await client.from('feedback')
        .select('id, kind, title, body, status, staff_note, created_at, updated_at')
        .eq('user_id', state.user.id)
        .order('created_at', { ascending: false })
        .limit(50);
    return { rows: data || [], error: error ? error.message : '' };
}
