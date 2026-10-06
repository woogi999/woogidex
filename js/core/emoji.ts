// Custom emojis, Discord style: type :tatsuorange: and it shows as the picture.
// Standard emojis (further down) are drawn as Apple's pictures everywhere.
//
// The pictures live in public/emojis and ship with the site; the list of them
// is built from the file names when the site is built (vite.config.js,
// emojiManifest). Text everywhere only ever stores the ":name:" code, and each
// picture is a static file the browser downloads once and then caches, so an
// emoji costs a few bytes in the database and nothing on repeat views.

import EMOJIS from 'virtual:emoji-manifest';
import { fuzzyScore, fuzzySearch, normalizeTerm, type FuzzyTerm } from './fuzzy.ts';

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

const customTerms = new Map<Emoji, FuzzyTerm[]>(EMOJIS.map(e => [e, [
    { text: normalizeTerm(e.name), weight: 1 },
    { text: normalizeTerm(CATEGORY_LABELS[e.category] || e.category), weight: 0.5 }
]]));

/**
 * Our emojis that match the query, best first, forgiving typos (js/core/fuzzy.ts).
 * What the ":ta" autocomplete and the picker's search box show.
 */
/** How well one of ours fits a query (0 if it doesn't), to rank it among the standard ones. */
export function scoreEmoji(e: Emoji, query: string): number {
    return fuzzyScore(String(query || '').replace(/^:|:$/g, ''), customTerms.get(e) || []);
}

export function searchEmojis(query: string, limit = 50): Emoji[] {
    const q = String(query || '').toLowerCase().replace(/^:|:$/g, '');
    if (!q) return EMOJIS.slice(0, limit);
    return fuzzySearch(q, EMOJIS, e => customTerms.get(e)!, limit);
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
// would draw: every emoji iOS 26.4 has (Emoji 17.0, skin tones included),
// from iamcal/emoji-data (the image set Slack and many chat apps use) on
// jsDelivr. The URL is pinned to one commit, so it never changes and
// browsers keep each picture for a year. A picture that fails to load turns
// back into the plain character. Typing :sob: (Discord's names for them)
// puts in the character, :thumbsup_tone2: a skin tone.

export interface UnicodeEmoji {
    key: string; char: string; name: string;
    /** Discord shortcodes, the first is the main one */
    codes: string[];
    /** synonyms for search ("sad" for 😭) */
    keywords: string[];
    /** the five one-tone versions, light to dark, for those that have them */
    tones: UnicodeEmoji[] | null;
    /** a toned version's plain emoji, and which tone (1-5) */
    base?: UnicodeEmoji; tone?: number;
}

const APPLE_CDN = 'https://cdn.jsdelivr.net/gh/iamcal/emoji-data@13ee711e222ea17fe537bfea953c687866f16411/img-apple-64/';

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
const PICTOGRAPH = /\p{Extended_Pictographic}|[#*0-9]/u;
const isTone = (c: number) => c >= 0x1f3fb && c <= 0x1f3ff;
// from U+1F90C up everything draws as an emoji, including what's newer than
// the browser's own Unicode tables (orca, Emoji 17)
const presents = (c: number) => c >= 0x1f90c || PRESENTS_AS_EMOJI.test(String.fromCodePoint(c));

/**
 * An emoji's fully qualified codepoints however it was typed: an FE0F after
 * every codepoint that would otherwise draw as text, unless a skin tone
 * follows it. The picture files are named this way (checked against all
 * 3,946 of them), and it's the reaction key's form too.
 */
function qualified(char: string): number[] {
    const cps = [...char].map(c => c.codePointAt(0)!).filter(c => c !== 0xfe0f);
    const out: number[] = [];
    cps.forEach((c, i) => {
        out.push(c);
        if (c === 0x200d || c === 0x20e3 || (c >= 0xe0020 && c <= 0xe007f) || isTone(c) || presents(c)) return;
        if (i + 1 < cps.length && isTone(cps[i + 1])) return;
        if (PICTOGRAPH.test(String.fromCodePoint(c))) out.push(0xfe0f);
    });
    return out;
}

/** The Apple picture for an emoji however it was typed. */
export function appleEmojiUrl(char: string): string {
    return APPLE_CDN + qualified(char).map(c => c.toString(16).padStart(4, '0')).join('-') + '.png';
}

/**
 * One standard emoji in text: a flag, a keycap, or a pictograph (with its
 * skin tone, ZWJ family members or tag letters). A symbol that reads as text
 * by default (© ™ ↔) only counts when it carries FE0F, so plain text stays text.
 */
const UNICODE_EMOJI_RE = new RegExp(
    '\\p{Regional_Indicator}{2}' +
    '|[#*0-9]\\uFE0F?\\u20E3' +
    '|(?:\\p{Emoji_Presentation}|[\\u{1F90C}-\\u{1FAFF}]|\\p{Extended_Pictographic}(?:\\uFE0F|(?=[\\u{1F3FB}-\\u{1F3FF}])))\\uFE0F?[\\u{1F3FB}-\\u{1F3FF}]?[\\u{E0020}-\\u{E007E}]*\\u{E007F}?' +
    '(?:\\u200D\\p{Extended_Pictographic}\\uFE0F?[\\u{1F3FB}-\\u{1F3FF}]?)*',
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

// ---- skin tone ----
// One tone for every emoji that has them, chosen in the picker and kept on
// this device: 0 is the plain yellow, 1-5 light to dark.

const TONE_KEY = 'woogidex.emoji.tone.v1';
export const SKIN_TONES = ['', '1f3fb', '1f3fc', '1f3fd', '1f3fe', '1f3ff'];

export function skinTone(): number {
    try { const n = Number(localStorage.getItem(TONE_KEY)); return n >= 1 && n <= 5 ? n : 0; } catch { return 0; }
}

export function setSkinTone(n: number) {
    try { localStorage.setItem(TONE_KEY, String(n >= 1 && n <= 5 ? n : 0)); } catch { /* private mode */ }
}

/** The emoji in a skin tone (its plain self for 0, or when it has no tones). */
export function withTone(e: UnicodeEmoji, tone = skinTone()): UnicodeEmoji {
    const plain = e.base || e;
    return tone && plain.tones ? plain.tones[tone - 1] : plain;
}

// ---- the list ----

let unicodeGroups: Promise<Array<{ label: string; emojis: UnicodeEmoji[] }>> | null = null;
let byCode: Map<string, UnicodeEmoji> | null = null;
let allPlain: UnicodeEmoji[] = [];
const termsOf = new Map<UnicodeEmoji, FuzzyTerm[]>();

/** The standard emojis by group; ~60 KB zipped, so only fetched once a picker or text box wants them. */
export function loadUnicodeEmoji() {
    return unicodeGroups ||= import('./emoji-unicode-data.ts').then(m => {
        const codes = new Map<string, UnicodeEmoji>();
        const groups = m.UNICODE_EMOJI.map(([label, list]) => ({
            label,
            emojis: list.split('|').map((entry): UnicodeEmoji => {
                const [hex, codeList, name, keywords, tones] = entry.split(';');
                const key = 'u_' + hex;
                const e: UnicodeEmoji = { key, char: unicodeChar(key), name, codes: codeList ? codeList.split(',') : [], keywords: keywords ? keywords.split(',') : [], tones: null };
                if (tones) {
                    // "t": the tone right after the first codepoint; else the five keys
                    const keys = tones === 't'
                        ? SKIN_TONES.slice(1).map(t => { const parts = hex.split('_').filter(x => x !== 'fe0f'); return 'u_' + qualified(String.fromCodePoint(...[parts[0], t, ...parts.slice(1)].map(h => parseInt(h, 16)))).map(c => c.toString(16)).join('_'); })
                        : tones.split(',').map(k => 'u_' + k);
                    e.tones = keys.map((k, i) => ({
                        key: k, char: unicodeChar(k), name: e.name, keywords: e.keywords, tones: null, base: e, tone: i + 1,
                        // Discord's names for them: thumbsup_tone2
                        codes: e.codes.map(c => `${c}_tone${i + 1}`)
                    }));
                }
                return e;
            })
        }));
        for (const g of groups) for (const e of g.emojis) {
            for (const c of e.codes) if (!codes.has(c)) codes.set(c, e);
            for (const t of e.tones || []) for (const c of t.codes) if (!codes.has(c)) codes.set(c, t);
            termsOf.set(e, [
                ...e.codes.map(c => ({ text: normalizeTerm(c), weight: 1 })),
                { text: normalizeTerm(e.name), weight: 0.95 },
                // synonyms come most relevant first, so the earlier ones weigh a little more
                ...e.keywords.map((k, i) => ({ text: normalizeTerm(k), weight: 0.85 - Math.min(i, 10) * 0.01 }))
            ]);
        }
        allPlain = groups.flatMap(g => g.emojis);
        byCode = codes;
        return groups;
    });
}

/** A standard emoji by its Discord shortcode ("sob", "thumbsup_tone2"), once loadUnicodeEmoji has finished. */
export function unicodeByCode(code: string): UnicodeEmoji | null {
    return byCode?.get(String(code || '').toLowerCase()) || null;
}

/** An emoji's search terms: shortcodes, name, synonyms (for the plain one, toned or not). */
export function unicodeTerms(e: UnicodeEmoji): FuzzyTerm[] {
    return termsOf.get(e.base || e) || [];
}

/**
 * Standard emojis for a query, best first: by shortcode, name or synonym,
 * forgiving typos (js/core/fuzzy.ts). `code` is the shortcode to show for
 * it, the one that matched when one did. None until loadUnicodeEmoji is done.
 */
export function searchUnicodeEmojis(query: string, limit = 50, min = 1): Array<{ code: string; emoji: UnicodeEmoji; score: number }> {
    const q = String(query || '').toLowerCase().replace(/^:|:$/g, '');
    if (!byCode || !q) return [];
    // "thumbsup_tone2" asks for that tone
    const toned = /^(.+)_tone([1-5])$/.exec(q);
    const tone = toned ? Number(toned[2]) : skinTone();
    const find = toned ? toned[1] : q;
    const scored: Array<{ code: string; emoji: UnicodeEmoji; score: number; i: number }> = [];
    allPlain.forEach((e, i) => {
        const score = fuzzyScore(find, termsOf.get(e) || []);
        if (score < min) return;
        const shown = withTone(e, tone);
        const code = e.codes.find(c => c.startsWith(find)) || e.codes[0] || '';
        scored.push({ code: code && shown.tone ? `${code}_tone${shown.tone}` : code, emoji: shown, score, i });
    });
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored.slice(0, limit).map(({ code, emoji, score }) => ({ code, emoji, score }));
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
