// The moderation lists: comments, the log, sign-ins and addresses, filter
// rules. Content here (usernames, comment bodies, filter patterns, user
// agents, IPs) is the least trustworthy on the site, so it goes through
// React's escaping, never into markup strings. Permission rules and wording:
// js/features/moderation-model.ts.

import { Icon } from '../app/components/Icon.tsx';
import { commentLocation, logEntry, timeAgo, userStanding } from '../features/moderation-model.ts';
import { ListState } from './ui.tsx';

export function StandingPills({ user }: { user: any }) {
    return <>{userStanding(user).map(p => <span key={p.kind} className={`admin-standing ${p.kind}`}><Icon name={p.icon} /> {p.label}</span>)}</>;
}

// ---- comments ----
export interface Comment { id: string; kind: string; body: string; author_name?: string; context_name?: string; created_at: string; }

export function CommentRows({ comments, showAuthor = false, onDelete, loading, error, empty }: {
    comments: Comment[]; showAuthor?: boolean; onDelete?: (c: Comment) => void; loading?: boolean; error?: string; empty: string;
}) {
    if (loading || error || !comments.length) return <ListState loading={loading} error={error} empty={empty} />;
    return (
        <>
            {comments.map(c => (
                <div className="admin-comment-row" key={c.id}>
                    <div>
                        <div className="admin-comment-meta">
                            <span className="admin-comment-kind">{c.kind === 'profile' ? 'profile' : 'fakemon'}</span>
                            {showAuthor && <strong>{c.author_name || 'unknown'}</strong>}
                            <span>{commentLocation(c)}</span>
                            <span>{timeAgo(c.created_at)}</span>
                        </div>
                        <p>{c.body}</p>
                    </div>
                    {onDelete && (
                        <button type="button" className="admin-mon-delete" title="Delete this comment" onClick={() => onDelete(c)}><Icon name="trash-2" /></button>
                    )}
                </div>
            ))}
        </>
    );
}

// ---- the moderation log ----
export function LogRows({ entries, loading, error, empty }: { entries: any[]; loading?: boolean; error?: string; empty: string }) {
    if (loading || (!entries.length && (error || empty))) return <ListState loading={loading} error={error} empty={empty} />;
    return (
        <>
            {entries.map(a => {
                const e = logEntry(a);
                return (
                    <div className={`admin-log-row ${e.severity}`} key={a.id || `${a.action}-${a.created_at}`}>
                        <span className="admin-log-icon"><Icon name={e.icon} /></span>
                        <div className="admin-log-body">
                            <span>
                                <strong>{e.actor}</strong> {e.verb}
                                {e.target && <> <strong>{e.target}</strong></>}
                                {e.removed !== undefined && <> <strong>({e.removed})</strong></>}
                            </span>
                            {e.reason && <small>{e.reason}</small>}
                            {e.expires && <small>{e.expires}</small>}
                            {e.excerpt && <span className="admin-log-excerpt">{e.excerpt}</span>}
                        </div>
                        <span className="admin-log-time" title={e.exact}>{e.when}</span>
                    </div>
                );
            })}
            {error && <div className="admin-empty admin-error">{error}</div>}
        </>
    );
}

// ---- sign-ins and addresses ----
// Sign-in events with IP addresses and user agents. Nothing here is generated
// by this app, so a user agent is just a string a client chose to send.
export function SessionsTable({ rows, onResolve, resolving, onShowIp }: {
    rows: any[]; onResolve: () => void; resolving: boolean; onShowIp: (ip: string) => void;
}) {
    if (!rows.length) {
        return <div className="admin-drawer-empty">no sign-ins recorded for this account yet, addresses are only captured from the point the audit was added onwards</div>;
    }
    // Looked up only on demand, so an address never leaves the project unless
    // a moderator is actively investigating that account.
    const unresolved = rows.some(r => !r.country && r.ip && r.ip !== 'unknown');
    return (
        <>
            {unresolved && (
                <div style={{ marginBottom: 8 }}>
                    <button type="button" className="btn btn-sm" disabled={resolving} onClick={onResolve}>{resolving ? 'resolving' : 'resolve locations'}</button>
                </div>
            )}
            <div className="admin-ip-scroll">
                <table className="admin-ip-table">
                    <thead><tr><th>event</th><th>when</th><th>address</th><th>location</th><th>client</th></tr></thead>
                    <tbody>
                        {rows.map((r, i) => {
                            const location = [r.city, r.region, r.country].filter(Boolean).join(', ');
                            return (
                                <tr key={r.id || i}>
                                    <td><span className={`admin-ip-kind ${r.kind === 'signup' ? 'signup' : ''}`}>{r.kind}</span></td>
                                    <td>
                                        {r.created_at ? new Date(r.created_at).toLocaleString() : ''}<br />
                                        <small style={{ color: 'var(--fg-faint)' }}>{timeAgo(r.created_at)}</small>
                                    </td>
                                    <td>
                                        <button type="button" className="admin-ip-addr" onClick={() => onShowIp(r.ip || '')}>{r.ip || 'unknown'}</button>
                                        {r.shared_with > 0 && <div className="admin-ip-shared">{r.shared_with} other account{r.shared_with === 1 ? '' : 's'} on this address</div>}
                                    </td>
                                    <td>
                                        {location || <span style={{ color: 'var(--fg-faint)' }}>not resolved</span>}
                                        {r.org && <><br /><small style={{ color: 'var(--fg-faint)' }}>{r.org}</small></>}
                                    </td>
                                    <td className="admin-ip-ua">{r.user_agent || ''}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </>
    );
}

/** Every account that has signed in from one address -- how a moderator connects a new account to a banned one. */
export function IpNeighbours({ rows }: { rows: any[] }) {
    if (!rows.length) return <div className="admin-empty">nothing recorded for this address</div>;
    return (
        <table className="admin-ip-table">
            <thead><tr><th>account</th><th>first seen</th><th>last seen</th><th>events</th></tr></thead>
            <tbody>
                {rows.map((r, i) => (
                    <tr key={r.user_id || i}>
                        <td>
                            {r.display_name || r.username || '(deleted)'}
                            {r.username && <><br /><small style={{ color: 'var(--fg-faint)' }}>@{r.username}</small></>}
                        </td>
                        <td>{r.first_seen ? new Date(r.first_seen).toLocaleDateString() : ''}</td>
                        <td>{timeAgo(r.last_seen)}</td>
                        <td>{r.hits}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

// ---- the content filter ----
/** Which filter rules a test text trips. */
export function FilterHits({ hits }: { hits: any[] }) {
    if (!hits.length) return <span className="admin-hit-pill clear">no rule matches this</span>;
    return <>{hits.map((h, i) => <span key={h.id || i} className={`admin-hit-pill ${h.action === 'block' ? 'block' : 'flag'}`}>{h.label} / {h.action}</span>)}</>;
}

/**
 * Preview of an unsaved pattern, tested through Postgres (not JS) since that's
 * what actually applies it -- catches a malformed regex before Save does.
 */
export type PatternStatus = '' | 'invalid' | 'valid' | 'match' | 'no-match' | 'error';
export function PatternPreview({ status, detail = '' }: { status: PatternStatus; detail?: string }) {
    switch (status) {
        case 'invalid': return <><span className="admin-hit-pill block">invalid regex</span><span>{detail}</span></>;
        case 'valid': return <span className="admin-hit-pill clear">pattern is valid</span>;
        case 'match': return <span className="admin-hit-pill block">matches that phrase</span>;
        case 'no-match': return <span className="admin-hit-pill clear">no match</span>;
        case 'error': return <span className="admin-error">{detail}</span>;
        default: return null;
    }
}
