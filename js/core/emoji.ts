// Custom emojis, Discord style: type :tatsuorange: and it shows as the picture.
// Standard emojis (further down) are drawn as Apple's pictures everywhere.
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
    // ours first; their pictures' markup holds no emoji characters, so the
    // standard ones (Apple pictures) can go after
    return appleifyText(escapedHtml.replace(SHORTCODE, (whole, name) => {
        const e = byName.get(name);
        if (!e) return whole;
        return `<img class="emoji${jumbo ? ' emoji-jumbo' : ''}" src="${e.src}" alt=":${e.name}:" title=":${e.name}:" draggable="false" loading="lazy" decoding="async">`;
    }), jumbo);
}

/** Whether the text is only emojis (ours or standard, and spaces), at most 27 of them, the way Discord enlarges them. */
export function isEmojiOnly(text: string, max = 27): boolean {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    let count = 0;
    const rest = trimmed.replace(SHORTCODE, (whole, name) => {
        if (!byName.has(name)) return whole;
        count++;
        return '';
    }).replace(UNICODE_EMOJI_RE, () => { count++; return ''; });
    return count > 0 && count <= max && !rest.trim();
}

/** Every :name: in a text that is a real emoji (reaction keys, say). */
export function isEmojiCode(code: string): boolean {
    return /^[a-z0-9_]{1,48}$/.test(code) && byName.has(code);
}

// ==================== standard emojis ====================
// The everyday ones (😀 👍 ❤️), next to our own in the picker. In text they
// go in as the character itself. As a reaction they're stored as "u_" plus
// their codepoints in hex ("u_1f44d"), which fits the same key format as our
// names, so posts, Fakémon and comments take them with no schema change.
//
// Everyone sees Apple's artwork for them, whatever their phone or computer
// would draw: the pictures come from emoji-datasource-apple (the image set
// Slack and many chat apps use) on jsDelivr's npm CDN. The URL is pinned to
// one version, so it never changes and browsers keep each picture for a
// year. A picture that fails to load turns back into the plain character.
// Typing :sob: (Discord's names for them) puts in the character.

export interface UnicodeEmoji { key: string; char: string; name: string; codes: string[]; }

const APPLE_CDN = 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64/';

/** Whether a reaction key is a standard emoji rather than one of ours. */
export function isUnicodeKey(key: string): boolean {
    return /^u_[0-9a-f]{2,6}(_[0-9a-f]{2,6})*$/.test(String(key || ''));
}

/** The character a "u_..." key stands for. */
export function unicodeChar(key: string): string {
    try { return String.fromCodePoint(...key.slice(2).split('_').map(h => parseInt(h, 16))); }
    catch { return ''; }
}

const PRESENTS_AS_EMOJI = /\p{Emoji_Presentation}/u;
const SKIN_TONE = /\p{Emoji_Modifier}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}|[#*0-9]/u;

/**
 * The Apple picture for an emoji however it was typed. The files are named
 * by the fully qualified sequence: an FE0F after every codepoint that would
 * otherwise draw as text, unless a skin tone follows it (checked against all
 * 3,783 files in the set).
 */
export function appleEmojiUrl(char: string): string {
    const cps = [...char].map(c => c.codePointAt(0)!).filter(c => c !== 0xfe0f);
    const out: number[] = [];
    cps.forEach((c, i) => {
        out.push(c);
        const ch = String.fromCodePoint(c);
        if (c === 0x200d || c === 0x20e3 || (c >= 0xe0020 && c <= 0xe007f) || SKIN_TONE.test(ch) || PRESENTS_AS_EMOJI.test(ch)) return;
        if (i + 1 < cps.length && SKIN_TONE.test(String.fromCodePoint(cps[i + 1]))) return;
        if (PICTOGRAPH.test(ch)) out.push(0xfe0f);
    });
    return APPLE_CDN + out.map(c => c.toString(16).padStart(4, '0')).join('-') + '.png';
}

/**
 * One standard emoji in text: a flag, a keycap, or a pictograph (with its
 * skin tone, ZWJ family members or tag letters). A symbol that reads as text
 * by default (© ™ ↔) only counts when it carries FE0F, so plain text stays text.
 */
const UNICODE_EMOJI_RE = new RegExp(
    '\\p{Regional_Indicator}{2}' +
    '|[#*0-9]\\uFE0F?\\u20E3' +
    '|(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}(?:\\uFE0F|(?=\\p{Emoji_Modifier})))\\p{Emoji_Modifier}?[\\u{E0020}-\\u{E007E}]*\\u{E007F}?' +
    '(?:\\u200D\\p{Extended_Pictographic}\\uFE0F?\\p{Emoji_Modifier}?)*',
    'gu'
);

/** Swaps every standard emoji in escaped text (no tags with emojis in them) for its Apple picture. */
function appleifyText(text: string, jumbo: boolean): string {
    return text.replace(UNICODE_EMOJI_RE, ch =>
        `<img class="emoji emoji-apple${jumbo ? ' emoji-jumbo' : ''}" src="${appleEmojiUrl(ch)}" alt="${ch}" draggable="false" loading="lazy" decoding="async">`);
}

// a picture that won't load (offline, an emoji newer than the set) shows
// the character instead
if (typeof document !== 'undefined') {
    document.addEventListener('error', e => {
        const img = e.target;
        if (!(img instanceof HTMLImageElement) || !img.classList.contains('emoji-apple')) return;
        const span = document.createElement('span');
        span.className = 'emoji-char';
        span.textContent = img.alt;
        img.replaceWith(span);
    }, true);
}

let unicodeGroups: Promise<Array<{ label: string; emojis: UnicodeEmoji[] }>> | null = null;
let byCode: Map<string, UnicodeEmoji> | null = null;

/** The standard emojis by group; ~75 KB, so only fetched once a picker or text box wants them. */
export function loadUnicodeEmoji() {
    return unicodeGroups ||= import('./emoji-unicode-data.ts').then(m => {
        const groups = m.UNICODE_EMOJI.map(([label, list]) => ({
            label,
            emojis: list.split('|').map((entry): UnicodeEmoji => {
                const [hex, codes, ...name] = entry.split(' ');
                const key = 'u_' + hex;
                return { key, char: unicodeChar(key), name: name.join(' '), codes: codes.split(',') };
            })
        }));
        const codes = new Map<string, UnicodeEmoji>();
        for (const g of groups) for (const e of g.emojis) for (const c of e.codes) if (!codes.has(c)) codes.set(c, e);
        byCode = codes;
        return groups;
    });
}

/** A standard emoji by its Discord shortcode ("sob"), once loadUnicodeEmoji has finished. */
export function unicodeByCode(code: string): UnicodeEmoji | null {
    return byCode?.get(String(code || '').toLowerCase()) || null;
}

/** Standard emojis whose shortcode starts with (then contains) the query; none until loaded. */
export function searchUnicodeEmojis(query: string, limit = 50): Array<{ code: string; emoji: UnicodeEmoji }> {
    const q = String(query || '').toLowerCase().replace(/^:|:$/g, '');
    if (!byCode || !q) return [];
    const starts: Array<{ code: string; emoji: UnicodeEmoji }> = [];
    const contains: Array<{ code: string; emoji: UnicodeEmoji }> = [];
    const seen = new Set<UnicodeEmoji>();
    for (const [code, emoji] of byCode) {
        if (code.startsWith(q) && !seen.has(emoji)) { seen.add(emoji); starts.push({ code, emoji }); }
    }
    for (const [code, emoji] of byCode) {
        if (code.includes(q) && !seen.has(emoji)) { seen.add(emoji); contains.push({ code, emoji }); }
    }
    starts.sort((a, b) => a.code.length - b.code.length);
    return [...starts, ...contains].slice(0, limit);
}

/**
 * Turns every complete ":sob:" in a text into its character, the way Discord
 * does as you type; our own emojis' codes win and stay as they are. The caret
 * comes back moved by however much the text before it shrank.
 */
export function replaceShortcodes(text: string, caret: number): { text: string; caret: number } {
    if (!byCode || !text.includes(':')) return { text, caret };
    let shift = 0;
    const out = text.replace(/:([a-z0-9_+\-]{1,48}):/gi, (whole: string, code: string, at: number) => {
        if (byName.has(code.toLowerCase())) return whole;
        const e = unicodeByCode(code);
        if (!e) return whole;
        if (at + whole.length <= caret) shift += whole.length - e.char.length;
        return e.char;
    });
    return { text: out, caret: caret - shift };
}
