// ==================== region analytics ====================
// Region details' sibling page: what a region's roster looks like as data.
// Basics first (how many, which types, how strong), then the numbers a
// competitive designer reaches for (stat spreads, roles, speed tiers, the
// region's shared weaknesses, STAB coverage, how evenly the types are spread).
// Pure reads of the collection; nothing here writes.

import { state, api } from '../core/app.js';
import { esc } from '../core/html.js';

const STATS = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];

// ---- turning Fakemon and main-game Pokemon into one shape ----
function parseNumber(text) {
    const m = String(text || '').match(/[\d.]+/);
    return m ? Number(m[0]) : null;
}
function toMeters(text) {
    const n = parseNumber(text);
    if (n === null) return null;
    return /ft|'/.test(String(text)) ? n * 0.3048 : n;
}
function toKg(text) {
    const n = parseNumber(text);
    if (n === null) return null;
    return /lb/.test(String(text)) ? n * 0.4536 : n;
}

function fromFakemon(f) {
    const stats = Object.fromEntries(STATS.map(([k]) => [k, Number(f.stats?.[k]) || 0]));
    const eggs = Array.isArray(f.eggGroups) ? f.eggGroups : String(f.eggGroups || '').split(/[,/]/).map(s => s.trim()).filter(Boolean);
    return {
        name: f.name || 'Unnamed', source: 'fakemon',
        types: [f.type1, f.type2].filter(Boolean),
        stats, bst: STATS.reduce((sum, [k]) => sum + stats[k], 0),
        abilities: (f.abilities || []).map(a => a?.name).filter(Boolean),
        moves: (f.learnset || []).map(m => m?.name).filter(Boolean),
        height: toMeters(f.height), weight: toKg(f.weight),
        color: f.color || '', eggGroups: eggs.filter(e => e !== 'None'),
        male: f.genderRatio === undefined || f.genderRatio === null ? null : Number(f.genderRatio)
    };
}

function fromVanilla(p) {
    const s = p.stats || {};
    const stats = Object.fromEntries(STATS.map(([k]) => [k, Number(s[k]) || 0]));
    return {
        name: p.name, source: 'vanilla',
        types: p.types || [], stats, bst: STATS.reduce((sum, [k]) => sum + stats[k], 0),
        abilities: Object.values(p.abilities || {}), moves: [],
        height: p.heightm || null, weight: p.weightkg || null,
        color: p.color || '', eggGroups: p.eggGroups || [], male: p.genderPct
    };
}

// ---- small helpers ----
const sum = xs => xs.reduce((a, b) => a + b, 0);
const mean = xs => (xs.length ? sum(xs) / xs.length : 0);
function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stdev(xs) {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(sum(xs.map(x => (x - m) ** 2)) / (xs.length - 1));
}
function countBy(items) {
    const map = new Map();
    for (const it of items) map.set(it, (map.get(it) || 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}
const round = (n, d = 0) => Number(n.toFixed(d)).toLocaleString();
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

// a stat-block role, from how the stats are shared out
function roleOf(m) {
    const { hp, atk, def, spa, spd, spe } = m.stats;
    const offense = Math.max(atk, spa);
    const bulk = (hp + def + spd) / 3;
    if (spe >= 100 && offense >= 100) return atk >= spa + 15 ? 'Fast physical attacker' : spa >= atk + 15 ? 'Fast special attacker' : 'Fast mixed attacker';
    if (offense >= 100 && offense > bulk) return atk >= spa + 15 ? 'Physical attacker' : spa >= atk + 15 ? 'Special attacker' : 'Mixed attacker';
    if (bulk >= 90 && def >= spd + 20) return 'Physical wall';
    if (bulk >= 90 && spd >= def + 20) return 'Special wall';
    if (bulk >= 85) return 'Bulky';
    if (spe >= 100) return 'Fast support';
    return 'Balanced';
}

// ---- markup pieces ----
function barRows(rows, { max = null, unit = '', color = null } = {}) {
    const top = max ?? Math.max(1, ...rows.map(r => r.value));
    return `<div class="an-bars">${rows.map(r => `
        <div class="an-bar-row">
            <span class="an-bar-label">${r.label}</span>
            <span class="an-bar-track"><span class="an-bar-fill${r.cls ? ` ${r.cls}` : ''}" style="width:${Math.max(2, (r.value / top) * 100)}%${color ? `;background:${color}` : ''}"></span></span>
            <span class="an-bar-value">${r.text ?? `${round(r.value, r.value % 1 ? 1 : 0)}${unit}`}</span>
        </div>`).join('')}</div>`;
}

function statCard(label, value, sub = '') {
    return `<div class="an-stat"><span class="an-stat-label">${esc(label)}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ''}</div>`;
}

function section(title, help, body, wide = false) {
    return `<section class="an-card${wide ? ' an-wide' : ''}"><header><h3>${esc(title)}</h3>${help ? `<p>${help}</p>` : ''}</header>${body}</section>`;
}

const typeBadge = t => `<span class="type-badge type-${esc(String(t).toLowerCase())}">${esc(t)}</span>`;

// ---- moves, abilities, items and types ----
// Everything the region has to work with: its own entries (and its own
// versions of main-game ones) plus the main-game ones it brings over.
function regionLibrary(region, kind) {
    const mine = (state[kind] || []).filter(x => !x.pendingVanilla && api.entryInRegion(x, region.id));
    const copied = new Set(mine.map(x => x.vanillaId).filter(Boolean));
    const poolKind = kind === 'customMoves' ? 'moves' : kind === 'customAbilities' ? 'abilities' : 'items';
    const source = { moves: state.sdMoves, abilities: state.sdAbilities, items: state.sdItems }[poolKind] || {};
    const vanilla = (api.regionPoolIds?.(region, poolKind) || []).filter(id => source[id] && !copied.has(id)).map(id => source[id]);
    return { mine, vanilla, all: [...mine, ...vanilla] };
}

function contentHtml(region, mons, own, matchup, allTypes) {
    const moves = regionLibrary(region, 'customMoves');
    const abilities = regionLibrary(region, 'customAbilities');
    const items = regionLibrary(region, 'customItems');
    const custom = moves.mine.filter(m => !m.vanillaId).length;
    const edited = moves.mine.filter(m => m.vanillaId).length;

    // --- moves ---
    const cats = countBy(moves.all.map(m => m.category || 'Status'));
    const damaging = moves.all.filter(m => (m.category || 'Status') !== 'Status' && Number(m.basePower) > 0);
    const bps = damaging.map(m => Number(m.basePower));
    const moveTypes = countBy(moves.all.map(m => m.type || 'Normal'));
    const priority = moves.all.filter(m => Number(m.priority) > 0).length;
    const inaccurate = damaging.filter(m => m.accuracy !== true && Number(m.accuracy) < 100).length;
    // types the region's Pokemon have, but no damaging move of that type to use for STAB
    const monTypes = [...new Set(mons.flatMap(m => m.types))];
    const damagingTypes = new Set(damaging.map(m => m.type));
    const noStab = monTypes.filter(t => !damagingTypes.has(t));
    const learned = new Set(own.flatMap(m => m.moves));
    const unusedCustom = moves.mine.filter(m => !m.vanillaId && !learned.has(m.name));
    const movesOverview = `<div class="an-stats an-stats-small">
        ${statCard('Moves', moves.all.length, `${custom} custom · ${edited} edited · ${moves.vanilla.length} main games`)}
        ${statCard('Average power', bps.length ? round(mean(bps)) : '—', bps.length ? `median ${round(median(bps))} · top ${Math.max(...bps)}` : 'no damaging moves')}
        ${statCard('Priority moves', priority, `${inaccurate} damaging moves under 100% accuracy`)}
    </div>`;
    const movesSec = section('Moves', 'What the region\'s Pokémon have to fight with.',
        movesOverview + `<div class="an-split">
            <div><h4 class="an-sub">Physical, special and status</h4>${barRows(cats.map(([label, value]) => ({ label: esc(label), value })))}</div>
            <div><h4 class="an-sub">By type</h4>${barRows(moveTypes.slice(0, 8).map(([label, value]) => ({ label: typeBadge(label), value, cls: `type-${esc(String(label).toLowerCase())}` })))}</div>
        </div>
        <div class="an-notes">
            ${noStab.length ? `<p><strong>No damaging move to match their type:</strong> ${noStab.map(typeBadge).join(' ')}</p>` : '<p>Every type your Pokémon have has at least one damaging move.</p>'}
            ${unusedCustom.length ? `<p><strong>Custom moves no Fakémon learns yet:</strong> ${unusedCustom.slice(0, 10).map(m => esc(m.name)).join(', ')}${unusedCustom.length > 10 ? ` and ${unusedCustom.length - 10} more` : ''}</p>` : ''}
        </div>`, true);

    // --- abilities ---
    const abilityUsers = new Map();
    mons.forEach(m => m.abilities.forEach(a => abilityUsers.set(a, (abilityUsers.get(a) || 0) + 1)));
    const customAbilities = abilities.mine;
    const usedCustom = customAbilities.filter(a => abilityUsers.has(a.name));
    const withCustom = own.filter(m => m.abilities.some(a => customAbilities.some(c => c.name === a))).length;
    const abilitiesSec = section('Abilities', '',
        `<div class="an-stats an-stats-small">
            ${statCard('Abilities', abilities.all.length, `${customAbilities.length} yours · ${abilities.vanilla.length} main games`)}
            ${statCard('Custom ones in use', `${usedCustom.length} of ${customAbilities.length}`, customAbilities.length ? `${pct(withCustom, own.length)}% of your Fakémon have one` : '')}
        </div>
        ${customAbilities.length ? barRows(customAbilities.map(a => ({ label: esc(a.name), value: abilityUsers.get(a.name) || 0 })).sort((x, y) => y.value - x.value).slice(0, 8)) : '<p class="an-muted">No custom abilities in this region yet.</p>'}`);

    // --- items ---
    const heldItems = countBy(own.flatMap(m => (state.fakemonDB.find(f => f.name === m.name)?.sampleSets || []).map(s => s.item).filter(Boolean)));
    const megaStones = items.mine.filter(i => i.isMegaStone).length;
    const itemsSec = section('Items', '',
        `<div class="an-stats an-stats-small">
            ${statCard('Items', items.all.length, `${items.mine.length} yours · ${items.vanilla.length} main games`)}
            ${statCard('Mega Stones', megaStones, 'of your own items')}
        </div>
        <h4 class="an-sub">Most held in sample sets</h4>
        ${heldItems.length ? barRows(heldItems.slice(0, 8).map(([label, value]) => ({ label: esc(label), value }))) : '<p class="an-muted">No sample sets hold an item yet.</p>'}`);

    // --- types ---
    const attack = allTypes.filter(t => t !== '???' && t !== 'Stellar');
    const offense = attack.map(t => ({ t, hits: attack.filter(d => matchup(t, d) > 1).length }));
    const defense = attack.map(t => ({ t, weak: attack.filter(a => matchup(a, t) > 1).length, immune: attack.filter(a => matchup(a, t) === 0).length }));
    const best = [...offense].sort((a, b) => b.hits - a.hits)[0];
    const sturdiest = [...defense].sort((a, b) => a.weak - b.weak || b.immune - a.immune)[0];
    const frailest = [...defense].sort((a, b) => b.weak - a.weak)[0];
    const customTypes = (api.getCustomTypes?.() || []).filter(t => api.entryInRegion(t, region.id));
    const edits = api.getTypeOverrides?.(region.id) || [];
    const typesSec = section('Types', `${attack.length} types in play${customTypes.length ? `, ${customTypes.length} of them yours` : ''}${edits.length ? `, and ${edits.length} main-game type${edits.length === 1 ? '' : 's'} changed for ${esc(region.name)}` : ''}.`,
        `<div class="an-stats an-stats-small">
            ${best ? statCard('Best attacker', typeBadge(best.t), `super effective on ${best.hits} types`) : ''}
            ${sturdiest ? statCard('Sturdiest', typeBadge(sturdiest.t), `weak to ${sturdiest.weak}, immune to ${sturdiest.immune}`) : ''}
            ${frailest ? statCard('Most weaknesses', typeBadge(frailest.t), `weak to ${frailest.weak}`) : ''}
        </div>
        ${customTypes.length ? `<h4 class="an-sub">Your types</h4>${barRows(customTypes.map(t => ({
            label: typeBadge(t.name), cls: `type-${esc(t.name.toLowerCase())}`,
            value: mons.filter(m => m.types.includes(t.name)).length,
            text: `${mons.filter(m => m.types.includes(t.name)).length} Pokémon · ${moves.all.filter(m => m.type === t.name).length} moves`
        })))}` : ''}`, true);

    return `<h3 class="an-part">Moves, abilities, items and types</h3><div class="an-grid">${movesSec}${abilitiesSec}${itemsSec}${typesSec}</div>`;
}

// ---- the page ----
export function regionAnalyticsHtml(region) {
    const own = (state.fakemonDB || []).filter(f => !f.pendingVanilla && api.entryInRegion(f, region.id)).map(fromFakemon);
    const vanillaIds = api.regionPoolIds?.(region, 'pokemon') || [];
    // the main-game Pokemon the region brings over always count, except ones
    // it has its own version of (that version is already in `own`)
    const copied = new Set((state.fakemonDB || []).filter(f => String(f.regionId || '') === String(region.id) && f.vanillaId && !f.pendingVanilla).map(f => f.vanillaId));
    const vanilla = vanillaIds.filter(id => !copied.has(id)).map(id => state.sdPokedex?.[id]).filter(Boolean).map(fromVanilla);
    const mons = [...own, ...vanilla];
    const head = `<div class="an-head"><div><h2>${esc(region.name)} analytics</h2><p>What your region looks like, from the basics to the numbers competitive players check.</p></div></div>`;

    const regionId = region.id;
    const matchup = (a, d) => api.matchup ? api.matchup(a, d, regionId) : 1;
    const allTypes = api.typesTabArgs ? [...(api.typesTabArgs().vanilla || []), ...(api.typesTabArgs().list || []).map(t => t.name)] : [];

    if (!mons.length) {
        // no Pokemon yet, but its moves, abilities, items and types still say something
        return head + `<div class="an-empty"><i data-lucide="chart-bar"></i><p>No Pokémon in ${esc(region.name)} yet.</p><span>Add some from My Collection (drag a card onto the region, or use Add to region in the editor) and they'll show up here.</span></div>`
            + contentHtml(region, [], [], matchup, allTypes);
    }

    const n = mons.length;
    const bsts = mons.map(m => m.bst);
    const attackTypes = allTypes.filter(t => t !== '???' && t !== 'Stellar');

    // --- overview ---
    const mono = mons.filter(m => m.types.length === 1).length;
    const combos = countBy(mons.map(m => [...m.types].sort().join(' / ')).filter(Boolean));
    const uniqueCombos = combos.filter(([, c]) => c === 1).length;
    const lib = kind => (state[kind] || []).filter(x => !x.pendingVanilla && api.entryInRegion(x, regionId)).length;
    const overview = `<div class="an-stats">
        ${statCard('Pokémon', n, vanilla.length ? `${own.length} yours · ${vanilla.length} from the main games` : 'all yours')}
        ${statCard('Average BST', round(mean(bsts)), `median ${round(median(bsts))}`)}
        ${statCard('BST range', `${Math.min(...bsts)}–${Math.max(...bsts)}`, `spread ±${round(stdev(bsts))}`)}
        ${statCard('Single type', `${pct(mono, n)}%`, `${mono} of ${n}`)}
        ${statCard('Type combos', combos.length, `${uniqueCombos} used only once`)}
        ${statCard('Custom content', lib('customMoves') + lib('customAbilities') + lib('customItems'), `${lib('customMoves')} moves · ${lib('customAbilities')} abilities · ${lib('customItems')} items`)}
    </div>`;

    // --- types ---
    const typeCounts = new Map(allTypes.map(t => [t, { primary: 0, secondary: 0 }]));
    for (const m of mons) {
        m.types.forEach((t, i) => {
            if (!typeCounts.has(t)) typeCounts.set(t, { primary: 0, secondary: 0 });
            typeCounts.get(t)[i === 0 ? 'primary' : 'secondary']++;
        });
    }
    const typeRows = [...typeCounts.entries()].map(([t, c]) => ({ t, total: c.primary + c.secondary, ...c }))
        .filter(r => r.t !== '???' && r.t !== 'Stellar' || r.total)
        .sort((a, b) => b.total - a.total || a.t.localeCompare(b.t));
    const maxType = Math.max(1, ...typeRows.map(r => r.total));
    const typeBars = `<div class="an-bars">${typeRows.map(r => `
        <div class="an-bar-row">
            <span class="an-bar-label">${typeBadge(r.t)}</span>
            <span class="an-bar-track">
                <span class="an-bar-fill type-${esc(r.t.toLowerCase())}" style="width:${(r.primary / maxType) * 100}%"></span><span class="an-bar-fill an-bar-secondary type-${esc(r.t.toLowerCase())}" style="width:${(r.secondary / maxType) * 100}%"></span>
            </span>
            <span class="an-bar-value">${r.total}</span>
        </div>`).join('')}</div>`;
    const unused = typeRows.filter(r => !r.total && r.t !== '???' && r.t !== 'Stellar').map(r => r.t);
    // how evenly the types are shared out: normalised Shannon entropy over types in use
    const used = typeRows.filter(r => r.total);
    const slots = sum(used.map(r => r.total));
    const entropy = -sum(used.map(r => (r.total / slots) * Math.log(r.total / slots)));
    const evenness = attackTypes.length > 1 ? Math.round((entropy / Math.log(attackTypes.length)) * 100) : 0;
    const types = section('Type distribution', 'How many Pokémon have each type. The solid part is the first type, the lighter part the second.',
        typeBars + `<div class="an-notes">
            <p><strong>Type balance: ${evenness}%.</strong> 100% means every type appears equally often; low numbers mean a few types dominate.</p>
            ${unused.length ? `<p><strong>No Pokémon yet:</strong> ${unused.map(typeBadge).join(' ')}</p>` : '<p>Every type has at least one Pokémon.</p>'}
            ${combos.filter(([, c]) => c > 1).length ? `<p><strong>Shared typings:</strong> ${combos.filter(([, c]) => c > 1).slice(0, 6).map(([k, c]) => `${esc(k)} (${c})`).join(', ')}</p>` : '<p>No two Pokémon share the exact same typing.</p>'}
        </div>`, true);

    // --- base stats ---
    const bins = [];
    for (let lo = 150; lo < 750; lo += 50) {
        const c = bsts.filter(b => b >= lo && b < lo + 50).length;
        if (c || (lo >= Math.min(...bsts) - 50 && lo <= Math.max(...bsts))) bins.push({ label: `${lo}–${lo + 49}`, value: c });
    }
    const byBst = [...mons].sort((a, b) => b.bst - a.bst);
    const statAvg = STATS.map(([k, label]) => ({ label, value: mean(mons.map(m => m.stats[k])), spread: stdev(mons.map(m => m.stats[k])) }));
    const topStat = [...statAvg].sort((a, b) => b.value - a.value)[0];
    const stats = section('Base stat totals', 'How strong the roster is overall.',
        `<div class="an-split">
            <div>${barRows(bins)}</div>
            <div class="an-list">${n > 5
                ? `<h4>Strongest</h4>${byBst.slice(0, 5).map(m => `<div><span>${esc(m.name)}</span><b>${m.bst}</b></div>`).join('')}
                   <h4>Weakest</h4>${byBst.slice(-5).reverse().map(m => `<div><span>${esc(m.name)}</span><b>${m.bst}</b></div>`).join('')}`
                // too few for two lists without repeating names
                : `<h4>By total</h4>${byBst.map(m => `<div><span>${esc(m.name)}</span><b>${m.bst}</b></div>`).join('')}`}
            </div>
        </div>`);
    const profile = section('Average stat profile', `Across the roster, <strong>${topStat.label}</strong> is the highest stat on average. The ± is how much it varies between Pokémon.`,
        barRows(statAvg.map(s => ({ label: s.label, value: s.value, text: `${round(s.value)} <small>±${round(s.spread)}</small>` })), { max: 150, color: 'var(--accent)' }));

    // --- roles and speed ---
    const roles = countBy(mons.map(roleOf));
    const speedTiers = [['Under 50', 0, 50], ['50–79', 50, 80], ['80–99', 80, 100], ['100–119', 100, 120], ['120+', 120, 999]]
        .map(([label, lo, hi]) => ({ label, value: mons.filter(m => m.stats.spe >= lo && m.stats.spe < hi).length }));
    const fastest = [...mons].sort((a, b) => b.stats.spe - a.stats.spe).slice(0, 3);
    const rolesSec = section('Roles', 'A rough read of what each stat spread is built for.',
        barRows(roles.map(([label, value]) => ({ label: esc(label), value }))));
    const speedSec = section('Speed tiers', `Fastest: ${fastest.map(m => `${esc(m.name)} (${m.stats.spe})`).join(', ')}.`, barRows(speedTiers));

    // --- defensive and offensive picture (uses the region's own type chart) ---
    const defense = attackTypes.map(att => {
        const mults = mons.map(m => m.types.reduce((x, t) => x * matchup(att, t), 1));
        return { att, weak: mults.filter(x => x > 1).length, resist: mults.filter(x => x < 1).length };
    }).sort((a, b) => (b.weak - b.resist) - (a.weak - a.resist));
    const defenseRows = defense.map(d => `<tr><td>${typeBadge(d.att)}</td><td class="an-num an-bad">${d.weak}</td><td class="an-num an-good">${d.resist}</td><td class="an-num ${d.weak - d.resist > 0 ? 'an-bad' : d.weak - d.resist < 0 ? 'an-good' : ''}">${d.weak - d.resist > 0 ? '+' : ''}${d.weak - d.resist}</td></tr>`).join('');
    const stabTypes = [...new Set(mons.flatMap(m => m.types))];
    const uncovered = attackTypes.filter(def => !stabTypes.some(att => matchup(att, def) > 1));
    const defenseSec = section('Shared weaknesses', 'For each attacking type: how many of your Pokémon take extra damage from it, and how many resist it. Types at the top are the region\'s soft spots.',
        `<div class="an-table-wrap"><table class="an-table"><thead><tr><th>Attacking type</th><th>Weak</th><th>Resist</th><th>Net</th></tr></thead><tbody>${defenseRows}</tbody></table></div>`);
    const coverageSec = section('STAB coverage', 'Types that no Pokémon in the region can hit super-effectively with a move of its own type.',
        uncovered.length ? `<p class="an-chips">${uncovered.map(typeBadge).join(' ')}</p>` : '<p>Between them, your Pokémon\'s own types hit every type super-effectively.</p>');

    // --- abilities and moves ---
    const abilityUse = countBy(mons.flatMap(m => m.abilities));
    const moveUse = countBy(own.flatMap(m => m.moves));
    const avgMoves = mean(own.map(m => m.moves.length));
    const abilitiesSec = section('Most common abilities', `${abilityUse.length} different abilities across the roster.`,
        barRows(abilityUse.slice(0, 8).map(([label, value]) => ({ label: esc(label), value }))));
    const movesSec = section('Most learned moves', own.length ? `Your Fakémon learn ${round(avgMoves)} moves on average.` : '',
        moveUse.length ? barRows(moveUse.slice(0, 8).map(([label, value]) => ({ label: esc(label), value }))) : '<p class="an-muted">No learnsets yet.</p>');

    // --- body, breeding, colour ---
    const heights = mons.map(m => m.height).filter(x => x > 0);
    const weights = mons.map(m => m.weight).filter(x => x > 0);
    const genderless = mons.filter(m => m.male === -1).length;
    const gendered = mons.filter(m => m.male !== null && m.male >= 0);
    const tallest = [...mons].filter(m => m.height).sort((a, b) => b.height - a.height)[0];
    const heaviest = [...mons].filter(m => m.weight).sort((a, b) => b.weight - a.weight)[0];
    const eggs = countBy(mons.flatMap(m => m.eggGroups));
    const colors = countBy(mons.map(m => m.color).filter(Boolean));
    const bodySec = section('Size, breeding and colour', '',
        `<div class="an-stats an-stats-small">
            ${statCard('Average height', heights.length ? `${round(mean(heights), 1)} m` : '—', tallest ? `tallest: ${esc(tallest.name)}` : '')}
            ${statCard('Average weight', weights.length ? `${round(mean(weights), 1)} kg` : '—', heaviest ? `heaviest: ${esc(heaviest.name)}` : '')}
            ${statCard('Genderless', `${pct(genderless, n)}%`, gendered.length ? `the rest ${round(mean(gendered.map(m => m.male)))}% male on average` : '')}
        </div>
        <div class="an-split">
            <div><h4 class="an-sub">Egg groups</h4>${eggs.length ? barRows(eggs.slice(0, 6).map(([label, value]) => ({ label: esc(label), value }))) : '<p class="an-muted">None set.</p>'}</div>
            <div><h4 class="an-sub">Colours</h4>${colors.length ? barRows(colors.slice(0, 6).map(([label, value]) => ({ label: esc(label), value }))) : '<p class="an-muted">None set.</p>'}</div>
        </div>`, true);

    return head + overview
        + `<h3 class="an-part">Pokémon</h3><div class="an-grid">${types}${stats}${profile}${rolesSec}${speedSec}${defenseSec}${coverageSec}${abilitiesSec}${movesSec}${bodySec}</div>`
        + contentHtml(region, mons, own, matchup, allTypes);
}
