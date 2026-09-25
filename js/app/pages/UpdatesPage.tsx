// Updates & Credits: the changelog and the credits, one page.
// /updates opens the changelog, /updates/credits the credits.

import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon.tsx';
import { loadUpdates, openUpdatesPage, unreadUpdateIds, type Update } from '../../features/updates.ts';
import { useRoute } from '../hooks.ts';

export function UpdatesPage() {
    const route = useRoute();
    const tab = route.name === 'updates' && route.param === 'credits' ? 'credits' : 'updates';
    return (
        <>
            <div className="page-header">
                <div className="page-heading">
                    <h1 className="page-title">Updates &amp; Credits</h1>
                    <p className="page-subtitle">What's new in Woogidex, and the people who make it.</p>
                </div>
            </div>

            <div className="tabs updates-tabs" role="tablist" aria-label="Updates and credits">
                {(['updates', 'credits'] as const).map(t => (
                    <button key={t} className={`tab${tab === t ? ' active' : ''}`} type="button" role="tab"
                        aria-selected={tab === t} onClick={() => openUpdatesPage(t)}>
                        {t === 'updates' ? 'Updates' : 'Credits'}
                    </button>
                ))}
            </div>

            {/* the changelog stays mounted while Credits shows, so it isn't fetched again */}
            <section className="updates-page-section" hidden={tab !== 'updates'}>
                <div className="updates-page-list">
                    <UpdatesPanel />
                </div>
            </section>
            {tab === 'credits' && <Credits />}
        </>
    );
}

type Status = 'loading' | 'error' | 'ready';

function UpdatesPanel() {
    const [status, setStatus] = useState<Status>('loading');
    const [updates, setUpdates] = useState<Update[]>([]);

    useEffect(() => {
        let live = true;
        loadUpdates()
            .then(list => { if (live) { setUpdates(list || []); setStatus('ready'); } })
            .catch(() => { if (live) setStatus('error'); });
        return () => { live = false; };
    }, []);

    return <UpdatesView status={status} updates={updates} unreadIds={unreadUpdateIds()} />;
}

/** Every screen the changelog can show, as a function of its inputs. */
export function UpdatesView({ status, updates = [], unreadIds = null }: { status: Status; updates?: Update[]; unreadIds?: Set<string> | null }) {
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
                <Entry key={update.id || `${update.version}-${i}`} update={update} latest={i === 0} unread={!!unreadIds?.has(update.id)} />
            ))}
        </>
    );
}

function Empty({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
    return (
        <div className="updates-empty-state">
            <Icon name={icon} />
            <h4>{title}</h4>
            <p>{children}</p>
        </div>
    );
}

// **bold** and `code` become elements; everything else stays escaped text
function Rich({ text }: { text: string }) {
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

function Entry({ update, latest, unread }: { update: Update; latest: boolean; unread: boolean }) {
    return (
        <article className={`update-entry${latest ? ' update-entry-latest' : ''}${unread ? ' update-entry-unread' : ''}`}>
            <div className="update-entry-header">
                <div>
                    <div className="update-entry-kicker">{update.version || ''}</div>
                    <h4>{update.title || 'Update'}</h4>
                </div>
                <time>{update.date || ''}</time>
            </div>
            {update.items.length > 0 && (
                <ul>{update.items.map((item, i) => <li key={i}><Rich text={item} /></li>)}</ul>
            )}
        </article>
    );
}

const link = (href: string, name: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="credits-link">{name}</a>
);

function Credits() {
    return (
        <section className="updates-page-section credits-page">
            <h2 className="credits-title">Woogidex</h2>
            <dl className="credits-list">
                <div><dt>Created by</dt><dd>{link('https://github.com/woogi999', 'Woogi')}</dd></div>
                <div><dt>Lead Backend</dt><dd>{link('https://github.com/gghrvy', 'gghrvy')}</dd></div>
                <div><dt>Placeholder Art &amp; Sprites</dt><dd>Enderwither02</dd></div>
                <div><dt>Type Icons</dt><dd>{link('https://github.com/duiker101/pokemon-type-svg-icons', 'duiker101')}</dd></div>
            </dl>
            <h3>Attributions</h3>
            <p>Woogidex is a fan-made, unofficial project. Pokémon and related names, characters, and other intellectual property are owned by their respective rights holders.</p>
            <h3>Disclaimer</h3>
            <p>Woogidex is not affiliated with, endorsed by, or sponsored by Nintendo, The Pokémon Company, or Game Freak. This project is made for fan and non-commercial purposes.</p>
            <p className="credits-footnote">© 2026 Woogidex · All rights reserved to their respective owners.</p>
        </section>
    );
}
