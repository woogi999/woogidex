// Privacy Policy and Terms of Service: Markdown files under public/legal/,
// fetched on demand and rendered here, so each is linkable as its own URL
// instead of baked into index.html markup.
//
// The sign-up dialog's Terms modal renders the same file as the /terms page
// (one copy, not a dialog version and a page version that can drift apart).
// Rendering itself lives in legal-markdown.js, which is DOM-free so it can be
// unit-tested.

import { log } from '../core/log.js';
import { api } from '../core/app.js';
import { renderMarkdown } from './legal-markdown.js';

const DOCS = {
    privacy: { src: 'legal/privacy.md', title: 'Privacy Policy' },
    terms: { src: 'legal/terms.md', title: 'Terms of Service' }
};

// doc key -> Promise<string>, so concurrent callers share one fetch
const cache = new Map();

// ---- loading ----------------------------------------------------------------

/**
 * Fetches and renders a policy document. Cached for the life of the page.
 * @param {string} key 'privacy' or 'terms'
 * @returns {Promise<string>} HTML, or an error message as HTML
 */
export function loadLegalDoc(key) {
    const doc = DOCS[key];
    if (!doc) return Promise.resolve('<p>That document does not exist.</p>');
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
    return cache.get(key);
}

/**
 * Mounts a rendered document and wires its internal links (TOC scroll,
 * cross-reference to the other doc) without reloading the app.
 *
 * `openOther` is injected rather than hardcoded to openLegalPage() because
 * the sign-up dialog's Terms link to Privacy but must stay inside the dialog
 * (navigating away would lose the half-filled sign-up form).
 *
 * @param {HTMLElement} container
 * @param {string} html
 * @param {(key: string, anchor: string) => void} openOther
 */
function mountLegalDoc(container, html, openOther) {
    container.innerHTML = html;
    container.onclick = event => {
        const link = event.target.closest?.('a[data-legal-link]');
        if (!link || !container.contains(link)) return;
        event.preventDefault();
        const [path, anchor = ''] = link.getAttribute('data-legal-link').split('#');
        if (!path) scrollToAnchor(container, anchor);
        else openOther(path, anchor);
    };
}

function scrollToAnchor(container, anchor) {
    if (!anchor) return;
    // scoped query, not getElementById -- avoids matching the other doc's container once both have opened
    const target = container.querySelector(`[id="${CSS.escape(anchor)}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- the page ---------------------------------------------------------------

/**
 * Opens a policy document as a full page and points the address bar at it.
 * @param {string} key 'privacy' or 'terms'
 * @param {string} [anchor] a heading id to scroll to once it has rendered
 * @returns {Promise<boolean>} false if the key is not a document
 */
export async function openLegalPage(key, anchor = '') {
    const doc = DOCS[key];
    if (!doc) return false;

    api.activateTopLevelView?.('legal-view');
    api.setRoute?.(key, doc.title);

    const titleEl = document.getElementById('legal-title');
    const bodyEl = document.getElementById('legal-doc');
    if (titleEl) titleEl.textContent = doc.title;
    if (!bodyEl) return true;

    bodyEl.innerHTML = '<p class="legal-loading">Loading…</p>';
    window.scrollTo({ top: 0 });
    const html = await loadLegalDoc(key);
    // bail if the title changed -- user clicked through to the other doc while this was loading
    if (titleEl && titleEl.textContent !== doc.title) return true;
    mountLegalDoc(bodyEl, html, openLegalPage);
    if (anchor) scrollToAnchor(bodyEl, anchor);
    return true;
}

export function openPrivacyPage() { return openLegalPage('privacy'); }
export function openTermsPage() { return openLegalPage('terms'); }

// ---- the sign-up dialog -----------------------------------------------------
// Terms also open in a dialog (same file) so sign-up isn't interrupted by navigation.

async function showDocInTermsModal(key, anchor = '') {
    const doc = DOCS[key];
    const body = document.getElementById('terms-modal-doc');
    if (!doc || !body) return;
    document.getElementById('terms-modal-title')?.replaceChildren(doc.title);
    body.innerHTML = '<p class="legal-loading">Loading…</p>';
    const html = await loadLegalDoc(key);
    mountLegalDoc(body, html, showDocInTermsModal);
    body.closest('.modal-body')?.scrollTo({ top: 0 });
    scrollToAnchor(body, anchor);
}

export function openTermsModal() {
    const modal = document.getElementById('terms-modal');
    if (!modal) return;
    modal.classList.add('active');
    // always reset to Terms -- a previous visit may have left Privacy showing
    showDocInTermsModal('terms');
}

export function closeTermsModal() {
    document.getElementById('terms-modal')?.classList.remove('active');
}
