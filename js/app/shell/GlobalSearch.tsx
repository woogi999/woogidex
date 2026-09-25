// The header's search box and its dropdown. On phones it folds into the icon
// button and opens across the header when tapped. What it searches:
// js/features/search.ts; open/close and the results page: global-search.ts.

import { Fragment, useEffect, useRef, useState } from 'react';
import { state } from '../../core/app.ts';
import { log } from '../../core/log.ts';
import { closeGlobalSearch, globalSearchState, openGlobalSearch, openSearchPage } from '../../features/global-search.ts';
import { COMMUNITY_DROPDOWN_LIMIT, DROPDOWN_LIMIT, communityResults, localGroups, quickResults, type SearchResult } from '../../features/search.ts';
import { Icon } from '../components/Icon.tsx';
import { SearchRow } from '../components/SearchRow.tsx';
import { useStore } from '../store.ts';

const COMMUNITY_DEBOUNCE_MS = 250;

type Group = [string, SearchResult[]];

export function GlobalSearch() {
    useStore();
    const box = globalSearchState();
    const rootRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const [text, setText] = useState('');
    // the dropdown is only up while the box has focus
    const [listOpen, setListOpen] = useState(false);
    const [active, setActive] = useState(-1);
    const [community, setCommunity] = useState<{ query: string; list: SearchResult[]; status: string }>({ query: '', list: [], status: '' });

    const query = text.trim();

    // asked to open (the phone icon, the "/" key): focus the field
    useEffect(() => { if (box.focusSeq) inputRef.current?.focus(); }, [box.focusSeq]);
    /** Drops the list and the focus (the phone layout folds back to its icon). */
    function close() {
        closeGlobalSearch();
        setListOpen(false);
        if (document.activeElement === inputRef.current) inputRef.current?.blur();
    }
    // a picked result or a search (here or on the results page) empties and closes it
    useEffect(() => { if (box.clearSeq) { setText(''); close(); } }, [box.clearSeq]);

    // Community Hub posts, a moment after typing stops; signed in only
    useEffect(() => {
        if (!query || !state.user) return;
        let live = true;
        setCommunity({ query, list: [], status: 'Searching the Community Hub…' });
        const timer = setTimeout(async () => {
            let list: SearchResult[] = [];
            let status = '';
            try { list = await communityResults(query, COMMUNITY_DROPDOWN_LIMIT); }
            catch (err: any) {
                log.warn('SEARCH', 'Community search failed', { error: String(err?.message || err) });
                status = 'The Community Hub could not be searched right now.';
            }
            if (live) setCommunity({ query, list, status });
        }, COMMUNITY_DEBOUNCE_MS);
        return () => { live = false; clearTimeout(timer); };
    }, [query, !!state.user]);

    useEffect(() => { setActive(-1); }, [query]);

    // a mousedown anywhere else closes it
    useEffect(() => {
        if (!listOpen && !box.open) return;
        const away = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) close(); };
        document.addEventListener('mousedown', away);
        return () => document.removeEventListener('mousedown', away);
    }, [listOpen, box.open]);

    let groups: Group[];
    let status = '';
    if (!query) groups = [['Go to', quickResults()]];
    else {
        const g = localGroups(query, DROPDOWN_LIMIT);
        const local: Group[] = [['Your Fakémon', g.fakemon], ['Your library', g.library], ['Pages and actions', g.pages]];
        if (!state.user) { groups = local; status = 'Sign in to search Community Hub posts too.'; }
        else {
            const mine = community.query === query ? community : { list: [], status: 'Searching the Community Hub…' };
            groups = [local[0], local[1], ['Community Hub', mine.list], local[2]];
            status = mine.status;
        }
    }
    const flat = groups.flatMap(([, list]) => list);

    function run(r: SearchResult | undefined) {
        if (!r) return;
        closeGlobalSearch({ clear: true });
        try { r.run(); } catch (err) { log.error('SEARCH', 'Search result action failed', { title: r.title, error: String(err) }); }
    }

    function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
        const move = (to: number) => {
            if (!flat.length) return;
            const next = (to + flat.length) % flat.length;
            setActive(next);
            document.getElementById(`gs-opt-${next}`)?.scrollIntoView({ block: 'nearest' });
        };
        if (event.key === 'ArrowDown') { event.preventDefault(); move(active + 1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); move(active - 1); }
        else if (event.key === 'Enter') {
            event.preventDefault();
            // a highlighted suggestion opens itself; otherwise Enter means "search"
            if (active !== -1) run(flat[active]);
            else if (query) openSearchPage(text);
        }
        else if (event.key === 'Escape') { event.preventDefault(); close(); }
    }

    let index = 0;
    return (
        <div className={`global-search${box.open || listOpen ? ' open' : ''}`} id="global-search" role="search" ref={rootRef}>
            <button className="global-search-toggle" type="button" onClick={() => openGlobalSearch()} aria-label="Search Woogidex" title="Search">
                <Icon name="search" />
            </button>
            <div className="global-search-field">
                <button className="global-search-back" type="button" onClick={close} aria-label="Close search"><Icon name="arrow-left" /></button>
                <Icon name="search" className="global-search-icon" />
                <input ref={inputRef} id="global-search-input" type="search" placeholder="Search Woogidex" autoComplete="off" spellCheck={false}
                    role="combobox" aria-expanded={listOpen} aria-controls="global-search-results" aria-autocomplete="list" aria-label="Search Woogidex"
                    aria-activedescendant={active !== -1 ? `gs-opt-${active}` : undefined}
                    value={text} onChange={e => setText(e.target.value)} onFocus={() => setListOpen(true)} onKeyDown={onKeyDown} />
                {/* our own clear button; the browser's built-in one is hidden (css/header.css) */}
                <button className="global-search-clear" type="button" aria-label="Clear search" title="Clear" hidden={!text}
                    // mousedown so the input keeps focus and the list stays open
                    onMouseDown={e => { e.preventDefault(); setText(''); inputRef.current?.focus(); }}>
                    <Icon name="x" />
                </button>
            </div>
            <div className="global-search-results" id="global-search-results" role="listbox" aria-label="Search results" hidden={!listOpen}>
                {groups.map(([label, list]) => list.length > 0 && (
                    <Fragment key={label}>
                        <div className="gs-group-label">{label}</div>
                        {list.map(r => {
                            const i = index++;
                            return <SearchRow key={`${label}-${i}`} id={`gs-opt-${i}`} result={r} query={query} active={i === active} onMouseDown onPick={() => run(r)} />;
                        })}
                    </Fragment>
                ))}
                {status && <div className="gs-status">{status}</div>}
                {!flat.length && !status && <div className="gs-empty">Nothing matches “{query}”.</div>}
                {/* the way to the full results page, like Facebook's "Search for ..." row */}
                {query && (
                    <button type="button" className="gs-item gs-see-all" onMouseDown={e => { e.preventDefault(); openSearchPage(text); }}>
                        <span className="gs-thumb"><Icon name="search" /></span>
                        <span className="gs-text"><span className="gs-title">See all results for “{query}”</span></span>
                    </button>
                )}
            </div>
        </div>
    );
}
