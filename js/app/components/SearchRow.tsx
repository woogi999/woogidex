// One search result: its picture (or icon), its title with the match marked,
// and a line of detail. Used by the results page and the header's dropdown.

import { useEffect, useState, type MouseEvent } from 'react';
import { api } from '../../core/app.ts';
import { Icon } from './Icon.tsx';
import { matchParts, type SearchResult } from '../../features/search.ts';
import { ShieldedArt } from './ShieldedArt.tsx';

export function Highlighted({ text, query }: { text: string; query: string }) {
    const parts = matchParts(text, query);
    if (!parts) return <>{text}</>;
    return <>{parts[0]}<mark>{parts[1]}</mark>{parts[2]}</>;
}

function Thumb({ result }: { result: SearchResult }) {
    const [communityArt, setCommunityArt] = useState('');
    useEffect(() => {
        if (!result.publishedId) return;
        let live = true;
        api.requestCardArtwork?.(result.publishedId).then((art: string) => { if (live && art) setCommunityArt(art); }).catch(() => {});
        return () => { live = false; };
    }, [result.publishedId]);

    if (result.art) return <span className="gs-thumb is-art"><img src={result.art} alt="" loading="lazy" decoding="async" /></span>;
    if (communityArt) return <span className="gs-thumb is-art"><ShieldedArt src={communityArt} /></span>;
    return <span className="gs-thumb"><Icon name={result.icon || 'search'} /></span>;
}

interface RowProps {
    result: SearchResult;
    query: string;
    className?: string;
    id?: string;
    active?: boolean;
    onPick: (result: SearchResult, event: MouseEvent) => void;
    /** the dropdown picks on mousedown, so the box keeps focus */
    onMouseDown?: boolean;
}

export function SearchRow({ result, query, className = '', id, active = false, onPick, onMouseDown = false }: RowProps) {
    const handler = (event: MouseEvent) => { if (onMouseDown) event.preventDefault(); onPick(result, event); };
    return (
        <button type="button" className={`gs-item${className ? ` ${className}` : ''}${active ? ' is-active' : ''}`} role="option" id={id}
            aria-selected={active} {...(onMouseDown ? { onMouseDown: handler } : { onClick: handler })}>
            <Thumb result={result} />
            <span className="gs-text">
                <span className="gs-title"><Highlighted text={result.title} query={query} /></span>
                {result.sub && <span className="gs-sub">{result.sub}</span>}
            </span>
        </button>
    );
}
