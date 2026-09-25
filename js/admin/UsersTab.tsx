// Users: search an account to manage its badges, read everything it posted,
// inspect its sign-in addresses, and act on it. Each control is gated on the
// permission it needs, and nobody can act on an account whose rank matches or
// exceeds their own -- in the UI as a courtesy; every button's RPC re-checks.

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Icon } from '../app/components/Icon.tsx';
import { Modal } from '../app/components/Modal.tsx';
import { openDialog, registerDialog, type DialogProps } from '../app/dialogs.tsx';
import { useStore } from '../app/store.ts';
import { moderationActions } from '../features/moderation-model.ts';
import { admin, ask, badgesByKey, can, debounce, fmtDate, getClient, reload, reloads, showToast } from './core.ts';
import { CommentRows, IpNeighbours, LogRows, SessionsTable, StandingPills, type Comment } from './moderation.tsx';
import { BadgeIcon, ListState } from './ui.tsx';

interface User {
    id: string; username?: string; display_name?: string; email?: string; created_at?: string; last_sign_in_at?: string;
    published_count?: number; rank?: number; banned_until?: string; muted_until?: string; warnings?: number;
    badgeKeys: string[];
}

export function UsersTab() {
    useStore();
    const [query, setQuery] = useState('');
    const [result, setResult] = useState<{ users: User[]; loading: boolean; error: string }>({ users: [], loading: true, error: '' });

    async function search(q = query) {
        setResult(r => ({ ...r, loading: true, error: '' }));
        const client = await getClient();
        // SECURITY DEFINER RPC - only way to get email/account data since auth.users
        // is never client-readable, even for staff.
        const { data: users, error } = await client.rpc('admin_search_users', { search_query: q.trim() });
        if (error) { setResult({ users: [], loading: false, error: 'Search failed: ' + error.message }); return; }
        const ids = (users || []).map((u: User) => u.id);
        const { data: badgeRows } = ids.length ? await client.from('profile_badges').select('user_id, badge_key').in('user_id', ids) : { data: [] };
        const byUser: Record<string, string[]> = {};
        (badgeRows || []).forEach((row: { user_id: string; badge_key: string }) => { (byUser[row.user_id] ||= []).push(row.badge_key); });
        setResult({ users: (users || []).map((u: User) => ({ ...u, badgeKeys: byUser[u.id] || [] })), loading: false, error: '' });
    }

    // first visit, and after anything that changes an account's standing
    useEffect(() => { search(); }, [reloads.users]);

    return (
        <>
            <div className="admin-section-head"><h3>Accounts</h3></div>
            <p className="admin-section-sub">Search an account to manage badges, read everything it has posted, inspect its sign-in addresses, and issue moderation actions. Each control is gated on the specific badge permission it needs, and nobody can act on an account whose rank matches or exceeds their own.</p>
            <form className="admin-search-bar" onSubmit={e => { e.preventDefault(); search(); }}>
                <input type="text" placeholder="Username, display name or email" autoComplete="off" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search accounts" />
                <button type="submit" className="btn btn-primary"><Icon name="search" /> Search</button>
            </form>
            <div id="admin-results">
                {result.loading || result.error || !result.users.length
                    ? <ListState loading={result.loading} error={result.error} empty="No matching users." />
                    : result.users.map(u => <UserRow key={u.id} user={u} onChanged={() => search()} />)}
            </div>
        </>
    );
}

function userRank(keys: string[]): number {
    const map = badgesByKey();
    return keys.reduce((m, k) => Math.max(m, map[k]?.rank ?? 0), 0);
}

type Drawer = null | { kind: 'comments' | 'history' | 'sessions'; loading: boolean; error: string; data: any[] };

function UserRow({ user, onChanged }: { user: User; onChanged: () => void }) {
    const me = admin.me!;
    const isSelf = user.id === me.id;
    const targetRank = Number.isFinite(user.rank) ? user.rank! : userRank(user.badgeKeys);
    // Self-editing allowed; only equal/higher-rank other users stay locked.
    const rowLocked = !can('manage_badges') || (!isSelf && targetRank >= me.rank);
    const modLocked = isSelf || targetRank >= me.rank;

    const [keys, setKeys] = useState(user.badgeKeys);
    const [saving, setSaving] = useState(false);
    const dirty = keys.slice().sort().join() !== user.badgeKeys.slice().sort().join();
    const [drawer, setDrawer] = useState<Drawer>(null);
    const [resolving, setResolving] = useState(false);

    async function saveBadges() {
        setSaving(true);
        const client = await getClient();
        // SECURITY DEFINER RPC - re-checks manage_badges and rank hierarchy server-side.
        const { error } = await client.rpc('admin_set_user_badges', { target_user_id: user.id, new_badge_keys: keys });
        setSaving(false);
        if (error) { showToast('Could not update badges: ' + error.message, 'error'); return; }
        showToast('Badges updated', 'success');
        user.badgeKeys = keys;
        onChanged();
    }

    async function openDrawer(kind: NonNullable<Drawer>['kind'], force = false) {
        // the same button again closes it
        if (!force && drawer?.kind === kind) { setDrawer(null); return; }
        setDrawer({ kind, loading: true, error: '', data: [] });
        try {
            const client = await getClient();
            const [fn, args] = kind === 'comments' ? ['admin_user_comments', { p_user_id: user.id, p_limit: 200 }]
                : kind === 'history' ? ['admin_moderation_log', { p_user_id: user.id, p_action: '', p_limit: 100, p_offset: 0 }]
                    : ['admin_user_auth_events', { p_user_id: user.id, p_limit: 100 }];
            const { data, error } = await client.rpc(fn as string, args);
            if (error) throw error;
            setDrawer({ kind, loading: false, error: '', data: data || [] });
        } catch (e: any) {
            setDrawer({ kind, loading: false, error: e.message || 'Could not load that.', data: [] });
        }
    }
    // an open comments drawer reloads when a comment is deleted anywhere
    useEffect(() => { if (drawer?.kind === 'comments') openDrawer('comments', true); }, [reloads.comments]);

    // Geolocation is on demand only - an address leaves the project only when
    // staff is actually investigating that account.
    async function resolveLocations() {
        setResolving(true);
        try {
            const client = await getClient();
            const { data, error } = await client.functions.invoke('admin-ip-lookup', { body: { user_id: user.id } });
            if (error) throw error;
            showToast(`Resolved ${data?.resolved ?? 0} address${data?.resolved === 1 ? '' : 'es'}`, 'success');
            await openDrawer('sessions', true);
        } catch (e: any) {
            showToast(e.message || 'Location lookup failed.', 'error');
        } finally {
            setResolving(false);
        }
    }

    const handlers: Record<string, (arg?: string) => void> = {
        adminToggleUserComments: () => openDrawer('comments'),
        adminToggleUserHistory: () => openDrawer('history'),
        adminToggleUserSessions: () => openDrawer('sessions'),
        adminModAction: kind => modAction(kind!, user),
        adminOpenPurge: () => openDialog('admin-purge', { user })
    };

    const map = badgesByKey();
    return (
        <div className="admin-user-row">
            <div className="admin-user-head">
                <strong>{user.display_name || user.username || '(no username)'}</strong>
                {user.display_name && user.username && <span className="admin-user-handle">@{user.username}</span>}
                {user.badgeKeys.map(k => {
                    const b = map[k];
                    if (!b) return null;
                    return b.rank > 0
                        ? <span key={k} className="role-tag" style={{ color: b.color, borderColor: b.color }}>{b.label}</span>
                        : <span key={k} title={b.label}><BadgeIcon badge={b} /></span>;
                })}
                {isSelf && <span className="admin-you-tag">you</span>}
                <StandingPills user={user} />
            </div>
            <div className="admin-user-meta">
                <span>{user.email || 'no email on file'}</span>
                <span>Joined {fmtDate(user.created_at)}</span>
                <span>Last seen {fmtDate(user.last_sign_in_at)}</span>
                <span>{user.published_count ?? 0} published</span>
            </div>
            <div>
                <span className="admin-badge-select-label">Badges</span>
                <div className="admin-badge-select-grid">
                    {admin.badges.map(b => {
                        // assignable only by someone strictly higher rank (mirrors the server check)
                        const disabled = rowLocked || b.rank >= me.rank;
                        return (
                            <label key={b.key} className={`admin-badge-check${disabled ? ' locked' : ''}`} title={b.description || b.label}>
                                <input type="checkbox" checked={keys.includes(b.key)} disabled={disabled}
                                    onChange={e => setKeys(k => e.target.checked ? [...k, b.key] : k.filter(x => x !== b.key))} />
                                <BadgeIcon badge={b} size={13} className="" />
                                <span>{b.label}</span>
                            </label>
                        );
                    })}
                </div>
                {!rowLocked && dirty && (
                    <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} disabled={saving} onClick={saveBadges}>
                        <Icon name="check" size={14} /> Save badges
                    </button>
                )}
            </div>
            {(user.published_count ?? 0) > 0 && <PublishedMons user={user} />}
            <div className="admin-mod-bar">
                {moderationActions(user, { perms: me.perms, locked: modLocked }).map(a => (
                    <button key={a.key} type="button" className={a.tone || undefined} disabled={a.disabled} onClick={() => handlers[a.handler]?.(a.arg)}>
                        <Icon name={a.icon} /> {a.label}
                    </button>
                ))}
            </div>
            {drawer && (
                <div className="admin-drawer">
                    {drawer.kind === 'comments' && (
                        <CommentRows comments={drawer.data} loading={drawer.loading} error={drawer.error} empty="this account has not commented anywhere"
                            onDelete={can('delete_content') ? deleteComment : undefined} />
                    )}
                    {drawer.kind === 'history' && <LogRows entries={drawer.data} loading={drawer.loading} error={drawer.error} empty="nothing on record for this account" />}
                    {drawer.kind === 'sessions' && (drawer.loading || drawer.error
                        ? <ListState loading={drawer.loading} error={drawer.error} className="admin-drawer-empty" />
                        : <SessionsTable rows={drawer.data} resolving={resolving} onResolve={resolveLocations} onShowIp={showIpNeighbours} />)}
                </div>
            )}
        </div>
    );
}

// ---- published Fakémon ----
function PublishedMons({ user }: { user: User }) {
    const [open, setOpen] = useState(false);
    const [state, setState] = useState<{ loading: boolean; error: string; mons: any[] }>({ loading: true, error: '', mons: [] });

    async function load() {
        setState({ loading: true, error: '', mons: [] });
        const client = await getClient();
        const { data, error } = await client.from('published_mons').select('id, fakemon_data, published_at').eq('user_id', user.id).order('published_at', { ascending: false });
        setState({ loading: false, error: error ? error.message : '', mons: data || [] });
    }

    async function remove(monId: string) {
        const answer = await ask({ title: 'Remove published Fakémon', blurb: 'Removes this listing from the Community Hub. The owner is notified with your reason.', confirm: 'Remove' });
        if (!answer) return;
        const client = await getClient();
        // SECURITY DEFINER RPC - checks my_can_delete_any(), deletes, and notifies the owner.
        const { error } = await client.rpc('admin_delete_published_mon', { mon_id: monId, p_reason: answer.reason });
        if (error) { showToast('Could not delete: ' + error.message, 'error'); return; }
        showToast('Published mon removed', 'success');
        setState(s => ({ ...s, mons: s.mons.filter(m => m.id !== monId) }));
        // keeps the visible "N published" count roughly in sync without a full re-search
        user.published_count = Math.max(0, (user.published_count || 1) - 1);
    }

    return (
        <div className="admin-mons-toggle">
            <button type="button" onClick={() => { if (!open) load(); setOpen(!open); }}>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} /> View published mons ({user.published_count})
            </button>
            {open && (
                <div className="admin-mons-list" style={{ display: 'block' }}>
                    {state.loading || state.error || !state.mons.length
                        ? <ListState loading={state.loading} error={state.error} empty="No published mons." />
                        : state.mons.map(m => (
                            <div className="admin-mon-row" key={m.id}>
                                <span>{m.fakemon_data?.name || 'Unnamed'}</span>
                                <span className="admin-mon-date">{fmtDate(m.published_at)}</span>
                                {can('delete_content') && (
                                    <button type="button" className="admin-mon-delete" title="Delete this published mon" onClick={() => remove(m.id)}><Icon name="trash-2" /></button>
                                )}
                            </div>
                        ))}
                </div>
            )}
        </div>
    );
}

// ==================== moderation actions ====================
const ACTIONS: Record<string, {
    title: string; confirm: string; blurb: string; durations: Array<[number, string]> | null; requireReason?: boolean; danger?: boolean; dangerText?: string;
    rpc: (id: string, reason: string, amount: number | null) => [string, object];
}> = {
    warn: {
        title: 'Issue a warning', confirm: 'Send warning', durations: null,
        blurb: 'The user gets a notification with your reason. Warnings count toward the automatic escalation ladder, so a second offence lands a mute.',
        rpc: (id, reason) => ['admin_warn_user', { p_user_id: id, p_reason: reason }]
    },
    mute: {
        title: 'Mute this account', confirm: 'Apply mute',
        durations: [[60, '1 hour'], [360, '6 hours'], [1440, '24 hours'], [10080, '7 days'], [43200, '30 days'], [0, 'until lifted']],
        blurb: 'A muted account can still sign in and browse, but cannot comment, publish or update a listing.',
        rpc: (id, reason, mins) => ['admin_mute_user', { p_user_id: id, p_minutes: mins, p_reason: reason }]
    },
    unmute: {
        title: 'Lift this mute', confirm: 'Unmute', durations: null, requireReason: false,
        blurb: 'The account can post again immediately. The original mute stays in the log.',
        rpc: (id, reason) => ['admin_unmute_user', { p_user_id: id, p_reason: reason }]
    },
    ban: {
        title: 'Suspend this account', confirm: 'Suspend',
        durations: [[1, '1 day'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'permanent']],
        blurb: 'A suspension is enforced at the auth layer as well as in the app, so the account cannot get a session at all until it expires.',
        rpc: (id, reason, days) => ['admin_ban_user', { p_user_id: id, p_days: days, p_reason: reason }]
    },
    unban: {
        title: 'Lift this suspension', confirm: 'Lift suspension', durations: null, requireReason: false,
        blurb: 'The account can sign in again immediately.',
        rpc: (id, reason) => ['admin_unban_user', { p_user_id: id, p_reason: reason }]
    },
    delete_user: {
        title: 'Delete this account', confirm: 'Delete permanently', durations: null, danger: true,
        dangerText: 'This permanently deletes the account and everything it posted: Fakemon, comments, likes and its saved collection. It cannot be undone.',
        blurb: 'Use a suspension unless the account has to be gone entirely.',
        rpc: (id, reason) => ['admin_delete_user', { p_user_id: id, p_reason: reason }]
    }
};

const who = (user: User): ReactNode => <><strong>{user.display_name || user.username || 'this account'}</strong>: </>;

async function modAction(kind: string, user: User) {
    const spec = ACTIONS[kind];
    if (!spec) return;
    const answer = await ask({
        title: spec.title, blurb: <>{who(user)}{spec.blurb}</>, confirm: spec.confirm, durations: spec.durations,
        danger: spec.danger, dangerText: spec.dangerText, requireReason: spec.requireReason !== false
    });
    if (!answer) return;
    try {
        const client = await getClient();
        const [fn, args] = spec.rpc(user.id, answer.reason, answer.amount);
        const { error } = await client.rpc(fn, args);
        if (error) throw error;
        showToast(`${spec.title}: done`, 'success');
        // standing pills and available buttons both change - re-run the search
        reload('users');
        reload('log');
    } catch (e: any) {
        showToast(e.message || 'That action failed.', 'error');
    }
}

export async function deleteComment(c: Comment) {
    const answer = await ask({ title: 'Delete comment', blurb: 'The author is notified with your reason, and the deletion is recorded in the mod log.', confirm: 'Delete' });
    if (!answer) return;
    try {
        const client = await getClient();
        const { error } = await client.rpc('admin_delete_comment', { p_comment_id: c.id, p_kind: c.kind, p_reason: answer.reason });
        if (error) throw error;
        showToast('Comment deleted', 'success');
        reload('comments');
        reload('log');
    } catch (e: any) {
        showToast(e.message || 'Could not delete that comment.', 'error');
    }
}

// ==================== purge ====================
function PurgeDialog({ close, user }: DialogProps<{ user: User }>) {
    const [what, setWhat] = useState('all');
    const [hours, setHours] = useState(24);
    const [reason, setReason] = useState('');
    const [count, setCount] = useState<ReactNode>(' ');
    const [busy, setBusy] = useState(false);

    // the exact number the current selection would delete, so nobody confirms a purge blind
    const [preview] = useState(() => debounce(async (what: string, hours: number) => {
        setCount('counting…');
        try {
            const client = await getClient();
            if (what === 'mons') {
                // no dedicated count RPC for mons; the list RPC is cheap enough
                const { data, error } = await client.rpc('admin_user_mons', { p_user_id: user.id });
                if (error) throw error;
                const cutoff = hours > 0 ? Date.now() - hours * 3600_000 : -Infinity;
                const n = (data || []).filter((m: any) => new Date(m.published_at).getTime() >= cutoff).length;
                setCount(<>This will delete <strong>{n}</strong> published Fakemon.</>);
            } else {
                const { data, error } = await client.rpc('admin_count_user_comments', { p_user_id: user.id, p_hours: hours, p_kind: what });
                if (error) throw error;
                setCount(<>This will delete <strong>{data ?? 0}</strong> comment{data === 1 ? '' : 's'}.</>);
            }
        } catch (e: any) {
            setCount(<span className="admin-error">{e.message}</span>);
        }
    }, 200));
    useEffect(() => { preview(what, hours); }, [what, hours]);

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (!reason.trim()) { showToast('Give a reason - the user sees it, and it goes in the log.', 'error'); return; }
        setBusy(true);
        try {
            const client = await getClient();
            const [fn, args] = what === 'mons'
                ? ['admin_purge_user_mons', { p_user_id: user.id, p_hours: hours, p_reason: reason.trim() }]
                : ['admin_purge_user_comments', { p_user_id: user.id, p_hours: hours, p_kind: what, p_reason: reason.trim() }];
            const { data, error } = await client.rpc(fn, args);
            if (error) throw error;
            showToast(`Purged ${data ?? 0} item${data === 1 ? '' : 's'}`, 'success');
            close();
            reload('users');
            reload('log');
            reload('comments');
        } catch (err: any) {
            showToast(err.message || 'Purge failed.', 'error');
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal onClose={close} title="Purge content" labelledBy="admin-purge-title">
            <form onSubmit={submit}>
                <p className="admin-section-sub">
                    Bulk-remove content posted by <strong>{user.display_name || user.username || 'this account'}</strong>. The author gets one notification with your reason, and the purge is recorded in the mod log with the exact count.
                </p>
                <div className="admin-modal-row">
                    <div className="form-group">
                        <label htmlFor="admin-purge-what">What</label>
                        <select id="admin-purge-what" value={what} onChange={e => setWhat(e.target.value)}>
                            <option value="all">Comments (all kinds)</option>
                            <option value="mon">Fakemon comments only</option>
                            <option value="profile">Profile comments only</option>
                            <option value="mons">Published Fakemon</option>
                        </select>
                    </div>
                    <div className="form-group">
                        <label htmlFor="admin-purge-window">Time window</label>
                        <select id="admin-purge-window" value={hours} onChange={e => setHours(Number(e.target.value))}>
                            <option value={1}>Last hour</option>
                            <option value={24}>Last 24 hours</option>
                            <option value={72}>Last 3 days</option>
                            <option value={168}>Last 7 days</option>
                            <option value={720}>Last 30 days</option>
                            <option value={0}>Everything, all time</option>
                        </select>
                    </div>
                </div>
                <p className="admin-section-sub">{count}</p>
                <div className="form-group">
                    <label htmlFor="admin-purge-reason">Reason <span>(the user sees this)</span></label>
                    <textarea id="admin-purge-reason" rows={2} placeholder="E.g. comment spam across several listings" value={reason} onChange={e => setReason(e.target.value)} />
                </div>
                <div className="admin-mod-danger"><Icon name="alert-triangle" /><span>Bulk deletion cannot be undone. Check the count above before confirming.</span></div>
                <div className="admin-modal-actions">
                    <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
                    <button type="submit" className="btn btn-danger" disabled={busy}>Purge</button>
                </div>
            </form>
        </Modal>
    );
}
registerDialog('admin-purge', PurgeDialog);

// ==================== addresses ====================
function showIpNeighbours(ip: string) {
    if (!ip || ip === 'unknown') return;
    openDialog('admin-ip', { ip });
}

function IpDialog({ close, ip }: DialogProps<{ ip: string }>) {
    const [state, setState] = useState<{ loading: boolean; error: string; rows: any[] }>({ loading: true, error: '', rows: [] });
    useEffect(() => {
        let live = true;
        (async () => {
            try {
                const client = await getClient();
                const { data, error } = await client.rpc('admin_ip_neighbours', { p_ip: ip });
                if (error) throw error;
                if (live) setState({ loading: false, error: '', rows: data || [] });
            } catch (e: any) {
                if (live) setState({ loading: false, error: e.message, rows: [] });
            }
        })();
        return () => { live = false; };
    }, [ip]);
    return (
        <Modal onClose={close} title={ip} className="modal-wide" labelledBy="admin-ip-title">
            <p className="admin-section-sub">Accounts that have signed in or registered from this address. A match is not proof of ban evasion. Shared households, phone networks and university campuses all produce them.</p>
            <div className="admin-ip-scroll">
                {state.loading || state.error ? <ListState loading={state.loading} error={state.error} /> : <IpNeighbours rows={state.rows} />}
            </div>
        </Modal>
    );
}
registerDialog('admin-ip', IpDialog);
