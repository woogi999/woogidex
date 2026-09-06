// The moderation panel. Content here (usernames, comment bodies, filter
// patterns, user agents, IPs) is the least trustworthy on the site, so it's
// worth relying on React's automatic escaping rather than hand-escaping each
// interpolation. Permission logic lives in js/features/moderation-model.js so
// it can be tested independently. Handlers still call the same window.admin*
// globals the old inline onclick attributes called.

import { Icon } from './Icon.jsx';
import {
    userStanding,
    moderationActions,
    logEntry,
    commentLocation,
    timeAgo
} from '../features/moderation-model.js';

const call = (name, ...args) => window[name]?.(...args);

// ==================== standing and actions ====================

export function StandingPills({ user }) {
    const pills = userStanding(user);
    if (!pills.length) return null;
    return (
        <>
            {pills.map(p => (
                <span key={p.kind} className={`admin-standing ${p.kind}`}>
                    <Icon name={p.icon} /> {p.label}
                </span>
            ))}
        </>
    );
}

/**
 * @param {{user: object, perms: object, locked: boolean}} props
 *   `locked`: rank rule refuses this target regardless of permission, so
 *   buttons are disabled rather than offered and then rejected.
 */
export function ModerationBar({ user, perms = {}, locked = false }) {
    const actions = moderationActions(user, { perms, locked });
    return (
        <div className="admin-mod-bar">
            {actions.map(a => (
                <button
                    key={a.key}
                    type="button"
                    className={a.tone || undefined}
                    disabled={a.disabled}
                    onClick={e => (a.arg
                        ? call(a.handler, a.arg, user.id)
                        : call(a.handler, e.currentTarget, user.id))}
                >
                    <Icon name={a.icon} /> {a.label}
                </button>
            ))}
        </div>
    );
}

// ==================== comments ====================

export function CommentRow({ comment, showAuthor = false, canDelete = false }) {
    return (
        <div className="admin-comment-row" id={`admin-comment-${comment.id}`}>
            <div>
                <div className="admin-comment-meta">
                    <span className="admin-comment-kind">{comment.kind === 'profile' ? 'profile' : 'fakemon'}</span>
                    {showAuthor && <strong>{comment.author_name || 'unknown'}</strong>}
                    <span>{commentLocation(comment)}</span>
                    <span>{timeAgo(comment.created_at)}</span>
                </div>
                <p>{comment.body}</p>
            </div>
            {canDelete && (
                <button
                    type="button"
                    className="admin-mon-delete"
                    title="Delete this comment"
                    onClick={() => call('adminDeleteComment', comment.id, comment.kind)}
                >
                    <Icon name="trash-2" />
                </button>
            )}
        </div>
    );
}

/**
 * `empty` is passed in because the same empty list means different things in
 * different places.
 */
export function CommentRows({ comments = [], showAuthor = false, canDelete = false, loading = false, error = '', empty = 'no comments' }) {
    if (loading) return <div className="admin-empty">loading</div>;
    if (error) return <div className="admin-empty admin-error">{error}</div>;
    if (!comments.length) return <div className="admin-empty">{empty}</div>;
    return (
        <>
            {comments.map(c => (
                <CommentRow key={c.id} comment={c} showAuthor={showAuthor} canDelete={canDelete} />
            ))}
        </>
    );
}

// ==================== the moderation log ====================

export function LogRow({ entry }) {
    const e = logEntry(entry);
    return (
        <div className={`admin-log-row ${e.severity}`}>
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
}

export function LogRows({ entries = [], loading = false, error = '', empty = 'nothing on record' }) {
    if (loading) return <div className="admin-empty">loading</div>;
    if (error) return <div className="admin-empty admin-error">{error}</div>;
    if (!entries.length) return <div className="admin-empty">{empty}</div>;
    return <>{entries.map(a => <LogRow key={a.id || `${a.action}-${a.created_at}`} entry={a} />)}</>;
}

// ==================== sessions and addresses ====================
// Sign-in events with IP addresses and user agents. Nothing here is generated
// by this app, so a user agent is just a string a client chose to send.

export function SessionsTable({ rows = [], userId = '', onResolve = true }) {
    // Looked up only on demand, so an address never leaves the project unless
    // a moderator is actively investigating that account.
    const unresolved = rows.some(r => !r.country && r.ip && r.ip !== 'unknown');

    return (
        <>
            {onResolve && unresolved && (
                <div style={{ marginBottom: 8 }}>
                    <button
                        type="button"
                        className="btn btn-sm"
                        onClick={e => call('adminResolveLocations', userId, e.currentTarget)}
                    >
                        resolve locations
                    </button>
                </div>
            )}
            <div className="admin-ip-scroll">
                <table className="admin-ip-table">
                    <thead>
                        <tr><th>event</th><th>when</th><th>address</th><th>location</th><th>client</th></tr>
                    </thead>
                    <tbody>
                        {rows.map((r, i) => {
                            const location = [r.city, r.region, r.country].filter(Boolean).join(', ');
                            return (
                                <tr key={r.id || i}>
                                    <td>
                                        <span className={`admin-ip-kind ${r.kind === 'signup' ? 'signup' : ''}`}>{r.kind}</span>
                                    </td>
                                    <td>
                                        {r.created_at ? new Date(r.created_at).toLocaleString() : ''}
                                        <br />
                                        <small style={{ color: 'var(--fg-faint)' }}>{timeAgo(r.created_at)}</small>
                                    </td>
                                    <td>
                                        <a
                                            href="#"
                                            className="admin-ip-addr"
                                            onClick={e => { e.preventDefault(); call('adminShowIpNeighbours', r.ip || ''); }}
                                        >
                                            {r.ip || 'unknown'}
                                        </a>
                                        {r.shared_with > 0 && (
                                            <div className="admin-ip-shared">
                                                {r.shared_with} other account{r.shared_with === 1 ? '' : 's'} on this address
                                            </div>
                                        )}
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

export function SessionsPanel({ rows = [], userId = '', loading = false, error = '' }) {
    if (loading) return <div className="admin-drawer-empty">loading</div>;
    if (error) return <div className="admin-drawer-empty admin-error">{error}</div>;
    if (!rows.length) {
        return (
            <div className="admin-drawer-empty">
                no sign-ins recorded for this account yet, addresses are only captured
                from the point the audit was added onwards
            </div>
        );
    }
    return <SessionsTable rows={rows} userId={userId} />;
}

// ==================== word filter ====================

export function TermRows({ terms = [], canEdit = false, loading = false, error = '' }) {
    if (loading) return <div className="admin-empty">loading</div>;
    if (error) return <div className="admin-empty admin-error">{error}</div>;
    if (!terms.length) return <div className="admin-empty">no rules yet</div>;
    return (
        <>
            {terms.map(t => (
                <div key={t.id} className={`admin-term-row ${t.enabled ? '' : 'off'}`}>
                    <div>
                        <div className="admin-term-head">
                            <span>{t.label}</span>
                            <span className={`admin-hit-pill ${t.action === 'block' ? 'block' : 'flag'}`}>{t.action}</span>
                            <span className="admin-perm-pill">{t.severity}</span>
                            {!t.enabled && <span className="admin-perm-pill">disabled</span>}
                        </div>
                        {/* shown verbatim as text, never interpreted as markup */}
                        <code>{t.pattern}</code>
                        {t.notes && <small>{t.notes}</small>}
                    </div>
                    <div className="admin-term-actions">
                        <button
                            type="button"
                            title={t.enabled ? 'Disable' : 'Enable'}
                            disabled={!canEdit}
                            onClick={() => call('adminToggleTerm', t.id)}
                        >
                            <Icon name={t.enabled ? 'toggle-right' : 'toggle-left'} />
                        </button>
                        <button
                            type="button"
                            title="Edit"
                            disabled={!canEdit}
                            onClick={() => call('adminEditTerm', t.id)}
                        >
                            <Icon name="pencil" />
                        </button>
                    </div>
                </div>
            ))}
        </>
    );
}

/** Every account that has signed in from one address -- how a moderator
 *  connects a new account to a banned one. */
export function IpNeighbours({ rows = [], loading = false, error = '' }) {
    if (loading) return <div className="admin-empty">loading</div>;
    if (error) return <div className="admin-empty admin-error">{error}</div>;
    if (!rows.length) return <div className="admin-empty">nothing recorded for this address</div>;
    return (
        <table className="admin-ip-table">
            <thead>
                <tr><th>account</th><th>first seen</th><th>last seen</th><th>events</th></tr>
            </thead>
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

/** Which filter rules a test text trips, shown live while staff write a rule. */
export function FilterHits({ hits = [] }) {
    if (!hits.length) return <span className="admin-hit-pill clear">no rule matches this</span>;
    return (
        <>
            {hits.map((h, i) => (
                <span key={h.id || i} className={`admin-hit-pill ${h.action === 'block' ? 'block' : 'flag'}`}>
                    {h.label} / {h.action}
                </span>
            ))}
        </>
    );
}

/**
 * Preview of an unsaved pattern, tested through Postgres (not JS) since that's
 * what actually applies it -- catches a malformed regex before Save does.
 * `status`: '' | 'invalid' | 'valid' | 'match' | 'no-match' | 'error'.
 */
export function PatternPreview({ status = '', detail = '' }) {
    switch (status) {
        case 'invalid':
            return (
                <>
                    <span className="admin-hit-pill block">invalid regex</span>
                    <span>{detail}</span>
                </>
            );
        case 'valid':
            return <span className="admin-hit-pill clear">pattern is valid</span>;
        case 'match':
            return <span className="admin-hit-pill block">matches that phrase</span>;
        case 'no-match':
            return <span className="admin-hit-pill clear">no match</span>;
        case 'error':
            return <span className="admin-error">{detail}</span>;
        default:
            return null;
    }
}

/** The saved-rules check: which live rules a piece of text trips, or why not. */
export function FilterTestResult({ hits = null, error = '' }) {
    if (error) return <span className="admin-error">{error}</span>;
    if (hits === null) return null;      // nothing typed yet
    return <FilterHits hits={hits} />;
}
