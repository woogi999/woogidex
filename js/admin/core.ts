// ==================== the staff panel: shared state ====================
// Deliberately standalone: doesn't import app.ts/auth.ts/community.ts, which
// assume the main site's page. Keeps its own Supabase session and sign-in.
//
// Security note: checks here are UX only. The real gate is Postgres RLS plus
// the admin_* SECURITY DEFINER RPCs (see BADGES_UNIFIED_SETUP.sql), which
// re-verify staff status and rank server-side regardless of this code.
//
// Model: roles and badges are merged. A "badge" (badges table) carries
// label/icon/color/description/rank/permissions; a user can hold several
// (profile_badges). Effective perms = union of held badges; effective rank
// = max rank among them. No separate role dropdown - badges ARE the role.

import type { ReactNode } from 'react';
import { getClient } from '../core/supabase.ts';
import { publicName } from '../core/html.ts';
import { notify } from '../app/store.ts';
import { openDialog } from '../app/dialogs.tsx';

export { getClient, notify };

// Every capability a badge can carry, in editor order; keys match the can_*
// columns on `badges` and the names public.has_perm() answers to.
export const PERMISSIONS: Array<[string, string, string]> = [
    ['delete_content', 'Delete content', 'Remove any comment or published Fakemon'],
    ['purge_content', 'Bulk purge', 'Mass-delete a user\'s comments or Fakemon'],
    ['warn', 'Warn', 'Issue warnings (counts toward auto-escalation)'],
    ['mute', 'Mute', 'Stop an account posting, temporarily or until lifted'],
    ['ban', 'Suspend', 'Suspend an account at the auth layer'],
    ['delete_users', 'Delete accounts', 'Permanently erase an account and everything it posted'],
    ['manage_filter', 'Content filter', 'Add, edit and disable auto-moderator rules'],
    ['view_ips', 'View addresses', 'See sign-in / registration IPs and locations'],
    ['view_log', 'Moderation log', 'Read the full moderation history'],
    ['manage_events', 'Events', 'Create and run events and contests'],
    ['manage_badges', 'Badges', 'Create badges and assign them to users'],
    ['manage_limits', 'Limits', 'Set the site-wide quotas and the per-badge overrides'],
    ['manage_feedback', 'Feedback', 'Read and answer feedback and bug reports']
];

export interface Badge {
    key: string; label: string; icon: string; color: string; description?: string | null; rank: number;
    icon_image?: string | null; can_auto_backup?: boolean;
    limit_cloud_items?: number | null; limit_community_uploads?: number | null;
    limit_publish_cooldown_seconds?: number | null; limit_cloud_regions?: number | null;
    [perm: string]: unknown;
}
export interface Me { id: string; name: string; badgeKeys: string[]; rank: number; perms: Record<string, any>; }
export type Gate = 'loading' | 'signedOut' | 'forbidden' | 'ok';

export const admin = {
    gate: 'loading' as Gate,
    me: null as Me | null,
    badges: [] as Badge[]
};

/** May the signed-in staff member do this? (UX only; the RPCs decide.) */
export function can(perm: string): boolean {
    return !!admin.me?.perms?.[perm];
}

export function badgesByKey(): Record<string, Badge> {
    return Object.fromEntries(admin.badges.map(b => [b.key, b]));
}

export async function loadBadges(): Promise<void> {
    const client = await getClient();
    const { data, error } = await client.from('badges').select('*').order('rank', { ascending: false });
    if (error) { showToast('Could not load badges: ' + error.message, 'error'); return; }
    admin.badges = data || [];
    notify();
}

// ==================== refreshes across tabs ====================
// An action in one tab can change what another shows (a mute lands in the mod
// log); each list reloads when its counter moves.
export const reloads = { users: 0, log: 0, comments: 0, contests: 0 };
export function reload(which: keyof typeof reloads): void {
    reloads[which]++;
    notify();
}

// ==================== sign in / out ====================
// mirrors js/features/auth.ts's signIn (duplicated since this page stays standalone).
export async function signIn(identifier: string, password: string): Promise<void> {
    const client = await getClient();
    const trimmed = identifier.trim();
    if (trimmed.includes('@')) {
        const { error } = await client.auth.signInWithPassword({ email: trimmed, password });
        if (error) throw new Error('Invalid username or password.');
    } else {
        const { data: result, error: fnError } = await client.functions.invoke('login-with-identifier', { body: { identifier: trimmed, password } });
        if (fnError || !result?.ok || !result?.session) throw new Error(result?.error || 'Invalid username or password.');
        const { error: setError } = await client.auth.setSession({
            access_token: result.session.access_token,
            refresh_token: result.session.refresh_token
        });
        if (setError) throw new Error('Invalid username or password.');
    }
    await initAdmin();
}

export async function signOut(): Promise<void> {
    const client = await getClient();
    await client.auth.signOut();
    admin.me = null;
    admin.gate = 'signedOut';
    notify();
}

/** Works out who is here and what they may see. */
export async function initAdmin(): Promise<void> {
    const client = await getClient();
    const { data: { session } } = await client.auth.getSession();
    if (!session?.user) { admin.gate = 'signedOut'; notify(); return; }

    await loadBadges();
    const { data: myProfile } = await client.from('profiles').select('username, display_name').eq('id', session.user.id).maybeSingle();
    const { data: myBadgeRows } = await client.from('profile_badges').select('badge_key').eq('user_id', session.user.id);

    // Perms come from the server, not the badge rows read above, so the panel
    // can't disagree with the RPCs about what this account may do.
    const { data: perms } = await client.rpc('my_permissions');
    if (!perms?.staff) { admin.gate = 'forbidden'; notify(); return; }

    admin.me = {
        id: session.user.id,
        name: publicName(myProfile),
        badgeKeys: (myBadgeRows || []).map((r: { badge_key: string }) => r.badge_key),
        rank: perms.rank || 0,
        perms
    };
    admin.gate = 'ok';
    notify();
}

// ==================== dark mode ====================
// shares the main site's localStorage key so the preference carries over between pages.
export function isDark(): boolean {
    return document.documentElement.getAttribute('data-theme') === 'dark';
}
export function loadDarkMode(): void {
    if (localStorage.getItem('woogidex-dark-mode') === 'true') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
}
export function toggleDarkMode(): void {
    const dark = !isDark();
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('woogidex-dark-mode', String(dark));
    notify();
}

// ==================== toast ====================
export const toast = { message: '', kind: 'info', seq: 0 };
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(message: string, kind: 'info' | 'success' | 'error' | 'warning' = 'info'): void {
    toast.message = message;
    toast.kind = kind;
    toast.seq++;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.message = ''; notify(); }, 3500);
    notify();
}

// ==================== the reason / confirm dialog ====================
// One promise-based dialog stands in for prompt() and confirm() everywhere:
// browsers can suppress those and return null silently, which looked like
// "the delete button does nothing".
export interface AskOptions {
    title: string;
    blurb: ReactNode;
    confirm?: string;
    durations?: Array<[number, string]> | null;
    danger?: boolean;
    requireReason?: boolean;
    /** what the red warning says when danger is set */
    dangerText?: string;
}
export type AskAnswer = { reason: string; amount: number | null } | null;

export function ask(options: AskOptions): Promise<AskAnswer> {
    return new Promise(resolve => openDialog('admin-ask', { ...options, resolve }));
}

// ==================== formatting ====================
export function fmtDate(iso?: string | null): string {
    if (!iso) return '-';
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
    let t: ReturnType<typeof setTimeout> | undefined;
    return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
