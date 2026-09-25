// Privacy Policy and Terms of Service: Markdown files under public/legal/,
// fetched on demand and rendered here, so each is linkable as its own URL
// instead of baked into index.html markup. The page itself is
// js/app/pages/LegalPage.tsx.
//
// The sign-up dialog's Terms modal renders the same file as the /terms page
// (one copy, not a dialog version and a page version that can drift apart).
// Rendering itself lives in legal-markdown.ts, which is DOM-free so it can be
// unit-tested.

import { log } from '../core/log.ts';
import { api } from '../core/app.ts';
import { renderMarkdown } from './legal-markdown.ts';
import { closeDialog, openDialog } from '../app/dialogs.tsx';

export type LegalKey = 'privacy' | 'terms';

export const LEGAL_DOCS: Record<LegalKey, { src: string; title: string }> = {
    privacy: { src: 'legal/privacy.md', title: 'Privacy Policy' },
    terms: { src: 'legal/terms.md', title: 'Terms of Service' }
};

const isLegalKey = (key: string): key is LegalKey => key === 'privacy' || key === 'terms';

// doc key -> rendered HTML, so concurrent callers share one fetch
const cache = new Map<LegalKey, Promise<string>>();

/**
 * Fetches and renders a policy document. Cached for the life of the page.
 * @returns HTML, or an error message as HTML
 */
export function loadLegalDoc(key: string): Promise<string> {
    if (!isLegalKey(key)) return Promise.resolve('<p>That document does not exist.</p>');
    const doc = LEGAL_DOCS[key];
    if (!cache.has(key)) {
        cache.set(key, fetch(doc.src, { cache: 'no-cache' })
            .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text(); })
            .then(renderMarkdown)
            .catch(err => {
                log.error('LEGAL', `Could not load ${doc.src}`, { error: String(err) });
                cache.delete(key); // don't cache failures -- retry on next click
                return '<p>This document could not be loaded. Please check your connection and try again.</p>';
            }));
    }
    return cache.get(key)!;
}

// a heading the next page render should scroll to, set by openLegalPage
let pendingAnchor = '';

/** The heading the last openLegalPage() asked for, once. */
export function takePendingLegalAnchor(): string {
    const anchor = pendingAnchor;
    pendingAnchor = '';
    return anchor;
}

/**
 * Opens a policy document as a full page and points the address bar at it.
 * @param anchor a heading id to scroll to once it has rendered
 * @returns false if the key is not a document
 */
export async function openLegalPage(key: string, anchor = ''): Promise<boolean> {
    if (!isLegalKey(key)) return false;
    pendingAnchor = anchor;
    api.activateTopLevelView?.('legal-view');
    api.setRoute?.(key, LEGAL_DOCS[key].title);
    window.scrollTo({ top: 0 });
    return true;
}

export function openPrivacyPage() { return openLegalPage('privacy'); }
export function openTermsPage() { return openLegalPage('terms'); }

// ---- the sign-up dialog -----------------------------------------------------
// Terms also open in a dialog (same file) so sign-up isn't interrupted by
// navigation; its links to Privacy stay inside the dialog, since leaving would
// lose the half-filled sign-up form.

export function openTermsModal() {
    openDialog('terms', {});
}

export function closeTermsModal() {
    closeDialog('terms');
}
