// Renders the Markdown in public/legal/*.md into HTML for legal.js. Split out
// and dependency-free so it can be unit-tested without a browser/DOM.
//
// Only the subset the two documents actually use is supported (headings,
// lists, paragraphs, bold, italic, links, hr) -- deliberately, rather than
// pulling in a Markdown library for two static files.
//
// Everything is escaped before markup is generated, so a document can't
// inject HTML even though it's a file we control.

const escapeHtml = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Heading id (GitHub's slug rule: lowercase, strip non-word/space/hyphen
 * chars, spaces -> hyphens). "## 7. How long...?" -> "7-how-long...".
 * @param {string} text heading text, already stripped of markdown
 * @returns {string}
 */
export function headingSlug(text) {
    return String(text).toLowerCase().trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-');
}

/**
 * Inline markdown: links, bold, italic. Runs on already-escaped text.
 * @param {string} text
 * @returns {string} HTML
 */
function inline(text) {
    return text
        // http(s) links open in a new tab; anything else is an in-app
        // destination routed by legal.js's click handler (a real navigation
        // would reload the app and lose an in-progress sign-up form).
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
            if (/^https?:\/\//i.test(href)) {
                return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
            }
            return `<a href="${href}" data-legal-link="${href}">${label}</a>`;
        })
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/**
 * Renders the Markdown subset the policy documents use.
 * @param {string} markdown
 * @returns {string} HTML
 */
export function renderMarkdown(markdown) {
    const lines = escapeHtml(markdown).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let list = null;   // 'ul' | 'ol' while one is open

    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const openList = kind => { if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; } };

    for (const raw of lines) {
        const line = raw.trim();

        if (!line) { closeList(); continue; }

        if (/^---+$/.test(line)) { closeList(); out.push('<hr>'); continue; }

        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            closeList();
            const level = heading[1].length;
            // slug from markdown-stripped text so bold headings still anchor correctly
            const plain = heading[2].replace(/[*`]/g, '');
            out.push(`<h${level} id="${headingSlug(plain)}">${inline(heading[2])}</h${level}>`);
            continue;
        }

        const ordered = line.match(/^\d+\.\s+(.*)$/);
        if (ordered) { openList('ol'); out.push(`<li>${inline(ordered[1])}</li>`); continue; }

        const bullet = line.match(/^[-*]\s+(.*)$/);
        if (bullet) { openList('ul'); out.push(`<li>${inline(bullet[1])}</li>`); continue; }

        closeList();
        out.push(`<p>${inline(line)}</p>`);
    }
    closeList();
    return out.join('\n');
}
