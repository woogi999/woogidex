// Custom emojis, Discord style: type :tatsuorange: and it shows as the picture.
//
// The pictures live in public/emojis and ship with the site; the list of them
// is built from the file names when the site is built (vite.config.js,
// emojiManifest). Text everywhere only ever stores the ":name:" code, and each
// picture is a static file the browser downloads once and then caches, so an
// emoji costs a few bytes in the database and nothing on repeat views.

import EMOJIS from 'virtual:emoji-manifest';

export interface Emoji { name: string; src: string; category: string; animated: boolean; }

const byName = new Map<string, Emoji>(EMOJIS.map(e => [e.name, e]));

/** Picker tabs, in the order the folders sort, with the loose files first. */
const CATEGORY_LABELS: Record<string, string> = { general: 'Woogidex', pokemon: 'Pokémon', pride_flags: 'Pride flags' };

export function emojiList(): Emoji[] { return EMOJIS; }

export function emojiByName(name: string): Emoji | null {
    return byName.get(String(name || '').toLowerCase()) || null;
}

export function emojiCategories(): Array<{ key: string; label: string; emojis: Emoji[] }> {
    const groups = new Map<string, Emoji[]>();
    for (const e of EMOJIS) {
        if (!groups.has(e.category)) groups.set(e.category, []);
        groups.get(e.category)!.push(e);
    }
    return [...groups.entries()]
        .sort(([a], [b]) => (a === 'general' ? -1 : b === 'general' ? 1 : a.localeCompare(b)))
        .map(([key, emojis]) => ({ key, label: CATEGORY_LABELS[key] || key.replace(/_/g, ' '), emojis }));
}

/**
 * Emojis whose name contains the query, the ones that start with it first.
 * What the ":ta" autocomplete and the picker's search box show.
 */
export function searchEmojis(query: string, limit = 50): Emoji[] {
    const q = String(query || '').toLowerCase().replace(/^:|:$/g, '');
    if (!q) return EMOJIS.slice(0, limit);
    const starts: Emoji[] = [];
    const contains: Emoji[] = [];
    for (const e of EMOJIS) {
        if (e.name.startsWith(q)) starts.push(e);
        else if (e.name.includes(q)) contains.push(e);
    }
    return [...starts, ...contains].slice(0, limit);
}

const SHORTCODE = /:([a-z0-9_]{1,48}):/g;

/**
 * Swaps every known :name: in already-escaped HTML for its picture. Unknown
 * codes stay as typed, so "10:30:00" and typos read as plain text.
 * @param jumbo draw them large (a message that is nothing but emojis)
 */
export function emojifyHtml(escapedHtml: string, jumbo = false): string {
    return escapedHtml.replace(SHORTCODE, (whole, name) => {
        const e = byName.get(name);
        if (!e) return whole;
        return `<img class="emoji${jumbo ? ' emoji-jumbo' : ''}" src="${e.src}" alt=":${e.name}:" title=":${e.name}:" draggable="false" loading="lazy" decoding="async">`;
    });
}

/** Whether the text is only emojis (and spaces), at most 27 of them, the way Discord enlarges them. */
export function isEmojiOnly(text: string): boolean {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    let count = 0;
    const rest = trimmed.replace(SHORTCODE, (whole, name) => {
        if (!byName.has(name)) return whole;
        count++;
        return '';
    });
    return count > 0 && count <= 27 && !rest.trim();
}

/** Every :name: in a text that is a real emoji (reaction keys, say). */
export function isEmojiCode(code: string): boolean {
    return /^[a-z0-9_]{1,48}$/.test(code) && byName.has(code);
}
