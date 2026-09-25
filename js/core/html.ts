// Leaf module (no imports, no DOM/state deps) so any page can pull it in.
// Single canonical `esc` implementation - past duplicates drifted and some
// were unsafe in attribute contexts (didn't escape quotes).

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escapes for both text and attribute contexts (quotes included).
export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => HTML_ENTITIES[c]);
}

// Showdown-style id normalisation: lowercase, alphanumerics only. Must match
// exactly across the battle dex, analysis pass, and exporters.
export function toId(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// The one name safe to show/store publicly. Deliberately excludes email from
// the fallback chain - an account without a username would otherwise leak its
// owner's email into public tables. Accepts state.user shape or a profiles row.
export function publicName(user) {
    const first = [user?.displayName, user?.display_name, user?.username]
        .find(v => typeof v === 'string' && v.trim());
    return first ? first.trim() : 'Trainer';
}
