// ==================== battle log wording ====================
// Turns one protocol entry into the line a player reads. Every sentence here
// is Pokemon Showdown's own, pulled from its text data rather than written
// out -- Showdown is MIT licensed (c) Guangcong Luo and contributors:
//     https://github.com/smogon/pokemon-showdown
//
// Its text data keeps one message per effect per situation --
//
//     leftovers:   { heal:   "[POKEMON] restored a little HP using its Leftovers!" }
//     brn:         { damage: "[POKEMON] was hurt by its burn!" }
//     stealthrock: { damage: "Pointed stones dug into [POKEMON]!" }
//
// -- so the log names what actually happened instead of saying "took damage"
// for all three. The fallback order is Showdown's own: the effect's specific
// line, then the generic template for that KIND of source ("hurt by its
// [ITEM]"), then the bare generic ("[POKEMON] was hurt!"), and only then a
// plain sentence written here, for when the text data could not be fetched.
//
// Pure and presentational: no DOM, no app.js, no battle state. It is handed
// the entry plus two lookups and returns an HTML string.

import { esc, toId } from '../../core/html.js';
import {
    situationText, genericText, effectKind, statName, weatherTextId
} from './battle-text.js';

export function formatLogLine(entry, nameFor, isMine) {
    const [kind, ...rest] = entry;
    const ref = rest[0];
    const who = r => `<span class="${isMine(r) ? 'log-mine' : 'log-foe'}">${esc(nameFor(r))}</span>`;

    // Showdown writes its templates as prose with the Pokemon named inside, so
    // colouring one means escaping the finished sentence and then putting the
    // coloured name back where the plain one stood. `**bold**` is Showdown's
    // own emphasis on move names.
    const paint = (text, r = ref) => {
        if (!text) return null;
        const name = nameFor(r);
        let html = esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        if (name) html = html.split(esc(name)).join(who(r));
        return html;
    };
    const vars = (extra, r) => ({
        pokemon: nameFor(r), isMine: isMine(r), isMyTeam: isMine(r), ...extra
    });
    // The effect's own line for this situation.
    const sd = (effect, situation, extra = {}, r = ref) =>
        paint(situationText(effect, situation, vars(extra, r)), r);
    // Showdown's generic template, the tier it falls back to itself.
    const gen = (key, extra = {}, r = ref) => paint(genericText(key, vars(extra, r)), r);
    const div = (cls, html, tail = '') => html ? `<div class="${cls}">${html}${tail}</div>` : '';
    const hpTail = () => ` <small>(${rest[1]}/${rest[2]})</small>`;
    const percentOf = (amount, max) => {
        const n = Math.round((Number(amount) / Number(max)) * 100);
        return Number.isFinite(n) && n > 0 ? `${n}%` : null;
    };

    // An effect is named differently depending on where it came from, so the
    // right generic template depends on which table Showdown files it under.
    const bySource = (name, { item, ability, move, plain }) => {
        switch (effectKind(name)) {
            case 'item': return item ? gen(item, { item: name }) : null;
            case 'ability': return ability ? gen(ability, { ability: name }) : null;
            case 'move': return move ? gen(move, { move: name, effect: name }) : null;
            default: return plain ? gen(plain) : null;
        }
    };
    // Berries are eaten, everything else is simply lost -- Showdown words them
    // differently and both templates are in its default table.
    const isBerry = name => /\bBerry$/i.test(String(name || ''));

    switch (kind) {
        case 'turn': return `<div class="battle-log-turn">Turn ${rest[0]}</div>`;

        case 'move':
            return div('', gen('move', { move: rest[1] })
                ?? `${who(ref)} used <strong>${esc(rest[1])}</strong>!`);

        // "Go! Aquari!" for your own, "Bob sent out Terrak!" for theirs -- the
        // same split Showdown makes.
        case 'switch':
            return div('', (isMine(ref)
                ? gen('switchInOwn', { fullname: nameFor(ref) })
                : gen('switchIn', { fullname: nameFor(ref), trainer: rest[3] || '' }))
                ?? `${who(ref)} was sent out.`);

        // "was hurt by its burn", "buffeted by the sandstorm", "pointed stones
        // dug into it" -- one sentence per source, all of them Showdown's.
        case '-damage': {
            const why = rest[3];
            const specific = (why && sd(why, 'damage', { item: why, move: why, ability: why }))
                ?? bySource(why, { item: 'damageFromItem' });
            if (specific) return div('log-dmg', specific, hpTail());
            // An ordinary hit needs no sentence of its own -- "Aquari used
            // Scald!" already said it -- so this reports the size of it the way
            // Showdown does, and drops the redundant fraction.
            const pct = percentOf(rest[4], rest[2]);
            return div('log-dmg',
                (pct && gen('damagePercentage', { percentage: pct })) ?? gen('damage')
                ?? `${who(ref)} took damage.`, pct ? '' : hpTail());
        }

        case '-heal': {
            const why = rest[3];
            const line = (why && sd(why, 'heal', { item: why, move: why, ability: why }))
                ?? bySource(why, {
                    item: 'healFromEffect', ability: 'healFromEffect',
                    move: 'healFromEffect', plain: 'heal'
                })
                ?? gen('heal')
                ?? `${who(ref)} recovered HP.`;
            return div('log-heal', line, hpTail());
        }

        case '-crit': return div('log-crit', gen('crit') ?? 'A critical hit!');
        case '-supereffective': return div('log-super', gen('superEffective') ?? "It's super effective!");
        case '-resisted': return div('log-weak', gen('resisted') ?? "It's not very effective…");

        case '-immune':
            return div('log-weak', sd(rest[1], 'block') ?? gen('immune')
                ?? `It had no effect on ${who(ref)}.`);

        // Showdown names the Pokemon that DODGED, which is the second ref here.
        case '-miss':
            return div('log-weak', gen('miss', {}, rest[1] || ref)
                ?? `${who(rest[1] || ref)} avoided the attack!`);

        // Two-turn moves each have their own line -- "burrowed its way under
        // the ground!", "flew up high!", "absorbed light!".
        case '-prepare':
            return div('', sd(rest[1], 'prepare', { move: rest[1] })
                ?? `${who(ref)} is charging <strong>${esc(rest[1])}</strong>!`);

        // Showdown words each status individually, and differently again when
        // an item or Rest caused it.
        case '-status': {
            const why = rest[2];
            const situation = toId(why) === 'rest' ? 'startFromRest'
                : effectKind(why) === 'item' ? 'startFromItem' : 'start';
            return div('log-status',
                sd(rest[1], situation, { item: why, move: why })
                ?? sd(rest[1], 'start')
                ?? `${who(ref)} was afflicted with ${esc(rest[1]).toUpperCase()}.`);
        }

        case '-curestatus': {
            const why = rest[2];
            const situation = effectKind(why) === 'item' ? 'endFromItem'
                : effectKind(why) === 'move' ? 'endFromMove' : 'end';
            return div('log-heal',
                sd(rest[1], situation, { item: why, move: why })
                ?? sd(rest[1], 'end')
                ?? `${who(ref)} recovered from ${esc(rest[1]).toUpperCase()}.`);
        }

        // "rose", "rose sharply", "rose drastically" -- the size of the change
        // is part of the wording, and an item that caused it is named.
        case '-boost':
        case '-unboost': {
            const up = kind === '-boost';
            const size = Math.min(3, Math.max(1, Number(rest[2]) || 1));
            const why = rest[3];
            const stat = statName(rest[1]);
            const base = up ? 'boost' : 'unboost';
            const suffix = size > 1 ? String(size) : '';
            const key = effectKind(why) === 'item' ? `${base}${suffix}FromItem` : `${base}${suffix}`;
            return div(up ? 'log-boost' : 'log-unboost',
                gen(key, { stat, item: why })
                ?? gen(`${base}${suffix}`, { stat })
                ?? `${who(ref)}'s ${esc(stat)} ${up ? 'rose' : 'fell'}!`);
        }

        // A stat that cannot move any further has its own line.
        case '-boostfail':
            return div('log-weak',
                gen(rest[2] === 'up' ? 'boost0' : 'unboost0', { stat: statName(rest[1]) })
                ?? `${who(ref)}'s ${esc(statName(rest[1]))} won't go any ${rest[2] === 'up' ? 'higher' : 'lower'}!`);

        case '-clearboost':
            return div('log-boost', gen('clearBoost') ?? `${who(ref)}'s stat changes were removed!`);

        // The weather entry carries the weather that ENDED when it clears, so
        // the log can say "the rain stopped" instead of "the weather cleared".
        case '-weather': {
            if (rest[0] === 'none') {
                return div('log-field', rest[1]
                    ? (sd(weatherTextId(rest[1]), 'end') ?? 'The weather cleared.')
                    : 'The weather cleared.');
            }
            return div('log-field', sd(weatherTextId(rest[0]), 'start')
                ?? `The weather turned to ${esc(rest[0])}.`);
        }

        case '-fieldstart':
            return div('log-field', sd(rest[0], 'start') ?? `${esc(rest[0])} covered the field.`);
        case '-fieldend':
            return div('log-field', sd(rest[0], 'end') ?? `${esc(rest[0])} faded from the field.`);

        // Hazards are laid "around your team" / "around the opposing team".
        case '-sidestart':
            return div('log-field', sd(rest[1], 'start') ?? `${esc(rest[1])} was set up.`);
        case '-sideend':
            return div('log-field', sd(rest[1], 'end') ?? `${esc(rest[1])} disappeared.`);

        case '-start':
            return div('log-ability', sd(rest[1], 'start', { effect: rest[1], move: rest[1] })
                ?? gen('start', { effect: rest[1] })
                ?? `${who(ref)} started ${esc(rest[1])}.`);
        case '-end':
            return div('log-ability', sd(rest[1], 'end', { effect: rest[1], move: rest[1] })
                ?? gen('end', { effect: rest[1] })
                ?? `${who(ref)} was freed from ${esc(rest[1])}.`);

        case '-ability':
            return div('log-ability', sd(rest[1], 'activate', { ability: rest[1] })
                ?? gen('abilityActivation', { ability: rest[1] })
                ?? `${who(ref)}'s ${esc(rest[1])}!`);

        // A consumed item is Showdown's `end` situation -- that is where Focus
        // Sash keeps "hung on using its Focus Sash!".
        case '-enditem':
            return div('log-ability', sd(rest[1], 'end', { item: rest[1] })
                ?? gen(isBerry(rest[1]) ? 'eatItem' : 'removeItem', { item: rest[1] })
                ?? `${who(ref)}'s ${esc(rest[1])} activated!`);

        // Some effects word being triggered as `activate`, others as `block`
        // (Protect keeps "[POKEMON] protected itself!" under the latter).
        case '-activate':
            return div('log-ability', sd(rest[1], 'activate', {
                move: rest[1], item: rest[1], ability: rest[1], effect: rest[1]
            }) ?? sd(rest[1], 'block', { move: rest[1], effect: rest[1] })
                ?? gen('activate', { effect: rest[1] })
                ?? `${who(ref)}'s ${esc(rest[1] || 'effect')} activated!`);

        case '-hitcount': {
            const n = Number(rest[1]) || 0;
            return div('', gen(n === 1 ? 'hitCountSingular' : 'hitCount', { number: n })
                ?? `Hit ${n} times!`);
        }

        case '-fail':
            return div('log-weak', sd(rest[1], 'fail', { move: rest[1] })
                ?? gen('fail') ?? 'But it failed!');

        case '-message': return div('log-ability', esc(rest[0]));
        case 'faint': return div('log-faint', gen('faint') ?? `${who(ref)} fainted!`);

        case 'cant':
            return div('log-weak', sd(rest[1], 'cant', { move: rest[1] })
                ?? gen('cantNoMove') ?? `${who(ref)} couldn't move!`);

        case 'win': return `<div class="battle-log-turn">${esc(rest[0])} won the battle!</div>`;
        default: return '';
    }
}
