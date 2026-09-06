// UpdatesView is pure (status + updates in, markup out) so all states are
// directly testable; UpdatesPanel is the thin stateful wrapper that loads data
// and picks the status. Parsing/fetching stay in js/features/updates.js.

import { useEffect, useState } from 'react';
import { Icon } from './Icon.jsx';

function Empty({ icon, title, children }) {
    return (
        <div className="updates-empty-state">
            <Icon name={icon} />
            <h4>{title}</h4>
            <p>{children}</p>
        </div>
    );
}

// Renders **bold**/`code` markdown as React elements rather than HTML, so
// everything else stays an escaped text node and no dangerouslySetInnerHTML
// is needed near author-controlled content.
function Rich({ text }) {
    const parts = String(text || '').split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return (
        <>
            {parts.map((part, i) => {
                if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
                if (/^`[^`]+`$/.test(part)) return <code key={i}>{part.slice(1, -1)}</code>;
                return part;
            })}
        </>
    );
}

function Entry({ update, latest, unread }) {
    return (
        <article className={`update-entry${latest ? ' update-entry-latest' : ''}${unread ? ' update-entry-unread' : ''}`}>
            <div className="update-entry-header">
                <div>
                    <div className="update-entry-kicker">{update.version || ''}</div>
                    <h4>{update.title || 'Update'}</h4>
                </div>
                <time>{update.date || ''}</time>
            </div>
            {update.items?.length > 0 && (
                <ul>
                    {update.items.map((item, i) => <li key={i}><Rich text={item} /></li>)}
                </ul>
            )}
        </article>
    );
}

/**
 * Every screen the panel can show, as a function of its inputs.
 * @param {{status: 'loading'|'error'|'ready', updates?: object[]}} props
 */
export function UpdatesView({ status, updates = [], unreadIds = null }) {
    if (status === 'loading') {
        return <Empty icon="loader-circle" title="Loading updates...">Fetching the latest Woogidex updates.</Empty>;
    }
    if (status === 'error') {
        return (
            <Empty icon="triangle-alert" title="Updates could not be loaded">
Make sure <strong>updates/index.json</strong> and the files it lists are published with the site.
            </Empty>
        );
    }
    if (!updates.length) {
        return <Empty icon="newspaper" title="No updates yet">There are no updates to show right now. Check back later!</Empty>;
    }
    return (
        <>
            {updates.map((update, i) => (
                <Entry
                    key={update.id || `${update.version}-${i}`}
                    update={update}
                    latest={i === 0}
                    unread={!!unreadIds?.has?.(update.id)}
                />
            ))}
        </>
    );
}

/**
 * @param {{load: () => Promise<object[]>}} props
 *   load is injected rather than imported, so tests don't need the network.
 */
export function UpdatesPanel({ load, unreadIds = null }) {
    const [status, setStatus] = useState('loading');
    const [updates, setUpdates] = useState([]);

    useEffect(() => {
        // guards against setting state after the modal closes mid-fetch
        let live = true;
        setStatus('loading');
        load()
            .then(list => {
                if (!live) return;
                setUpdates(list || []);
                setStatus('ready');
            })
            .catch(() => { if (live) setStatus('error'); });
        return () => { live = false; };
    }, [load]);

    return <UpdatesView status={status} updates={updates} unreadIds={unreadIds} />;
}
