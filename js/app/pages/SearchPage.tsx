// /search?q=... -- the full results for the header's search box (pressing
// Enter there lands here). Everything local is searched as the page renders;
// Community Hub posts arrive after, for signed-in visitors.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { state } from '../../core/app.ts';
import { log } from '../../core/log.ts';
import { Icon } from '../components/Icon.tsx';
import { COMMUNITY_PAGE_LIMIT, GROUPS, PAGE_LIMIT, communityResults, localGroups, type GroupKey, type SearchResult } from '../../features/search.ts';
import { openSearchPage, takeSearchFilter } from '../../features/global-search.ts';
import { SearchRow } from '../components/SearchRow.tsx';
import { useQueryParam } from '../hooks.ts';
import { useStore } from '../store.ts';

type Filter = 'all' | GroupKey;
type CommunityStatus = '' | 'loading' | 'signed-out' | 'error';

export function SearchPage() {
    const version = useStore();
    const query = useQueryParam('q').trim();
    const [filter, setFilter] = useState<Filter>('all');
    const [draft, setDraft] = useState(query);
    const [community, setCommunity] = useState<{ query: string; list: SearchResult[]; status: CommunityStatus }>({ query: '', list: [], status: '' });

    // a new search (typed here, from the header, or back/forward) starts over
    useEffect(() => { setDraft(query); setFilter(takeSearchFilter() as Filter); }, [query]);

    const local = useMemo(() => (query ? localGroups(query, PAGE_LIMIT) : null), [query, version]);
    const signedIn = !!state.user;

    useEffect(() => {
        if (!query) { setCommunity({ query, list: [], status: '' }); return; }
        if (!signedIn) { setCommunity({ query, list: [], status: 'signed-out' }); return; }
        let live = true;
        setCommunity({ query, list: [], status: 'loading' });
        communityResults(query, COMMUNITY_PAGE_LIMIT)
            .then(list => { if (live) setCommunity({ query, list, status: '' }); })
            .catch(err => {
                log.warn('SEARCH', 'Community search failed', { error: String(err?.message || err) });
                if (live) setCommunity({ query, list: [], status: 'error' });
            });
        return () => { live = false; };
    }, [query, signedIn]);

    const groups: Record<GroupKey, SearchResult[]> = {
        fakemon: local?.fakemon || [],
        library: local?.library || [],
        pages: local?.pages || [],
        community: community.query === query ? community.list : []
    };
    const communityStatus = community.query === query ? community.status : (query && signedIn ? 'loading' : '');
    const total = GROUPS.reduce((n, [key]) => n + groups[key].length, 0);

    function submit(event: FormEvent) {
        event.preventDefault();
        openSearchPage(draft, { filter });
    }

    function pick(result: SearchResult) {
        try { result.run(); } catch (err) { log.error('SEARCH', 'Search result action failed', { title: result.title, error: String(err) }); }
    }

    const tabs: Array<[Filter, string, number]> = [
        ['all', 'All', total],
        ...GROUPS.map(([key, label]): [Filter, string, number] => [key, label.replace(/^Your /, '').replace(/^./, c => c.toUpperCase()), groups[key].length])
    ];

    const section = ([key, label]: [GroupKey, string], cap: number) => {
        const list = groups[key];
        let status = '';
        if (key === 'community') {
            if (communityStatus === 'loading') status = 'Searching the Community Hub…';
            else if (communityStatus === 'signed-out') status = 'Sign in to search Community Hub posts.';
            else if (communityStatus === 'error') status = 'The Community Hub could not be searched right now.';
        }
        if (!list.length && !status) return null;
        const shown = cap ? list.slice(0, cap) : list;
        return (
            <section className="search-section" key={key}>
                <header className="search-section-head">
                    <h2>{label}</h2>
                    {cap > 0 && list.length > cap && (
                        <button type="button" className="btn btn-secondary btn-sm search-see-more" onClick={() => setFilter(key)}>See all {list.length}</button>
                    )}
                </header>
                {shown.length > 0 && (
                    <div className="search-list">
                        {shown.map((r, i) => <SearchRow key={`${r.title}-${i}`} result={r} query={query} className="search-row" onPick={pick} />)}
                    </div>
                )}
                {status && <p className="search-section-status">{status}</p>}
            </section>
        );
    };

    const sections = filter === 'all'
        ? GROUPS.map(g => section(g, 6)).filter(Boolean)
        : [section(GROUPS.find(([key]) => key === filter) || GROUPS[0], 0)].filter(Boolean);

    return (
        <>
            <div className="page-header">
                <div className="page-heading">
                    <h1 className="page-title">Search</h1>
                    <p className="page-subtitle">{query ? `Results for “${query}”` : 'Search your collection, pages and the Community Hub.'}</p>
                </div>
            </div>

            <form className="search-page-form" role="search" onSubmit={submit}>
                <Icon name="search" />
                <input type="search" placeholder="Search Woogidex" autoComplete="off" spellCheck={false} aria-label="Search Woogidex"
                    value={draft} onChange={e => setDraft(e.target.value)} />
                <button className="btn btn-primary" type="submit">Search</button>
            </form>

            <div className="tabs search-page-tabs" role="tablist" aria-label="Filter results">
                {tabs.map(([key, label, n]) => (
                    <button key={key} type="button" role="tab" className={`tab${filter === key ? ' active' : ''}`} aria-selected={filter === key} onClick={() => setFilter(key)}>
                        {label}{query && <span className="search-tab-count">{n}</span>}
                    </button>
                ))}
            </div>

            <div className="search-page-results">
                {!query ? (
                    <div className="search-page-empty"><Icon name="search" /><p>Type something to search for.</p></div>
                ) : sections.length ? sections : (
                    <div className="search-page-empty">
                        <Icon name="search-x" />
                        <p>Nothing matches “{query}”.</p>
                        <span>Check the spelling, or try a shorter word.</span>
                    </div>
                )}
            </div>
        </>
    );
}
