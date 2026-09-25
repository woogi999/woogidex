// /privacy and /terms: one page for both. The document is Markdown under
// public/legal/, fetched and rendered by js/features/legal.ts; which one shows
// comes from the address.

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { api } from '../../core/app.ts';
import { Icon } from '../components/Icon.tsx';
import { LEGAL_DOCS, loadLegalDoc, openLegalPage, takePendingLegalAnchor, type LegalKey } from '../../features/legal.ts';
import { useRoute } from '../hooks.ts';

export function LegalPage() {
    const route = useRoute();
    const key: LegalKey | null = route.name === 'privacy' || route.name === 'terms' ? route.name : null;
    const [html, setHtml] = useState<{ key: LegalKey; html: string } | null>(null);
    const bodyRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!key) return;
        let live = true;
        loadLegalDoc(key).then(result => { if (live) setHtml({ key, html: result }); });
        return () => { live = false; };
    }, [key]);

    // once the document is in, jump to the heading a link asked for
    useEffect(() => {
        if (!html || html.key !== key) return;
        const anchor = takePendingLegalAnchor();
        if (anchor) scrollToAnchor(bodyRef.current, anchor);
    }, [html, key]);

    if (!key) return null;
    const doc = LEGAL_DOCS[key];
    const ready = html?.key === key;

    // links inside the document: a heading on this page, or the other document
    function onDocClick(event: MouseEvent<HTMLDivElement>) {
        const link = (event.target as HTMLElement).closest?.('a[data-legal-link]');
        if (!link) return;
        event.preventDefault();
        const [path, anchor = ''] = (link.getAttribute('data-legal-link') || '').split('#');
        if (!path) scrollToAnchor(bodyRef.current, anchor);
        else openLegalPage(path, anchor);
    }

    return (
        <div className="panel legal-panel">
            <div className="legal-header">
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.showCollection()}>
                    <Icon name="arrow-left" size={14} /> Back
                </button>
                <h2 className="legal-title">{doc.title}</h2>
            </div>
            {ready
                ? <div className="legal-doc" ref={bodyRef} onClick={onDocClick} dangerouslySetInnerHTML={{ __html: html.html }} />
                : <div className="legal-doc"><p className="legal-loading">Loading…</p></div>}
        </div>
    );
}

function scrollToAnchor(container: HTMLElement | null, anchor: string) {
    if (!container || !anchor) return;
    container.querySelector(`[id="${CSS.escape(anchor)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
