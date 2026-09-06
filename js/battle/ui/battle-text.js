// ==================== Showdown battle text ====================
// The in-battle messages, taken from Pokémon Showdown's own text data rather
// than written here. Showdown is MIT licensed (c) Guangcong Luo and
// contributors: https://github.com/smogon/pokemon-showdown
//
// Showdown keeps one message per effect per situation, e.g.
//
//     sturdy:    { activate: "  [POKEMON] endured the hit!" }
//     focussash: { activate: "  [POKEMON] hung on using its Focus Sash!" }
//     brn:       { damage:   "  [POKEMON] was hurt by its burn!" }
//
// so a Sturdy activation reads like the game instead of "its effect activated".
// Anything with no entry falls back to whatever the caller had -- this only
// ever replaces generic text, never invents any.
//
// Purely presentational: this never touches battle state.

import { cachedFetch } from '../../core/net-cache.js';
import { toId } from '../../core/html.js';
import { SD_VERSION } from '../engine/sd-facade.js';

// Pinned to the same release the simulator tables come from, so the wording
// always describes the rules actually being run. Text is presentational and
// never touches battle state, so this is about coherence, not determinism.
const BASE = `https://cdn.jsdelivr.net/npm/pokemon-showdown@${SD_VERSION}/dist/data/text/`;
const PARTS = ['default', 'abilities', 'items', 'moves'];
const WEEK = 7 * 86400000;

let textPromise = null;
let TEXT = null;

// Fetched once and cached (about 130 KB gzipped for all four, only on the
// battle tab). Each file is an esbuild CommonJS bundle of plain data, so it is
// run against a stub module rather than imported.
export function loadBattleText() {
    if (TEXT) return Promise.resolve(TEXT);
    textPromise ||= (async () => {
        const parts = await Promise.all(PARTS.map(async name => {
            const res = await cachedFetch(BASE + name + '.js', { maxAgeMs: WEEK });
            if (!res.ok) throw new Error(`${name} ${res.status}`);
            const module = { exports: {} };
            // eslint-disable-next-line no-new-func
            new Function('exports', 'module', 'require', await res.text())(module.exports, module, () => ({}));
            const table = Object.values(module.exports)[0];
            return [name, table && typeof table === 'object' ? table : {}];
        }));
        TEXT = Object.fromEntries(parts);
        return TEXT;
    })().catch(err => {
        textPromise = null;
        console.warn('[BATTLE] Showdown battle text unavailable, using plain wording', err);
        return null;
    });
    return textPromise;
}

export function battleTextLoaded() { return !!TEXT; }

// Looks up one message. `situation` is Showdown's key: activate, start, end,
// block, damage, heal, cant, fail... Returns null when Showdown has nothing to
// say for this effect, so the caller keeps its own wording.
export function effectText(effectName, situation, depth = 0) {
    if (!TEXT || !effectName || depth > 3) return null;
    const id = toId(effectName);
    for (const part of ['abilities', 'items', 'moves', 'default']) {
        const entry = TEXT[part]?.[id];
        const line = entry?.[situation];
        if (typeof line !== 'string') continue;
        // Showdown de-duplicates by pointing one effect at another's wording:
        // `tox: { damage: '#psn' }` means "say what poison says". Following the
        // pointer is the difference between a real sentence and a literal
        // "#psn" in the battle log.
        if (line.startsWith('#')) return effectText(line.slice(1), situation, depth + 1);
        return line;
    }
    return null;
}

// Which of Showdown's tables an effect comes from. The generic fallbacks are
// worded per source -- "hurt by its [ITEM]" vs "[POKEMON] was hurt!" -- so the
// caller has to know which one it is holding.
export function effectKind(effectName) {
    if (!TEXT || !effectName) return null;
    const id = toId(effectName);
    if (TEXT.items?.[id]) return 'item';
    if (TEXT.abilities?.[id]) return 'ability';
    if (TEXT.moves?.[id]) return 'move';
    if (TEXT.default?.[id]) return 'status';
    return null;
}

// "Attack", "Sp. Def", "evasiveness" -- Showdown spells these out rather than
// printing the three-letter key.
export function statName(stat) {
    return TEXT?.default?.[toId(stat)]?.statName || String(stat || '').toUpperCase();
}

// This engine names weather for the player ('Rain'); Showdown files it under
// the move that causes it ('raindance'). Text lookups need the latter.
const WEATHER_TEXT_IDS = { Rain: 'raindance', Sun: 'sunnyday', Sand: 'sandstorm', Hail: 'hail' };
export function weatherTextId(name) { return WEATHER_TEXT_IDS[name] || toId(name); }

// Fills Showdown's placeholders. `[POKEMON]` is deliberately side-aware --
// mainline says "the opposing Pikachu" for the other trainer's Pokémon, and
// default.js carries both forms.
export function fillText(template, vars = {}) {
    if (!template) return null;
    const {
        pokemon, isMine = true, target, source, move, item, ability,
        number, stat, type, effect, trainer, fullname, percentage, isMyTeam = isMine
    } = vars;
    const generic = TEXT?.default?.default;
    // default.js nests its generic wording under a `default` key, alongside the
    // per-status entries (brn, par, ...) that sit at the top level.
    const named = (name, mine) => {
        if (!name) return '';
        const form = mine ? generic?.pokemon : generic?.opposingPokemon;
        return (form || '[NICKNAME]').replace('[NICKNAME]', name);
    };
    // Hazards are laid "around [TEAM]", which Showdown words from the reader's
    // point of view rather than naming the trainer.
    const teamWord = (isMyTeam ? generic?.team : generic?.opposingTeam)
        || (isMyTeam ? 'your team' : 'the opposing team');
    return template
        .replace(/\[POKEMON\]/g, named(pokemon, isMine))
        .replace(/\[TARGET\]/g, named(target, !isMine))
        .replace(/\[SOURCE\]/g, named(source ?? target, !isMine))
        .replace(/\[TEAM\]/g, teamWord)
        .replace(/\[OPPOSING_TEAM\]/g, generic?.opposingTeam || 'the opposing team')
        .replace(/\[TRAINER\]/g, trainer || '')
        .replace(/\[FULLNAME\]/g, fullname || pokemon || '')
        .replace(/\[MOVE\]/g, move || '')
        .replace(/\[ITEM\]/g, item || '')
        .replace(/\[ABILITY\]/g, ability || '')
        .replace(/\[NUMBER\]/g, number ?? '')
        .replace(/\[PERCENTAGE\]/g, percentage || '')
        .replace(/\[STAT\]/g, stat || '')
        .replace(/\[TYPE\]/g, type || '')
        .replace(/\[EFFECT\]/g, effect || move || item || ability || '')
        .trim();
}

// Showdown's own generic wording, used when a specific effect has none of its
// own -- "[POKEMON]'s [ABILITY]", "([POKEMON] used its [ITEM]!)", "It doesn't
// affect [POKEMON]...". Still Showdown's text, just the fallback tier it uses
// itself, and preferred over any wording invented here.
export function genericText(key, vars) {
    const template = TEXT?.default?.default?.[key];
    return template ? fillText(template, vars) : null;
}

// The two together: Showdown's exact line for this effect, or null.
export function situationText(effectName, situation, vars) {
    const template = effectText(effectName, situation);
    return template ? fillText(template, vars) : null;
}
