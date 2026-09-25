// Region details' sibling page: what a region's roster looks like as data.
// Basics first (how many, which types, how strong), then the numbers a
// competitive designer reaches for (stat spreads, roles, speed tiers, the
// region's shared weaknesses, STAB coverage, how evenly the types are spread).
// Pure reads of the collection; nothing here writes.

import type { ReactNode } from 'react';
import { api, state } from '../../../core/app.ts';
import { Icon } from '../Icon.tsx';
import type { Region } from '../../types.ts';

const STATS: Array<[StatKey, string]> = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];
type StatKey = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';

/** A Fakémon or a main-game Pokémon, in one shape. */
interface Mon {
    name: string;
    source: 'fakemon' | 'vanilla';
    types: string[];
    stats: Record<StatKey, number>;
    bst: number;
    abilities: string[];
    moves: string[];
    height: number | null;
    weight: number | null;
    color: string;
    eggGroups: string[];
    male: number | null;
}

// ---- turning Fakemon and main-game Pokemon into one shape ----
function parseNumber(text: unknown): number | null {
    const m = String(text || '').match(/[\d.]+/);
    return m ? Number(m[0]) : null;
}
function toMeters(text: unknown) {
    const n = parseNumber(text);
    if (n === null) return null;
    return /ft|'/.test(String(text)) ? n * 0.3048 : n;
}
function toKg(text: unknown) {
    const n = parseNumber(text);
    if (n === null) return null;
    return /lb/.test(String(text)) ? n * 0.4536 : n;
}

function statsOf(source: any): Record<StatKey, number> {
    return Object.fromEntries(STATS.map(([k]) => [k, Number(source?.[k]) || 0])) as Record<StatKey, number>;
}
const totalOf = (stats: Record<StatKey, number>) => STATS.reduce((n, [k]) => n + stats[k], 0);

function fromFakemon(f: any): Mon {
    const stats = statsOf(f.stats);
    const eggs = Array.isArray(f.eggGroups) ? f.eggGroups : String(f.eggGroups || '').split(/[,/]/).map((s: string) => s.trim()).filter(Boolean);
    return {
        name: f.name || 'Unnamed', source: 'fakemon',
        types: [f.type1, f.type2].filter(Boolean),
        stats, bst: totalOf(stats),
        abilities: (f.abilities || []).map((a: any) => a?.name).filter(Boolean),
        moves: (f.learnset || []).map((m: any) => m?.name).filter(Boolean),
        height: toMeters(f.height), weight: toKg(f.weight),
        color: f.color || '', eggGroups: eggs.filter((e: string) => e !== 'None'),
        male: f.genderRatio === undefined || f.genderRatio === null ? null : Number(f.genderRatio)
    };
}

function fromVanilla(p: any): Mon {
    const stats = statsOf(p.stats);
    return {
        name: p.name, source: 'vanilla',
        types: p.types || [], stats, bst: totalOf(stats),
        abilities: Object.values(p.abilities || {}) as string[], moves: [],
        height: p.heightm || null, weight: p.weightkg || null,
        color: p.color || '', eggGroups: p.eggGroups || [], male: p.genderPct ?? null
    };
}

// ---- small helpers ----
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
function median(xs: number[]) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stdev(xs: number[]) {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(sum(xs.map(x => (x - m) ** 2)) / (xs.length - 1));
}
function countBy(items: string[]): Array<[string, number]> {
    const map = new Map<string, number>();
    for (const it of items) map.set(it, (map.get(it) || 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}
const round = (n: number, d = 0) => Number(n.toFixed(d)).toLocaleString();
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

// a stat-block role, from how the stats are shared out
function roleOf(m: Mon) {
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

// ---- pieces ----
interface BarRow { label: ReactNode; value: number; text?: ReactNode; cls?: string; key?: string }

function Bars({ rows, max = null, unit = '', color = null }: { rows: BarRow[]; max?: number | null; unit?: string; color?: string | null }) {
    const top = max ?? Math.max(1, ...rows.map(r => r.value));
    return (
        <div className="an-bars">
            {rows.map((r, i) => (
                <div className="an-bar-row" key={r.key ?? i}>
                    <span className="an-bar-label">{r.label}</span>
                    <span className="an-bar-track">
                        <span className={`an-bar-fill${r.cls ? ` ${r.cls}` : ''}`} style={{ width: `${Math.max(2, (r.value / top) * 100)}%`, ...(color ? { background: color } : {}) }} />
                    </span>
                    <span className="an-bar-value">{r.text ?? `${round(r.value, r.value % 1 ? 1 : 0)}${unit}`}</span>
                </div>
            ))}
        </div>
    );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
    return <div className="an-stat"><span className="an-stat-label">{label}</span><strong>{value}</strong>{sub ? <small>{sub}</small> : null}</div>;
}

function Section({ title, help, wide, children }: { title: string; help?: ReactNode; wide?: boolean; children: ReactNode }) {
    return (
        <section className={`an-card${wide ? ' an-wide' : ''}`}>
            <header><h3>{title}</h3>{help ? <p>{help}</p> : null}</header>
            {children}
        </section>
    );
}

const TypeBadge = ({ t }: { t: string }) => <span className={`type-badge type-${String(t).toLowerCase()}`}>{t}</span>;
const typeRow = ([label, value]: [string, number]): BarRow => ({ key: label, label: <TypeBadge t={label} />, value, cls: `type-${label.toLowerCase()}` });
const plainRow = ([label, value]: [string, number]): BarRow => ({ key: label, label, value });

/** Badges separated by spaces, as a sentence would list them. */
function Badges({ types }: { types: string[] }) {
    return <>{types.map((t, i) => <span key={t}>{i ? ' ' : ''}<TypeBadge t={t} /></span>)}</>;
}

// ---- moves, abilities, items and types ----
// Everything the region has to work with: its own entries (and its own
// versions of main-game ones) plus the main-game ones it brings over.
function regionLibrary(region: Region, kind: 'customMoves' | 'customAbilities' | 'customItems') {
    const mine = ((state as any)[kind] || []).filter((x: any) => !x.pendingVanilla && api.entryInRegion(x, region.id));
    const copied = new Set(mine.map((x: any) => x.vanillaId).filter(Boolean));
    const poolKind = kind === 'customMoves' ? 'moves' : kind === 'customAbilities' ? 'abilities' : 'items';
    const source: Record<string, any> = { moves: state.sdMoves, abilities: state.sdAbilities, items: state.sdItems }[poolKind] || {};
    const vanilla = (api.regionPoolIds?.(region, poolKind) || []).filter((id: string) => source[id] && !copied.has(id)).map((id: string) => source[id]);
    return { mine, vanilla, all: [...mine, ...vanilla] };
}

function Content({ region, mons, own, matchup, allTypes }: {
    region: Region; mons: Mon[]; own: Mon[]; matchup: (a: string, d: string) => number; allTypes: string[];
}) {
    const moves = regionLibrary(region, 'customMoves');
    const abilities = regionLibrary(region, 'customAbilities');
    const items = regionLibrary(region, 'customItems');
    const custom = moves.mine.filter((m: any) => !m.vanillaId).length;
    const edited = moves.mine.filter((m: any) => m.vanillaId).length;

    // --- moves ---
    const cats = countBy(moves.all.map((m: any) => m.category || 'Status'));
    const damaging = moves.all.filter((m: any) => (m.category || 'Status') !== 'Status' && Number(m.basePower) > 0);
    const bps = damaging.map((m: any) => Number(m.basePower));
    const moveTypes = countBy(moves.all.map((m: any) => m.type || 'Normal'));
    const priority = moves.all.filter((m: any) => Number(m.priority) > 0).length;
    const inaccurate = damaging.filter((m: any) => m.accuracy !== true && Number(m.accuracy) < 100).length;
    // types the region's Pokemon have, but no damaging move of that type to use for STAB
    const monTypes = [...new Set(mons.flatMap(m => m.types))];
    const damagingTypes = new Set(damaging.map((m: any) => m.type));
    const noStab = monTypes.filter(t => !damagingTypes.has(t));
    const learned = new Set(own.flatMap(m => m.moves));
    const unusedCustom = moves.mine.filter((m: any) => !m.vanillaId && !learned.has(m.name));

    // --- abilities ---
    const abilityUsers = new Map<string, number>();
    mons.forEach(m => m.abilities.forEach(a => abilityUsers.set(a, (abilityUsers.get(a) || 0) + 1)));
    const customAbilities = abilities.mine;
    const usedCustom = customAbilities.filter((a: any) => abilityUsers.has(a.name));
    const withCustom = own.filter(m => m.abilities.some(a => customAbilities.some((c: any) => c.name === a))).length;

    // --- items ---
    const heldItems = countBy(own.flatMap(m => (state.fakemonDB.find(f => f.name === m.name)?.sampleSets || []).map((s: any) => s.item).filter(Boolean)));
    const megaStones = items.mine.filter((i: any) => i.isMegaStone).length;

    // --- types ---
    const attack = allTypes.filter(t => t !== '???' && t !== 'Stellar');
    const offense = attack.map(t => ({ t, hits: attack.filter(d => matchup(t, d) > 1).length }));
    const defense = attack.map(t => ({ t, weak: attack.filter(a => matchup(a, t) > 1).length, immune: attack.filter(a => matchup(a, t) === 0).length }));
    const best = [...offense].sort((a, b) => b.hits - a.hits)[0];
    const sturdiest = [...defense].sort((a, b) => a.weak - b.weak || b.immune - a.immune)[0];
    const frailest = [...defense].sort((a, b) => b.weak - a.weak)[0];
    const customTypes = (api.getCustomTypes?.() || []).filter((t: any) => api.entryInRegion(t, region.id));
    const edits = api.getTypeOverrides?.(region.id) || [];

    return (
        <>
            <h3 className="an-part">Moves, abilities, items and types</h3>
            <div className="an-grid">
                <Section title="Moves" help="What the region's Pokémon have to fight with." wide>
                    <div className="an-stats an-stats-small">
                        <Stat label="Moves" value={moves.all.length} sub={`${custom} custom · ${edited} edited · ${moves.vanilla.length} main games`} />
                        <Stat label="Average power" value={bps.length ? round(mean(bps)) : '—'} sub={bps.length ? `median ${round(median(bps))} · top ${Math.max(...bps)}` : 'no damaging moves'} />
                        <Stat label="Priority moves" value={priority} sub={`${inaccurate} damaging moves under 100% accuracy`} />
                    </div>
                    <div className="an-split">
                        <div><h4 className="an-sub">Physical, special and status</h4><Bars rows={cats.map(plainRow)} /></div>
                        <div><h4 className="an-sub">By type</h4><Bars rows={moveTypes.slice(0, 8).map(typeRow)} /></div>
                    </div>
                    <div className="an-notes">
                        {noStab.length
                            ? <p><strong>No damaging move to match their type:</strong> <Badges types={noStab} /></p>
                            : <p>Every type your Pokémon have has at least one damaging move.</p>}
                        {unusedCustom.length > 0 && (
                            <p><strong>Custom moves no Fakémon learns yet:</strong> {unusedCustom.slice(0, 10).map((m: any) => m.name).join(', ')}{unusedCustom.length > 10 ? ` and ${unusedCustom.length - 10} more` : ''}</p>
                        )}
                    </div>
                </Section>

                <Section title="Abilities">
                    <div className="an-stats an-stats-small">
                        <Stat label="Abilities" value={abilities.all.length} sub={`${customAbilities.length} yours · ${abilities.vanilla.length} main games`} />
                        <Stat label="Custom ones in use" value={`${usedCustom.length} of ${customAbilities.length}`} sub={customAbilities.length ? `${pct(withCustom, own.length)}% of your Fakémon have one` : ''} />
                    </div>
                    {customAbilities.length
                        ? <Bars rows={customAbilities.map((a: any) => ({ key: a.id, label: a.name, value: abilityUsers.get(a.name) || 0 })).sort((x: BarRow, y: BarRow) => y.value - x.value).slice(0, 8)} />
                        : <p className="an-muted">No custom abilities in this region yet.</p>}
                </Section>

                <Section title="Items">
                    <div className="an-stats an-stats-small">
                        <Stat label="Items" value={items.all.length} sub={`${items.mine.length} yours · ${items.vanilla.length} main games`} />
                        <Stat label="Mega Stones" value={megaStones} sub="of your own items" />
                    </div>
                    <h4 className="an-sub">Most held in sample sets</h4>
                    {heldItems.length ? <Bars rows={heldItems.slice(0, 8).map(plainRow)} /> : <p className="an-muted">No sample sets hold an item yet.</p>}
                </Section>

                <Section title="Types" wide
                    help={`${attack.length} types in play${customTypes.length ? `, ${customTypes.length} of them yours` : ''}${edits.length ? `, and ${edits.length} main-game type${edits.length === 1 ? '' : 's'} changed for ${region.name}` : ''}.`}>
                    <div className="an-stats an-stats-small">
                        {best && <Stat label="Best attacker" value={<TypeBadge t={best.t} />} sub={`super effective on ${best.hits} types`} />}
                        {sturdiest && <Stat label="Sturdiest" value={<TypeBadge t={sturdiest.t} />} sub={`weak to ${sturdiest.weak}, immune to ${sturdiest.immune}`} />}
                        {frailest && <Stat label="Most weaknesses" value={<TypeBadge t={frailest.t} />} sub={`weak to ${frailest.weak}`} />}
                    </div>
                    {customTypes.length > 0 && (
                        <>
                            <h4 className="an-sub">Your types</h4>
                            <Bars rows={customTypes.map((t: any) => {
                                const n = mons.filter(m => m.types.includes(t.name)).length;
                                return { key: t.id, label: <TypeBadge t={t.name} />, cls: `type-${t.name.toLowerCase()}`, value: n, text: `${n} Pokémon · ${moves.all.filter((m: any) => m.type === t.name).length} moves` };
                            })} />
                        </>
                    )}
                </Section>
            </div>
        </>
    );
}

// ---- the page ----
export function RegionAnalytics({ region }: { region: Region }) {
    const own = (state.fakemonDB || []).filter(f => !f.pendingVanilla && api.entryInRegion(f, region.id)).map(fromFakemon);
    const vanillaIds: string[] = api.regionPoolIds?.(region, 'pokemon') || [];
    // the main-game Pokemon the region brings over always count, except ones
    // it has its own version of (that version is already in `own`)
    const copied = new Set((state.fakemonDB || []).filter(f => String(f.regionId || '') === String(region.id) && f.vanillaId && !f.pendingVanilla).map(f => f.vanillaId));
    const vanilla = vanillaIds.filter(id => !copied.has(id)).map(id => state.sdPokedex?.[id]).filter(Boolean).map(fromVanilla);
    const mons = [...own, ...vanilla];

    const regionId = region.id;
    const matchup = (a: string, d: string): number => api.matchup ? api.matchup(a, d, regionId) : 1;
    const tabArgs = api.typesTabArgs?.();
    const allTypes: string[] = tabArgs ? [...(tabArgs.vanilla || []), ...(tabArgs.list || []).map((t: any) => t.name)] : [];

    const head = (
        <div className="an-head"><div><h2>{region.name} analytics</h2><p>What your region looks like, from the basics to the numbers competitive players check.</p></div></div>
    );

    if (!mons.length) {
        // no Pokemon yet, but its moves, abilities, items and types still say something
        return (
            <>
                {head}
                <div className="an-empty">
                    <Icon name="chart-bar" />
                    <p>No Pokémon in {region.name} yet.</p>
                    <span>Add some from My Collection (drag a card onto the region, or use Add to region in the editor) and they'll show up here.</span>
                </div>
                <Content region={region} mons={[]} own={[]} matchup={matchup} allTypes={allTypes} />
            </>
        );
    }

    const n = mons.length;
    const bsts = mons.map(m => m.bst);
    const attackTypes = allTypes.filter(t => t !== '???' && t !== 'Stellar');

    // --- overview ---
    const mono = mons.filter(m => m.types.length === 1).length;
    const combos = countBy(mons.map(m => [...m.types].sort().join(' / ')).filter(Boolean));
    const uniqueCombos = combos.filter(([, c]) => c === 1).length;
    const lib = (kind: string) => ((state as any)[kind] || []).filter((x: any) => !x.pendingVanilla && api.entryInRegion(x, regionId)).length;

    // --- types ---
    const typeCounts = new Map<string, { primary: number; secondary: number }>(allTypes.map(t => [t, { primary: 0, secondary: 0 }]));
    for (const m of mons) {
        m.types.forEach((t, i) => {
            if (!typeCounts.has(t)) typeCounts.set(t, { primary: 0, secondary: 0 });
            typeCounts.get(t)![i === 0 ? 'primary' : 'secondary']++;
        });
    }
    const typeRows = [...typeCounts.entries()].map(([t, c]) => ({ t, total: c.primary + c.secondary, ...c }))
        .filter(r => (r.t !== '???' && r.t !== 'Stellar') || r.total)
        .sort((a, b) => b.total - a.total || a.t.localeCompare(b.t));
    const maxType = Math.max(1, ...typeRows.map(r => r.total));
    const unused = typeRows.filter(r => !r.total && r.t !== '???' && r.t !== 'Stellar').map(r => r.t);
    // how evenly the types are shared out: normalised Shannon entropy over types in use
    const used = typeRows.filter(r => r.total);
    const slots = sum(used.map(r => r.total));
    const entropy = -sum(used.map(r => (r.total / slots) * Math.log(r.total / slots)));
    const evenness = attackTypes.length > 1 ? Math.round((entropy / Math.log(attackTypes.length)) * 100) : 0;
    const shared = combos.filter(([, c]) => c > 1);

    // --- base stats ---
    const bins: BarRow[] = [];
    for (let lo = 150; lo < 750; lo += 50) {
        const c = bsts.filter(b => b >= lo && b < lo + 50).length;
        if (c || (lo >= Math.min(...bsts) - 50 && lo <= Math.max(...bsts))) bins.push({ key: String(lo), label: `${lo}–${lo + 49}`, value: c });
    }
    const byBst = [...mons].sort((a, b) => b.bst - a.bst);
    const statAvg = STATS.map(([k, label]) => ({ label, value: mean(mons.map(m => m.stats[k])), spread: stdev(mons.map(m => m.stats[k])) }));
    const topStat = [...statAvg].sort((a, b) => b.value - a.value)[0];
    const bstList = (list: Mon[]) => list.map((m, i) => <div key={i}><span>{m.name}</span><b>{m.bst}</b></div>);

    // --- roles and speed ---
    const roles = countBy(mons.map(roleOf));
    const speedTiers: BarRow[] = ([['Under 50', 0, 50], ['50–79', 50, 80], ['80–99', 80, 100], ['100–119', 100, 120], ['120+', 120, 999]] as Array<[string, number, number]>)
        .map(([label, lo, hi]) => ({ key: label, label, value: mons.filter(m => m.stats.spe >= lo && m.stats.spe < hi).length }));
    const fastest = [...mons].sort((a, b) => b.stats.spe - a.stats.spe).slice(0, 3);

    // --- defensive and offensive picture (uses the region's own type chart) ---
    const defense = attackTypes.map(att => {
        const mults = mons.map(m => m.types.reduce((x, t) => x * matchup(att, t), 1));
        return { att, weak: mults.filter(x => x > 1).length, resist: mults.filter(x => x < 1).length };
    }).sort((a, b) => (b.weak - b.resist) - (a.weak - a.resist));
    const stabTypes = [...new Set(mons.flatMap(m => m.types))];
    const uncovered = attackTypes.filter(def => !stabTypes.some(att => matchup(att, def) > 1));

    // --- abilities and moves ---
    const abilityUse = countBy(mons.flatMap(m => m.abilities));
    const moveUse = countBy(own.flatMap(m => m.moves));
    const avgMoves = mean(own.map(m => m.moves.length));

    // --- body, breeding, colour ---
    const heights = mons.map(m => m.height).filter((x): x is number => !!x && x > 0);
    const weights = mons.map(m => m.weight).filter((x): x is number => !!x && x > 0);
    const genderless = mons.filter(m => m.male === -1).length;
    const gendered = mons.filter(m => m.male !== null && m.male >= 0);
    const tallest = [...mons].filter(m => m.height).sort((a, b) => b.height! - a.height!)[0];
    const heaviest = [...mons].filter(m => m.weight).sort((a, b) => b.weight! - a.weight!)[0];
    const eggs = countBy(mons.flatMap(m => m.eggGroups));
    const colors = countBy(mons.map(m => m.color).filter(Boolean));

    return (
        <>
            {head}
            <div className="an-stats">
                <Stat label="Pokémon" value={n} sub={vanilla.length ? `${own.length} yours · ${vanilla.length} from the main games` : 'all yours'} />
                <Stat label="Average BST" value={round(mean(bsts))} sub={`median ${round(median(bsts))}`} />
                <Stat label="BST range" value={`${Math.min(...bsts)}–${Math.max(...bsts)}`} sub={`spread ±${round(stdev(bsts))}`} />
                <Stat label="Single type" value={`${pct(mono, n)}%`} sub={`${mono} of ${n}`} />
                <Stat label="Type combos" value={combos.length} sub={`${uniqueCombos} used only once`} />
                <Stat label="Custom content" value={lib('customMoves') + lib('customAbilities') + lib('customItems')} sub={`${lib('customMoves')} moves · ${lib('customAbilities')} abilities · ${lib('customItems')} items`} />
            </div>

            <h3 className="an-part">Pokémon</h3>
            <div className="an-grid">
                <Section title="Type distribution" help="How many Pokémon have each type. The solid part is the first type, the lighter part the second." wide>
                    <div className="an-bars">
                        {typeRows.map(r => (
                            <div className="an-bar-row" key={r.t}>
                                <span className="an-bar-label"><TypeBadge t={r.t} /></span>
                                <span className="an-bar-track">
                                    <span className={`an-bar-fill type-${r.t.toLowerCase()}`} style={{ width: `${(r.primary / maxType) * 100}%` }} />
                                    <span className={`an-bar-fill an-bar-secondary type-${r.t.toLowerCase()}`} style={{ width: `${(r.secondary / maxType) * 100}%` }} />
                                </span>
                                <span className="an-bar-value">{r.total}</span>
                            </div>
                        ))}
                    </div>
                    <div className="an-notes">
                        <p><strong>Type balance: {evenness}%.</strong> 100% means every type appears equally often; low numbers mean a few types dominate.</p>
                        {unused.length ? <p><strong>No Pokémon yet:</strong> <Badges types={unused} /></p> : <p>Every type has at least one Pokémon.</p>}
                        {shared.length
                            ? <p><strong>Shared typings:</strong> {shared.slice(0, 6).map(([k, c]) => `${k} (${c})`).join(', ')}</p>
                            : <p>No two Pokémon share the exact same typing.</p>}
                    </div>
                </Section>

                <Section title="Base stat totals" help="How strong the roster is overall.">
                    <div className="an-split">
                        <div><Bars rows={bins} /></div>
                        <div className="an-list">
                            {n > 5
                                ? <><h4>Strongest</h4>{bstList(byBst.slice(0, 5))}<h4>Weakest</h4>{bstList(byBst.slice(-5).reverse())}</>
                                // too few for two lists without repeating names
                                : <><h4>By total</h4>{bstList(byBst)}</>}
                        </div>
                    </div>
                </Section>

                <Section title="Average stat profile" help={<>Across the roster, <strong>{topStat.label}</strong> is the highest stat on average. The ± is how much it varies between Pokémon.</>}>
                    <Bars max={150} color="var(--accent)" rows={statAvg.map(s => ({ key: s.label, label: s.label, value: s.value, text: <>{round(s.value)} <small>±{round(s.spread)}</small></> }))} />
                </Section>

                <Section title="Roles" help="A rough read of what each stat spread is built for.">
                    <Bars rows={roles.map(plainRow)} />
                </Section>

                <Section title="Speed tiers" help={`Fastest: ${fastest.map(m => `${m.name} (${m.stats.spe})`).join(', ')}.`}>
                    <Bars rows={speedTiers} />
                </Section>

                <Section title="Shared weaknesses" help="For each attacking type: how many of your Pokémon take extra damage from it, and how many resist it. Types at the top are the region's soft spots.">
                    <div className="an-table-wrap">
                        <table className="an-table">
                            <thead><tr><th>Attacking type</th><th>Weak</th><th>Resist</th><th>Net</th></tr></thead>
                            <tbody>
                                {defense.map(d => {
                                    const net = d.weak - d.resist;
                                    return (
                                        <tr key={d.att}>
                                            <td><TypeBadge t={d.att} /></td>
                                            <td className="an-num an-bad">{d.weak}</td>
                                            <td className="an-num an-good">{d.resist}</td>
                                            <td className={`an-num ${net > 0 ? 'an-bad' : net < 0 ? 'an-good' : ''}`}>{net > 0 ? '+' : ''}{net}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </Section>

                <Section title="STAB coverage" help="Types that no Pokémon in the region can hit super-effectively with a move of its own type.">
                    {uncovered.length
                        ? <p className="an-chips"><Badges types={uncovered} /></p>
                        : <p>Between them, your Pokémon's own types hit every type super-effectively.</p>}
                </Section>

                <Section title="Most common abilities" help={`${abilityUse.length} different abilities across the roster.`}>
                    <Bars rows={abilityUse.slice(0, 8).map(plainRow)} />
                </Section>

                <Section title="Most learned moves" help={own.length ? `Your Fakémon learn ${round(avgMoves)} moves on average.` : ''}>
                    {moveUse.length ? <Bars rows={moveUse.slice(0, 8).map(plainRow)} /> : <p className="an-muted">No learnsets yet.</p>}
                </Section>

                <Section title="Size, breeding and colour" wide>
                    <div className="an-stats an-stats-small">
                        <Stat label="Average height" value={heights.length ? `${round(mean(heights), 1)} m` : '—'} sub={tallest ? `tallest: ${tallest.name}` : ''} />
                        <Stat label="Average weight" value={weights.length ? `${round(mean(weights), 1)} kg` : '—'} sub={heaviest ? `heaviest: ${heaviest.name}` : ''} />
                        <Stat label="Genderless" value={`${pct(genderless, n)}%`} sub={gendered.length ? `the rest ${round(mean(gendered.map(m => m.male as number)))}% male on average` : ''} />
                    </div>
                    <div className="an-split">
                        <div><h4 className="an-sub">Egg groups</h4>{eggs.length ? <Bars rows={eggs.slice(0, 6).map(plainRow)} /> : <p className="an-muted">None set.</p>}</div>
                        <div><h4 className="an-sub">Colours</h4>{colors.length ? <Bars rows={colors.slice(0, 6).map(plainRow)} /> : <p className="an-muted">None set.</p>}</div>
                    </div>
                </Section>
            </div>

            <Content region={region} mons={mons} own={own} matchup={matchup} allTypes={allTypes} />
        </>
    );
}
