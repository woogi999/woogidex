// ==================== battle tab UI ====================
// Three panes: Teams (build), Lobby (find/challenge), Battle (play).
// No mock mode -- bot and player battles run the same Battle instance.

import { state, api } from '../../core/app.ts';
import { log } from '../../core/log.ts';
import { confirmDialog } from '../../core/confirm-dialog.ts';
import { NATURE_DATA } from '../../core/data.ts';
import { Battle, canSelectMove, ENGINE_VERSION, STRUGGLE, STRUGGLE_INDEX } from '../engine/battle.ts';
import { notify } from '../../app/store.ts';
import { openDialog, closeDialog } from '../../app/dialogs.tsx';
import { loadShowdownAbilities, abilitiesFingerprint } from '../engine/sd-abilities.ts';
import { loadShowdownMoves, movesFingerprint } from '../engine/sd-moves.ts';
import { loadShowdownItems, itemsFingerprint } from '../engine/sd-items.ts';
import { loadBattleText } from './battle-text.ts';
import { formatLogLine } from './battle-log.ts';
import { BattleDex, toId } from '../engine/dex.ts';
import {
    makeTeam, makeMember, checkTeamReady, toPeerPackage, toServerSnapshot,
    checkIncomingPackage, packageToSide, mergeDexPayload, monForMember, TEAM_FORMAT_RULES
} from '../teams.ts';
import { chooseBotAction } from '../bot.ts';
import { BattleLobby } from '../net/lobby.ts';
import { BattleRTC } from '../net/rtc.ts';
import { MSG, negotiateCaps, handshakeBlocker, reducedCaps, setupMismatch, TEAM_CHUNK_CHARS } from '../net/protocol.ts';
import { BattleScene, SCENE_SPEEDS } from './scene.ts';
import { mountField3D, fieldForSeed } from './field3d.ts';

import { esc, publicName } from '../../core/html.ts';
import { artworkDataUri, maskedArtwork } from '../../core/art-shield.ts';

const UI = {
    pane: 'teams',
    scene: null as any,
    speed: 'normal',
    animating: false,
    editingTeamId: null as any,
    lobby: null as any,
    players: [] as any[],
    challenges: [] as any[],
    battle: null as any,
    meta: null as any,          // { mode, mySide, battleId, oppName }
    searching: false,    // announces "Find Match" presence
    previewField: null as any,  // 3D field during lead selection
    previewHost: null as any,
    logCursor: 0,
    pendingChoice: null as any,
    switchPanelOpen: false,
    timer: null as any,
    timeLeft: 0,
    status: '',          // the line beside the page title
    findTeamId: '',      // the team picked for Find Match / challenges
    botTeamId: '',       // the team picked for a practice battle
    skeleton: true,      // until the first open has loaded the battle data
    // set as the screens open; null until then
    leadPick: null as any,          // lead selection before a battle starts
    editingSlotIndex: null as number | null,
    pickerTeamId: null as string | null,
    myPendingPackage: null as any,  // the team sent while waiting for the opponent's
    pendingBattleRow: null as any
};

/**
 * What the Battle page (js/app/pages/BattlePage.tsx) draws from.
 */
export function battleUI(): Record<string, any> { return UI; }

const TURN_SECONDS = 90;

// Skeletons show at boot until the battle data has loaded (UI.skeleton).
export function renderBattleSkeleton() {
    UI.skeleton = true;
    notify();
}

// ==================== entry ====================
export async function openBattle() {
    api.activateTopLevelView?.('battle-view');
    api.setRoute?.('battle', 'Battle');
    if (!state.sdLoaded) {
        setStatus('Loading move data…');
        await api.fetchShowdownData?.();
    }
    // Must be loaded before any battle starts, or simulations between players diverge.
    await Promise.all([loadShowdownAbilities(), loadShowdownMoves(), loadShowdownItems(), loadBattleText()]);
    if (!UI.battle && !UI.leadPick) UI.pane = UI.pane === 'battle' ? 'teams' : UI.pane;
    UI.skeleton = false;
    setStatus('');
    render();
    if (UI.pane === 'lobby') await ensureLobby();
}

function setStatus(msg) {
    UI.status = msg || '';
    notify();
}

export function setBattlePane(pane) {
    UI.pane = pane;
    render();
    if (pane === 'lobby') ensureLobby();
    else if (UI.lobby?.joined && pane !== 'battle') UI.lobby.setStatus('away');
}

// ==================== render root ====================
// The page is React; this just says something changed. The scene is bound to
// its host element by syncBattleScene(), which the page calls after drawing.
function render() {
    healVanillaMembers();
    notify();
}

/** Binds the 3D field and the log to the elements the page just drew. */
export function syncBattleScene() {
    mountScene();
}

// Re-binds the scene to a freshly rendered pane without losing animation state.
function mountScene() {
    if (UI.leadPick) { attachPreviewScene(); return; }
    if (UI.pane !== 'battle' || !UI.battle || !UI.scene) return;
    const sceneEl = document.getElementById('battle-scene');
    const logEl = document.getElementById('battle-log');
    if (!sceneEl || !logEl) return;
    // Skip rebuild if already mounted here -- avoids recreating the WebGL canvas.
    if (UI.scene.root === sceneEl && UI.scene.logEl === logEl) { UI.scene.pump(); return; }
    UI.scene.mount(sceneEl, logEl);
    if (UI.scene.cursor > 0) UI.scene.rebuildLog();
    UI.scene.pump();
}

// ==================== teams pane ====================
export function teams() { return state.battleTeams || (state.battleTeams = []); }
export function findTeam(id) { return teams().find(t => t.id === id) || null; }

// ---- resolving a team slot to the Pokemon it stands for ----
// Collection Fakemon resolve by id; a vanilla Pokemon carries its own
// Fakemon-shaped snapshot on the member (see teams.ts monForMember). Teams
// built before that snapshot existed only kept an `sd_<dexid>` reference, so
// they are rebuilt from the Showdown dex the first time they are read --
// otherwise every vanilla slot reads as a deleted Fakemon.
export function monFor(m) {
    const found = monForMember(m, state.fakemonDB);
    if (found) return found;
    const raw = String(m?.sourceFakemonId || '');
    if (!raw.startsWith('sd_')) return null;
    const p = state.sdPokedex?.[raw.slice(3)];
    if (!p) return null;
    m.vanilla = vanillaFakemonRecord(p);
    return m.vanilla;
}

// A Showdown dex entry in the shape everything below the teambuilder expects,
// so a vanilla pick travels through teams -> package -> engine exactly like a
// custom one.
function vanillaFakemonRecord(p, learnsetNames: any = null) {
    const names = learnsetNames
        || Object.keys(state.sdLearnsets?.[p.id] || {}).map(k => state.sdMoves?.[k]?.name).filter(Boolean);
    return {
        id: `sd_${p.id}`,
        name: p.name,
        stats: { ...p.stats },
        type1: p.types?.[0] || 'Normal',
        type2: p.types?.[1] || '',
        abilities: Object.values<any>(p.abilities || {}).map(name => ({ name, source: 'sd' })),
        learnset: names.map(name => ({ name })),
        artwork: `https://img.pokemondb.net/artwork/large/${vanillaArtSlug(p)}.jpg`,
        shinyArtwork: '',
        number: String(p.num || ''),
        isVanilla: true
    };
}

// Teams keep their vanilla snapshots up to date the moment the pane paints, so
// checkTeamReady() -- which only sees the collection -- never has to guess.
function healVanillaMembers() {
    for (const t of teams()) for (const m of t.members || []) monFor(m);
}

export function teamToSmogonText(team) {
    return (team.members || [])
        .map(m => memberToSmogonText(m, monFor(m)))
        .join('\n\n');
}

export function copyBattleTeam(teamId) {
    const t = findTeam(teamId); if (!t) return;
    navigator.clipboard.writeText(teamToSmogonText(t))
        .then(() => api.showToast?.('Team copied to clipboard!', 'success'))
        .catch(() => api.showToast?.('Could not access the clipboard.', 'error'));
}

export function downloadBattleTeam(teamId) {
    const t = findTeam(teamId); if (!t) return;
    const blob = new Blob([teamToSmogonText(t)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${String(t.name || 'team').replace(/[^a-z0-9-_ ]+/gi, '').trim() || 'team'}.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// The species named on a set's first line, resolved against the collection
// first and the Showdown dex second. A vanilla match is returned as the same
// frozen snapshot the picker builds, so an imported vanilla slot behaves
// exactly like a picked one.
function findSpeciesRecord(name) {
    const key = toId(name);
    if (!key) return null;
    const own = (state.fakemonDB || []).find(x => toId(x.name) === key);
    if (own) return own;
    const p = state.sdPokedex?.[key]
        || Object.values<any>(state.sdPokedex || {}).find(x => toId(x.name) === key);
    return p ? vanillaFakemonRecord(p) : null;
}

// "Nickname (Species) (M) @ Item" in all its optional parts.
function parseSetHeader(line) {
    const at = String(line || '').indexOf('@');
    let namePart = (at > 0 ? line.slice(0, at) : line).trim();
    namePart = namePart.replace(/\s*\((?:M|F)\)\s*$/i, '').trim();
    const nicknamed = namePart.match(/^(.*?)\s*\((.+)\)$/);
    if (nicknamed) return { nickname: nicknamed[1].trim(), species: nicknamed[2].trim() };
    return { nickname: '', species: namePart };
}

export async function importBattleTeam(teamId, text) {
    const t = findTeam(teamId); if (!t) return;
    const blocks = String(text || '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
    if (!blocks.length) { api.showToast?.('Nothing to import.', 'error'); return; }
    // A vanilla species is only usable once its learnset is in, so wait for it
    // rather than importing slots with an empty move pool.
    await api.ensureLearnsets?.();

    const members: any[] = [];
    const unknown: any[] = [];
    for (const block of blocks.slice(0, TEAM_FORMAT_RULES.maxMembers)) {
        const header = parseSetHeader(block.split('\n')[0]);
        const f = findSpeciesRecord(header.species);
        if (!f) { unknown.push(header.species || '(unnamed)'); continue; }
        const m: Record<string, any> = makeMember(f);
        if (f.isVanilla) m.vanilla = f;
        m.nickname = header.nickname;
        try { parseSmogonSetInto(m, block); }
        catch { /* a set with only a species line is still a usable slot */ }
        members.push(m);
    }
    if (!members.length) {
        api.showToast?.(`Could not find ${unknown.slice(0, 3).join(', ')} in your collection or the Pokédex.`, 'error');
        return;
    }
    t.members = members;
    t.updatedAt = Date.now();
    UI.editingSlotIndex = 0;
    api.saveToStorage?.();
    render();
    api.showToast?.(unknown.length
        ? `Imported ${members.length} Pokémon - skipped ${unknown.join(', ')}.`
        : `Imported ${members.length} Pokémon.`, unknown.length ? 'warning' : 'success');
}

export function selectBattleSlot(i) { UI.editingSlotIndex = i; render(); }

export function removeBattleMemberAt(teamId, index) {
    removeBattleMember(teamId, index);
    UI.editingSlotIndex = Math.max(0, Math.min(index, (findTeam(teamId)?.members.length || 1) - 1));
}

export function memberToSmogonText(m, f) {
    const lines: any[] = [];
    const species = f?.name || 'Missing';
    const head = m.nickname ? `${m.nickname} (${species})` : species;
    lines.push(m.item ? `${head} @ ${m.item}` : head);
    if (m.ability) lines.push(`Ability: ${m.ability}`);
    if (m.level && m.level !== 100) lines.push(`Level: ${m.level}`);
    const evParts = BATTLE_STAT_KEYS
        .map(k => [k, m.evs?.[k] || 0]).filter(([, v]) => v)
        .map(([k, v]) => `${v} ${BATTLE_STAT_LABELS[k]}`);
    if (evParts.length) lines.push(`EVs: ${evParts.join(' / ')}`);
    if (m.nature && m.nature !== 'Serious') lines.push(`${m.nature} Nature`);
    const ivParts = BATTLE_STAT_KEYS
        .map(k => [k, m.ivs?.[k] === undefined ? 31 : Number(m.ivs[k])])
        .filter(([, v]) => v !== 31)
        .map(([k, v]) => `${v} ${BATTLE_STAT_LABELS[k]}`);
    if (ivParts.length) lines.push(`IVs: ${ivParts.join(' / ')}`);
    for (const mv of (m.moves || [])) if (mv) lines.push(`- ${mv}`);
    return lines.join('\n');
}

export function copyBattleSet(teamId, index) {
    const t = findTeam(teamId); const m = t?.members[index]; if (!m) return;
    navigator.clipboard.writeText(memberToSmogonText(m, monFor(m)))
        .then(() => api.showToast?.('Set copied to clipboard!', 'success'))
        .catch(() => api.showToast?.('Could not access the clipboard.', 'error'));
}

const STAT_ALIASES = { hp: 'hp', atk: 'atk', att: 'atk', def: 'def', spa: 'spa', 'sp atk': 'spa', 'sp. atk': 'spa', satk: 'spa', spd: 'spd', 'sp def': 'spd', 'sp. def': 'spd', sdef: 'spd', spe: 'spe', spd2: 'spe' };

export function importBattleSet(teamId, index, text) {
    const t = findTeam(teamId); const m = t?.members[index]; if (!m) return;
    try {
        parseSmogonSetInto(m, text);
        t.updatedAt = Date.now();
        api.saveToStorage?.();
        render();
        api.showToast?.('Set imported.', 'success');
    } catch (e: any) {
        api.showToast?.(e.message || 'Could not read that set.', 'error');
    }
}

function parseSmogonSetInto(m, raw) {
    const lines = String(raw || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Nothing to import.');
    let sawMove = false;
    for (const line of lines) {
        if (line.startsWith('-') || line.startsWith('~')) {
            sawMove = true;
            const name = line.slice(1).trim();
            if (!name) continue;
            if (!m.moves) m.moves = [];
            if (m.moves.filter(Boolean).length < 4) m.moves.push(name);
            continue;
        }
        if (sawMove) continue;                       // stray text after moves
        const at = line.indexOf('@');
        if (/^ability\s*:/i.test(line)) { m.ability = line.split(':').slice(1).join(':').trim(); continue; }
        if (/^level\s*:/i.test(line)) { m.level = Math.max(1, Math.min(100, Number(line.split(':')[1]) || 100)); continue; }
        if (/^evs\s*:/i.test(line)) { applyStatLine(m, 'evs', line.split(':').slice(1).join(':')); continue; }
        if (/^ivs\s*:/i.test(line)) { applyStatLine(m, 'ivs', line.split(':').slice(1).join(':')); continue; }
        if (/\bnature\b/i.test(line)) { m.nature = line.replace(/\s*nature\b/i, '').trim() || 'Serious'; continue; }
        // First non-tagged line is "Name @ Item".
        if (at > 0) m.item = line.slice(at + 1).trim();
    }
}

function applyStatLine(m, kind, body) {
    m[kind] = m[kind] || {};
    for (const part of body.split('/')) {
        const mt = part.trim().match(/^(\d+)\s+([A-Za-z.\s]+)$/);
        if (!mt) continue;
        const key = STAT_ALIASES[mt[2].trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ')];
        if (!key) continue;
        const max = kind === 'evs' ? 252 : 31;
        m[kind][key] = Math.max(0, Math.min(max, Number(mt[1]) || 0));
    }
}

// ---- EV/IV editor, modelled on the sample-set stat rows ----
// Nature +/- buttons, base stat, EV input + slider (508 cap), IV input, and
// the calculated stat at level. Always visible, never collapsed.
export const BATTLE_STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const BATTLE_STAT_LABELS = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

export function battleCalcStat(base, ev, iv, nature, statKey, level) {
    const data = NATURE_DATA[nature];
    let mult = 1;
    if (data && data.up !== data.down) {
        if (data.up === statKey) mult = 1.1;
        if (data.down === statKey) mult = 0.9;
    }
    if (statKey === 'hp') return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + level + 10;
    return Math.floor((Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5) * mult);
}

// Nature +/- buttons. A nature is a PAIR -- one stat raised, one lowered --
// so clicking one half has to keep the other. Searching on the clicked half
// alone always returned the first nature with that boost, which is why +Atk was
// forever Adamant and Lonely, Brave and Naughty could not be reached at all:
// only six of the twenty-five were selectable.
export function setBattleNatureBoost(teamId, index, stat, dir) {
    const t = findTeam(teamId); const m = t?.members[index]; if (!m) return;
    const current = NATURE_DATA[m.nature || 'Serious'] || {};
    const neutral = current.up === current.down;
    let up = neutral ? null : current.up;
    let down = neutral ? null : current.down;
    // Clicking the half that is already set turns it off again.
    if (dir === 'up') up = (up === stat ? null : stat);
    else down = (down === stat ? null : stat);

    let next: any = null;
    if (up && down && up !== down) {
        next = Object.keys(NATURE_DATA).find(n => NATURE_DATA[n].up === up && NATURE_DATA[n].down === down);
    } else if (up || down) {
        // Only one half chosen so far: take any nature with it, which the next
        // click on the other half then refines.
        const half = up ? 'up' : 'down';
        const want = up || down;
        next = Object.keys(NATURE_DATA).find(n => {
            const d = NATURE_DATA[n];
            return d[half] === want && d.up !== d.down;
        });
    } else {
        next = 'Serious';                       // both halves cleared: neutral
    }
    if (!next) return;
    m.nature = next;
    t.updatedAt = Date.now();
    api.saveToStorage?.();
    render();
}

// ---- Browse Moves: the same dialog the editor uses (js/app/dialogs/moveBrowser.tsx),
// scoped to THIS member's learnset and writing into one move slot.
export function openBattleMoveBrowser(teamId, index, slot) {
    openDialog('move-browser', { mode: 'battle', target: { teamId, index, slot } });
}

// The moves this member may actually learn: its species learnset plus any
// custom moves it already references. Not the whole game's move list.
function memberLearnsetMoves(m) {
    const f = monFor(m);
    const names = new Set<string>((f?.learnset || []).map(x => x?.name).filter(Boolean));
    for (const mv of m.moves || []) if (mv) names.add(mv);
    const out: any[] = [];
    const seen = new Set();
    for (const name of names) {
        const custom = (state.customMoves || []).find(cm => cm.name === name);
        const sdEntry = Object.entries<any>(state.sdMoves).find(([, v]) => v.name === name)?.[1];
        const src = custom || sdEntry;
        if (!src || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        out.push({ key: custom ? 'custom:' + name : name, ...src, name, custom: !!custom });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Every move the game knows, for search. Moves outside this member's
// learnset are shown greyed out rather than hidden, so a search tells you the
// move exists and that this Pokemon cannot have it -- silently omitting it
// reads as a broken search.
function allBrowsableMoves() {
    const out: any[] = [];
    const seen = new Set();
    for (const cm of state.customMoves || []) {
        if (!cm?.name || seen.has(cm.name.toLowerCase())) continue;
        seen.add(cm.name.toLowerCase());
        out.push({ key: 'custom:' + cm.name, ...cm, name: cm.name, custom: true });
    }
    for (const sd of Object.values<any>(state.sdMoves || {})) {
        if (!sd?.name || seen.has(sd.name.toLowerCase())) continue;
        seen.add(sd.name.toLowerCase());
        out.push({ key: sd.name, ...sd, custom: false });
    }
    return out;
}

/**
 * The browser's list for one member: the moves it can learn that pass the
 * filters, then -- once a filter is set -- the ones it can't, greyed out, so a
 * search says the move exists but this Pokemon can't have it.
 */
export function battleMoveChoices(target, filters) {
    const t = findTeam(target?.teamId);
    const member = t?.members[target?.index];
    if (!member) return { learnable: [] as any[], locked: [] as any[] };
    const already = new Set((member.moves || []).filter(Boolean).map(x => x.toLowerCase()));
    const learnable = memberLearnsetMoves(member);
    const learnableNames = new Set(learnable.map(m => m.name.toLowerCase()));
    const matches = m => api.moveMatchesFilters(m, filters);
    const active = !!(String(filters?.name || '').trim() || filters?.type || filters?.category || filters?.bpMin);
    return {
        learnable: learnable.filter(matches).map(m => ({ ...m, added: already.has(m.name.toLowerCase()) })),
        locked: active ? allBrowsableMoves().filter(m => !learnableNames.has(m.name.toLowerCase())).filter(matches).sort((a, b) => a.name.localeCompare(b.name)) : []
    };
}

/** @returns whether the move went into the slot */
export function pickBattleMove(target, key): boolean {
    if (!target) return false;
    const { teamId, index, slot } = target;
    const t = findTeam(teamId); const m = t?.members[index];
    if (!m) return false;
    // Checked here as well as in the markup: the list is only the door, and a
    // move this Pokemon cannot learn must not get in through it.
    const move = memberLearnsetMoves(m).find(x => x.key === key);
    if (!move) {
        api.showToast?.('That Pokémon cannot learn that move.', 'warning');
        return false;
    }
    // Write into the exact slot that opened the browser.
    m.moves = m.moves || [];
    m.moves[slot] = move.name;
    t.updatedAt = Date.now();
    api.saveToStorage?.();
    render();
    return true;
}

// ---- team CRUD (all local, persisted through the existing storage layer) ----
export function createBattleTeam() {
    const t = makeTeam(`Team ${teams().length + 1}`);
    teams().push(t);
    UI.editingTeamId = t.id;
    api.saveToStorage?.();
    render();
}
export function editBattleTeam(id) { UI.editingTeamId = id; render(); }
export function closeBattleTeamEditor() { UI.editingTeamId = null; render(); }
export function renameBattleTeam(id, name) {
    const t = findTeam(id); if (!t) return;
    t.name = name; t.updatedAt = Date.now();
    api.saveToStorage?.();
}
export function duplicateBattleTeam(id) {
    const t = findTeam(id); if (!t) return;
    const copy = JSON.parse(JSON.stringify(t));
    copy.id = makeTeam().id; copy.name = `${t.name} copy`; copy.createdAt = Date.now();
    teams().push(copy); api.saveToStorage?.(); render();
}
export async function deleteBattleTeam(id) {
    const t = findTeam(id); if (!t) return;
    if (!await confirmDialog({ title: `Delete team “${t.name}”?`, message: 'The Fakémon in it stay in your collection.' })) return;
    state.battleTeams = teams().filter(x => x.id !== id);
    if (UI.editingTeamId === id) UI.editingTeamId = null;
    api.saveToStorage?.(); render();
}
export function removeBattleMember(teamId, index) {
    const t = findTeam(teamId); if (!t) return;
    t.members.splice(index, 1); t.updatedAt = Date.now();
    api.saveToStorage?.(); render();
}
export function moveBattleMember(teamId, index, dir) {
    const t = findTeam(teamId); if (!t) return;
    const to = index + dir;
    if (to < 0 || to >= t.members.length) return;
    [t.members[index], t.members[to]] = [t.members[to], t.members[index]];
    api.saveToStorage?.(); render();
}
export function setBattleMember(teamId, index, key, value) {
    const t = findTeam(teamId); const m = t?.members[index]; if (!m) return;
    if (key === 'level') m.level = Math.max(1, Math.min(100, Number(value) || 100));
    else if (key === 'item') m.item = canonicalItemName(value);
    else m[key] = value;
    t.updatedAt = Date.now(); api.saveToStorage?.();
    if (key === 'item') render();
}

// Every item the builder knows about: Showdown's table plus anything from the
// user's own item library.
export function allItemNames() {
    const names = Object.values<any>(state.sdItems || {}).map(i => i?.name).filter(Boolean);
    for (const ci of state.customItems || []) if (ci?.name) names.push(ci.name);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

// Snaps what was typed onto the real item name, so casing and punctuation stop
// mattering. An entry that matches nothing is kept as-is but flagged, rather
// than quietly doing nothing for the whole battle.
function canonicalItemName(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const match = allItemNames().find(n => toId(n) === toId(raw));
    if (match) return match;
    api.showToast?.(`"${raw}" isn't a known item - it will have no effect.`, 'warning');
    return raw;
}
export function setBattleMove(teamId, index, slot, value) {
    const t = findTeam(teamId); const m = t?.members[index]; if (!m) return;
    m.moves = m.moves || [];
    m.moves[slot] = String(value || '').trim();
    m.moves = m.moves.filter((x, i) => x || i < 4);
    t.updatedAt = Date.now(); api.saveToStorage?.(); render();
}
export function setBattleStat(teamId, index, kind, stat, value) {
    const t = findTeam(teamId); const m = t?.members[index]; if (!m) return;
    m[kind] = m[kind] || {};
    const max = kind === 'evs' ? 252 : 31;
    m[kind][stat] = Math.max(0, Math.min(max, Number(value) || 0));
    t.updatedAt = Date.now(); api.saveToStorage?.();
    render();   // recalculate and repaint the stat rows
}

// ---- Fakemon picker (reuses the collection card look; also offers the
// vanilla Showdown dex, converted into fakemon-shaped records on pick) ----
export function openBattleMonPicker(teamId) {
    UI.pickerTeamId = teamId;
    openDialog('battle-mon-picker', { initialTab: 'custom' });
}

/** The picker's Community tab reads the hub's feed, fetched here when it isn't loaded yet. */
export function loadBattlePickerCommunity() {
    return Promise.resolve(api.fetchCommunityFeed?.())
        .then(notify)
        .catch(e => log.warn('BATTLE', 'Community picker feed failed', e));
}

// a region's edited main-game Pokemon; ones only opened (pending) aren't real yet
export function regionEditedMons() {
    return (state.fakemonDB || []).filter(f => f.vanillaId && !f.pendingVanilla && (api.entryRegionIds?.(f) || []).length);
}

export function vanillaArtSlug(p) {
    // pokemondb artwork slugs: lowercase, hyphenated, formes like
    // "Keldeo-Resolute" become "keldeo-resolute".
    return String(p.name || p.id).toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, '-');
}

// Converts a Showdown dex entry into a fakemon-shaped record so every layer
// below (teams -> package -> engine) treats it exactly like a custom mon.
export async function pickVanillaMon(sdId) {
    const t = findTeam(UI.pickerTeamId);
    const p = state.sdPokedex?.[sdId];
    if (!t || !p) return;
    // The picker builds the mon's whole move pool from learnsets, which load
    // lazily -- wait for them rather than silently producing an empty movepool.
    await api.ensureLearnsets?.();
    const learnset = Object.keys(state.sdLearnsets?.[sdId] || {})
        .map(k => state.sdMoves[k]?.name).filter(Boolean);
    const f = vanillaFakemonRecord(p, learnset);
    const member: Record<string, any> = makeMember(f);
    // The snapshot rides on the member: a vanilla Pokemon has no collection
    // record for `sourceFakemonId` to resolve against.
    member.vanilla = f;
    // Pre-fill four moves from the learnset so a new slot is immediately usable.
    member.moves = learnset.slice(0, 4);
    t.members.push(member);
    t.updatedAt = Date.now();
    closeDialog('battle-mon-picker');
    api.saveToStorage?.(); render();
}

// A Fakémon someone else published. The hub feed row is deliberately slim
// (no artwork, no learnset), so the full record is fetched on pick and then
// frozen onto the member exactly like a vanilla pick -- it is a snapshot, not
// a link, so the team keeps working if the author later edits or unpublishes.
export async function pickCommunityMon(publishedId) {
    const t = findTeam(UI.pickerTeamId);
    if (!t) return;
    let row: any = null;
    try {
        const client = await api.getClient();
        // Was a plain `.from('published_mons').select(...)`, which put the
        // author's full-resolution artwork in a response body as readable
        // base64 -- the exact route community_mon_detail()/community_mon_images()
        // exist to close. The detail RPC hands back the row with every image
        // key stripped; the images RPC hands back those images masked, and
        // they are unmasked here in memory because the battle renderer
        // (scene.ts, field3d.ts) draws from a URL and nothing else.
        const [detail, images] = await Promise.all([
            client.rpc('community_mon_detail', { p_id: publishedId }),
            client.rpc('community_mon_images', { p_id: publishedId })
        ]);
        if (detail.error) throw detail.error;
        if (images.error) throw images.error;
        row = detail.data;
        if (row?.fakemon_data) Object.assign(row.fakemon_data, await ownArtwork(images.data));
    } catch (e: any) {
        log.error('BATTLE', 'Could not load community Fakémon', e);
    }
    const f = communityFakemonRecord(row);
    if (!f) { api.showToast?.('Could not load that Fakémon.', 'error'); return; }
    const member: Record<string, any> = makeMember(f);
    member.vanilla = f;
    member.moves = (f.learnset || []).slice(0, 4).map(x => x?.name).filter(Boolean);
    t.members.push(member);
    t.updatedAt = Date.now();
    closeDialog('battle-mon-picker');
    api.saveToStorage?.(); render();
}

// The post's own artwork out of community_mon_images(). source_id '' is the
// mon the post is about; the other rows are its evolution family, which a
// battle pick does not use.
async function ownArtwork(rows) {
    const out: Record<string, any> = {};
    for (const r of rows || []) {
        if (r?.source_id) continue;
        if (r.kind !== 'artwork' && r.kind !== 'shinyArtwork') continue;
        out[r.kind] = await artworkDataUri(maskedArtwork(r.image));
    }
    return out;
}

// A published row in the shape the rest of the battle stack expects. The id is
// namespaced on the publication rather than reusing the author's local
// fakemon id, which would otherwise collide with the viewer's own collection
// and make monForMember() silently resolve to the wrong Pokémon.
function communityFakemonRecord(row) {
    const d = row?.fakemon_data;
    if (!d || !d.stats) return null;
    return {
        ...d,
        id: `com_${row.id}`,
        name: d.name || 'Unnamed',
        stats: { ...d.stats },
        type1: d.type1 || 'Normal',
        type2: d.type2 || '',
        abilities: (d.abilities || []).map(a => ({ ...a })),
        // The author's custom ability programs, embedded on the record at
        // publish time. Their block ASTs are the only reason a borrowed
        // Fakemon's ability actually does something in a battle here.
        customAbilities: (d.customAbilities || []).filter(a => a && a.name),
        learnset: (d.learnset || []).filter(m => m && m.name),
        artwork: d.artwork || '',
        shinyArtwork: d.shinyArtwork || '',
        isCommunity: true,
        communityAuthor: row.author_name || ''
    };
}

export function pickBattleMon(fakemonId) {
    const t = findTeam(UI.pickerTeamId);
    const f = (state.fakemonDB || []).find(x => String(x.id) === String(fakemonId));
    if (!t || !f) return;
    const member = makeMember(f);
    // Pre-fill four moves from the learnset so a new slot is immediately usable.
    member.moves = (f.learnset || []).slice(0, 4).map(x => x?.name).filter(Boolean);
    t.members.push(member);
    t.updatedAt = Date.now();
    closeDialog('battle-mon-picker');
    api.saveToStorage?.(); render();
}

// ==================== lobby pane ====================
async function ensureLobby() {
    if (!state.user) { render(); return; }
    if (!UI.lobby) {
        UI.lobby = new BattleLobby({
            onLobby: list => { UI.players = list; notify(); },
            onChallenges: list => { UI.challenges = list; notify(); },
            onBattleStart: (battle) => {
                // Already in this battle, or already choosing a lead for it:
                // being told about it again is not a reason to start over.
                if (UI.meta?.battleId === battle.id) return;
                if (UI.leadPick?.battle?.id === battle.id) return;
                // The accepting side picks its lead on the battle screen.
                const pkg = UI.myPendingPackage;
                UI.pendingBattleRow = battle;
                UI.leadPick = { kind: 'pvp', battle, pkg, lead: 0, field: fieldForSeed(battle.seed) };
                UI.pane = 'battle';
                render();
            },
            onError: e => setStatus(e?.message || String(e))
        });
    }
    const status = UI.searching ? 'searching' : 'open';
    if (!UI.lobby.joined) await UI.lobby.join(status);
    else await UI.lobby.setStatus(status);
}

/** Teams that pass every check, for the team pickers. */
export function readyTeams() {
    return teams().filter(t => !checkTeamReady(t, state.fakemonDB).length);
}

export async function refreshBattleLobby() { await UI.lobby?.refresh(); notify(); }

// Find Match is just a presence status: it says "I want a game" so other
// trainers can see you rather than everyone having to sit on this screen at the
// same moment hoping to catch each other.
export async function toggleFindMatch() {
    if (!state.user) { api.showToast?.('Sign in to find a match.', 'warning'); return; }
    if (!UI.searching) {
        // Refuse to advertise without a legal team, so nobody challenges into
        // an error.
        if (!selectedTeamPackage('find')) return;
    }
    UI.searching = !UI.searching;
    await ensureLobby();
    await UI.lobby?.setStatus(UI.searching ? 'searching' : 'open');
    await refreshBattleLobby();
    render();
}

/** Which of your teams a picker names; 'find' or 'bot'. */
function pickedTeamId(which) {
    const ready = readyTeams();
    const chosen = which === 'find' ? UI.findTeamId : UI.botTeamId;
    return (ready.find(t => t.id === chosen) || ready[0] || teams()[0])?.id;
}

/** Sets which team the Find Match ('find') or practice ('bot') picker names. */
export function setBattleTeamChoice(which, teamId) {
    if (which === 'find') UI.findTeamId = teamId; else UI.botTeamId = teamId;
    notify();
}

function selectedTeamPackage(which = 'bot') {
    const id = pickedTeamId(which);
    const team = findTeam(id);
    if (!team) { api.showToast?.('Build a team first.', 'warning'); return null; }
    healVanillaMembers();
    const problems = checkTeamReady(team, state.fakemonDB);
    if (problems.length) { api.showToast?.(problems[0], 'warning'); return null; }
    return toPeerPackage(team, state.fakemonDB, {
        customMoves: state.customMoves, customAbilities: state.customAbilities, customItems: state.customItems
    });
}

export async function challengePlayer(userId, name) {
    const pkg = selectedTeamPackage('find') || selectedTeamPackage('bot');
    if (!pkg) return;
    try {
        await UI.lobby.challenge(userId, toServerSnapshot(pkg), publicName(state.user));
        UI.myPendingPackage = pkg;   // kept locally so artwork survives the round trip
        api.showToast?.(`Challenge sent to ${name}.`, 'success');
        await refreshBattleLobby();
    } catch (e: any) { api.showToast?.(e.message || String(e), 'error'); }
}

export async function cancelBattleChallenge(id) {
    try { await UI.lobby.cancelChallenge(id); await refreshBattleLobby(); }
    catch (e: any) { api.showToast?.(e.message || String(e), 'error'); }
}
export async function declineChallenge(id) {
    try { await UI.lobby.decline(id); await refreshBattleLobby(); }
    catch (e: any) { api.showToast?.(e.message || String(e), 'error'); }
}
export async function acceptChallenge(id) {
    const pkg = selectedTeamPackage('find');
    if (!pkg) return;
    try {
        UI.myPendingPackage = pkg;
        const battle = await UI.lobby.accept(id, toServerSnapshot(pkg));
        if (battle) {
            // The lead is chosen on the battle screen itself (see
            // renderLeadPane); stage the pending row and show the picker.
            UI.pendingBattleRow = battle;
            // We are going there ourselves; the poll should not send us again.
            UI.lobby?.markAnnounced(battle.id);
            UI.leadPick = { kind: 'pvp', battle, pkg, lead: 0, field: fieldForSeed(battle.seed) };
            UI.pane = 'battle';
            render();
        }
    } catch (e: any) { api.showToast?.(e.message || String(e), 'error'); }
}

// ==================== lead picker ====================
// A team package carries everything needed to draw its own members --
// source_fakemon_id (snake_case, as it goes over the wire), name and artwork.
// Reading `sourceFakemonId` off it always missed, which is why every lead card
// said "Unknown" and showed no picture.
// Your own team, on the screen where you choose who leads. The roster a lead
// is picked against has to be the roster the battle is actually built from, or
// the index means one Pokemon here and a different one in the engine. For PvP
// that is the battle row's copy, not the local one: artwork is the only thing
// the row is missing, and memberFace() below fills that back in from this
// browser's collection anyway.
export function myLeadMembers(pick) {
    if (!pick) return [];
    if (pick.kind !== 'pvp') return pick.pkg?.members || [];
    const row = pick.battle;
    const mine = String(row?.p1_id) === String(state.user?.id ?? '') ? row?.p1_team : row?.p2_team;
    return mine?.members || pick.pkg?.members || [];
}

// The team you are about to face, as package members. In a bot battle that is
// a local team, so it comes complete with artwork; in PvP it is the copy stored
// on the battle row, which has artwork stripped on purpose (six base64 images
// per challenge would bloat the table) -- so names are all there is to show,
// and names are what a team preview is for.
export function leadOpponentMembers(pick) {
    if (!pick) return [];
    if (pick.oppPkg) return pick.oppPkg.members || [];
    const row = pick.battle;
    if (!row) return [];
    const me = String(state.user?.id ?? '');
    const iAmP1 = String(row.p1_id) === me;
    const iAmP2 = String(row.p2_id) === me;
    if (!iAmP1 && !iAmP2) return [];
    return (iAmP1 ? row.p2_team : row.p1_team)?.members || [];
}

export function memberFace(m, db = state.fakemonDB) {
    const f = (db || []).find(x => String(x.id) === String(m?.source_fakemon_id ?? m?.sourceFakemonId));
    return {
        name: m?.nickname || m?.name || f?.name || 'Unknown',
        artwork: m?.artwork || f?.artwork || ''
    };
}

// Showdown asks "who leads?" before the battle builds. Here that choice lives
// on the battle screen: a team strip with a "Start Battle" button, so you can
// see your full team before committing to a lead.
export function setBattleLead(i) {
    if (!UI.leadPick) return;
    UI.leadPick.lead = i;
    notify();
}

export function confirmLeadAndStart() {
    const pick = UI.leadPick;
    if (!pick) return;
    UI.leadPick = null;
    if (pick.kind === 'bot') startBotBattleWithLead(pick.pkg, pick.lead, pick.seed, pick.oppPkg);
    else startPvpBattle(pick.battle, pick.lead);
}

export function cancelLeadPick() {
    detachPreviewScene();
    UI.leadPick = null;
    UI.pendingBattleRow = null;
    UI.pane = 'lobby';
    render();
}

// ==================== starting battles ====================
// `includeLocal` folds this browser's own custom library in on top of what the
// two packages carry. Right for a bot battle, where both teams are this
// player's and the local library IS the source. Wrong for PvP, where it is the
// one input the opponent cannot see: see the call site in startPvpBattle.
function buildDex(pkgA, pkgB, { includeLocal = true }: { includeLocal?: any } = {}) {
    return new BattleDex({
        sdMoves: state.sdMoves, sdItems: state.sdItems, sdAbilities: state.sdAbilities,
        ...mergeDexPayload(pkgA, pkgB, includeLocal ? {
            customMoves: state.customMoves, customAbilities: state.customAbilities, customItems: state.customItems
        } : {})
    });
}

// The bot fights one of your other finished teams, or mirrors the one you
// picked when there is nothing else. Chosen here rather than at Start, because
// this reads a control on the teams pane and the lead screen needs the answer.
function pickBotPackage(pkg) {
    const others = teams().filter(t => t.id !== pickedTeamId('bot'));
    const botTeam = others.find(t => !checkTeamReady(t, state.fakemonDB).length);
    return botTeam
        ? toPeerPackage(botTeam, state.fakemonDB, {
            customMoves: state.customMoves, customAbilities: state.customAbilities, customItems: state.customItems
        })
        : JSON.parse(JSON.stringify(pkg));
}

export function startBotBattle() {
    const pkg = selectedTeamPackage('bot');
    if (!pkg) return;
    const oppPkg = pickBotPackage(pkg);
    // Lead is chosen on the battle screen (renderLeadPane), not in a modal.
    // The seed is drawn now rather than at Start, so the field standing behind
    // the lead picker is the one the battle will actually be fought on.
    const seed = 'bot-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    UI.leadPick = { kind: 'bot', pkg, oppPkg, lead: 0, seed, field: fieldForSeed(seed) };
    UI.pane = 'battle';
    render();
}

function startBotBattleWithLead(pkg, leadIndex, seed, oppPkg) {
    // The bot mirrors your own team when you have nothing else to fight, so a
    // practice battle is always possible with a single team built.
    // Already chosen on the lead screen, so what you were shown is what you get.
    const botPkg = oppPkg || pickBotPackage(pkg);

    // Checked the same way an opponent's team is. A side with nothing on it
    // used to read as a side that had already been swept, which handed the
    // other player the battle before a single move was made.
    const problems = [...checkIncomingPackage(pkg), ...checkIncomingPackage(botPkg)];
    if (problems.length) {
        api.showToast?.(`Could not start: ${problems[0]}`, 'error');
        UI.pane = 'teams';
        render();
        return;
    }

    let battle;
    try {
        battle = new Battle({
            seed: seed || ('bot-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
            dex: buildDex(pkg, botPkg),
            // Both teams in a bot battle are this player's own, so any code
            // they wrote by hand is safe to run - it is their code, in their
            // own browser. A PvP battle never sets this: see sd-hooks.ts.
            trustLocalCode: true,
            sides: [packageToSide(pkg, 'p1', 'You', leadIndex), packageToSide(botPkg, 'p2', 'Bot')]
        });
    } catch (e: any) {
        api.showToast?.(`Could not start: ${e.message}`, 'error');
        UI.pane = 'teams'; render(); return;
    }
    UI.battle = battle;
    UI.meta = { mode: 'bot', mySide: 0, oppName: battle.sides[1].name };
    UI.logCursor = 0;
    UI.pane = 'battle';
    attachScene(battle, 0);
    render();
    startTimer();
}

function startPvpBattle(battleRow, leadIndex = 0) {
    if (UI.battle && UI.meta?.battleId === battleRow.id) return;
    const iAmP1 = battleRow.p1_id === state.user?.id;
    const mySide = iAmP1 ? 0 : 1;
    // BOTH teams come off the battle row, including this player's own. The
    // local package is nominally the same team, but UI.myPendingPackage is a
    // single slot that every new challenge overwrites -- so send a second
    // challenge before the first is accepted, and this client built the battle
    // from one team while the opponent built it from another. Lockstep cannot
    // survive the two ends disagreeing about what is on the field, and the row
    // is the only copy both ends can see. The local package is still used, for
    // artwork and nothing else (see paintSideArtwork).
    const p1Pkg = battleRow.p1_team;
    const p2Pkg = battleRow.p2_team;

    // Both sides. Only the opponent's was checked, so a local team that had
    // somehow emptied out started a battle it had already lost.
    const problems = [...checkIncomingPackage(p1Pkg), ...checkIncomingPackage(p2Pkg)];
    if (problems.length) {
        api.showToast?.(`Could not start: ${problems[0]}`, 'error');
        UI.pane = 'lobby';
        render();
        return;
    }

    // The lead was picked against the roster the picker showed. That is now the
    // row's roster too, but clamp anyway rather than let a stale index seat
    // nobody and quietly fall back to slot 0 on one client only.
    const myTeamSize = (iAmP1 ? p1Pkg : p2Pkg)?.members?.length || 0;
    const wanted = Number(leadIndex) || 0;
    const myLead = wanted >= 0 && wanted < myTeamSize ? wanted : 0;
    let battle;
    try {
        battle = new Battle({
            seed: battleRow.seed,
            // No local library in a PvP dex. Merging this browser's own custom
            // moves and abilities in gave each client a dex the other did not
            // have, and worse, it papered over a packaging bug: content a team
            // referenced but failed to bundle still resolved for whoever
            // happened to own it locally, and resolved to nothing for the
            // opponent. Both clients now build from exactly what the row
            // carries, so either both have a thing or neither does.
            dex: buildDex(p1Pkg, p2Pkg, { includeLocal: false }),
            sides: [
                packageToSide(p1Pkg, 'p1', 'Player 1', iAmP1 ? myLead : 0),
                packageToSide(p2Pkg, 'p2', 'Player 2', iAmP1 ? 0 : myLead)
            ]
        });
    } catch (e: any) {
        api.showToast?.(`Could not start: ${e.message}`, 'error');
        UI.pane = 'lobby'; render(); return;
    }
    UI.battle = battle;
    UI.meta = {
        mode: 'pvp', mySide, battleId: battleRow.id, row: battleRow, oppName: 'Opponent',
        rtc: null as any, actionLog: [] as any[], remoteChoice: null as any, remoteHash: null as any,
        connStatus: 'connecting', timerStarted: false, desynced: false,
        // Filled in by the peer-to-peer team exchange below: the opponent's
        // package in full (artwork included), and the chunk buffer building it.
        oppPkg: null as any, oppTeamChunks: null as any,
        // Whoever this player put in front. The sides above were built with the
        // opponent's lead defaulted to slot 0 because there is no way to know
        // it yet; theirs arrives with their hello and is seated before turn 1.
        myLead,
        // Set once both clients have said what rules they are running. No turn
        // may be played before then -- see readyToPlay().
        myHello: null as any, handshake: null as any, handshakeTimer: null as any,
        // Each side's digest of the battle it actually built, compared before
        // turn one so a mismatch is caught while it can still be explained.
        mySetup: null as any, theirSetup: null as any, setupVerified: false, desyncReason: ''
    };
    UI.logCursor = 0;
    UI.pane = 'battle';
    UI.searching = false;
    UI.lobby?.setStatus('busy');
    attachScene(battle, mySide);
    // The row's copy of this player's own team has no pictures in it, so put
    // them back from the local copy. Cosmetic, and never fed to the engine.
    paintSideArtwork(mySide, UI.myPendingPackage);
    render();

    UI.meta.rtc = new BattleRTC({
        battleId: battleRow.id, mySide,
        onStatus: handleRtcStatus,
        onMessage: handleRtcMessage
    });
    UI.meta.rtc.start().catch(e => setStatus(e.message || String(e)));
    armHandshakeDeadline();
}

// ==================== PvP transport (WebRTC via Metered.ca) ====================
// Supabase only ever carries the WebRTC handshake (see net/rtc.ts). Every
// choice, forced switch, and desync check below travels peer-to-peer once
// the data channel is open.
function handleRtcStatus(status) {
    if (!UI.meta || UI.meta.mode !== 'pvp') return;
    UI.meta.connStatus = status;
    if (status === 'connected') {
        setStatus('');
        sendHello();
        sendMyTeam();
        if (!UI.meta.timerStarted) { UI.meta.timerStarted = true; startTimer(); }
        else resetTimer();
        if (UI.meta.resyncing) UI.meta.rtc.send({ type: MSG.RESYNC_REQUEST });
    } else if (status === 'connecting') {
        setStatus('Connecting to opponent…');
    } else if (status === 'reconnecting') {
        setStatus('Connection to opponent lost - reconnecting…');
        UI.meta.oppTeamChunks = null;
        UI.meta.resyncing = true;
        stopTimer();
    } else if (status === 'lost') {
        setStatus(UI.meta.rtc?.lastError || 'Could not reconnect to your opponent.');
    }
    render();
}

function handleRtcMessage(msg) {
    const b = UI.battle;
    if (!b || !UI.meta || UI.meta.mode !== 'pvp' || b.ended || UI.meta.desynced) return;
    const oppSide = 1 - UI.meta.mySide;
    switch (msg.type) {
        case MSG.HELLO: {
            applyHello(msg);
            break;
        }
        case MSG.SETUP: {
            UI.meta.theirSetup = msg;
            checkSetup();
            break;
        }
        case MSG.TEAM: {
            receiveTeamChunk(msg);
            break;
        }
        case MSG.CHOICE: {
            if (msg.turn !== b.turn + 1) return;
            UI.meta.remoteChoice = msg;
            tryResolveTurn();
            break;
        }
        case MSG.SWITCH: {
            if (b.needsSwitch(oppSide)) {
                b.switchTo(oppSide, msg.index);
                UI.meta.actionLog.push({ kind: 'switch', turn: b.turn, side: oppSide, index: msg.index });
                paintAll();
            }
            break;
        }
        case MSG.HASH: {
            UI.meta.remoteHash = { turn: msg.turn, hash: msg.hash };
            checkHash();
            break;
        }
        case MSG.RESYNC_REQUEST: {
            UI.meta.rtc.send({ type: MSG.RESYNC, actions: UI.meta.actionLog });
            break;
        }
        case MSG.RESYNC: {
            applyResync(msg.actions);
            break;
        }
        case MSG.FORFEIT: {
            b.forfeit(oppSide);
            paintAll();
            onBattleEnded();
            break;
        }
        case MSG.CHAT: {
            appendChatLine('foe', msg.text);
            break;
        }
    }
}

// ==================== battle chat ====================
// Chat lines ride the same data channel as choices but never touch the
// simulation -- they only ever land in the log pane.
/** @returns whether it was sent */
export function sendBattleChat(message): boolean {
    const text = String(message || '').trim();
    if (!text || UI.meta?.mode !== 'pvp') return false;
    UI.meta.rtc?.send({ type: MSG.CHAT, text });
    appendChatLine('me', text);
    return true;
}

function appendChatLine(who, text) {
    const logEl = document.getElementById('battle-log');
    if (!logEl) return;
    const name = who === 'me'
        ? (state.user?.displayName || state.user?.username || 'You')
        : (UI.meta?.oppName || 'Opponent');
    logEl.insertAdjacentHTML('beforeend',
        `<div class="battle-chat-line is-${who}"><span class="battle-chat-name">${esc(name)}</span> ${esc(text)}</div>`);
    logEl.scrollTop = logEl.scrollHeight;
}

// Fires once both this side's own choice and the opponent's have arrived;
// both clients call this independently and each resolves its own Battle
// instance, which is what keeps the two in lockstep.
function tryResolveTurn() {
    const b = UI.battle;
    if (!b || !UI.pendingChoice || !UI.meta.remoteChoice) return;
    if (!readyToPlay()) return;   // the choice keeps until the rules are settled
    const nextTurn = b.turn + 1;
    if (UI.meta.remoteChoice.turn !== nextTurn) return;
    const oppSide = 1 - UI.meta.mySide;
    const myChoice = UI.pendingChoice;
    const oppChoice = UI.meta.remoteChoice.choice;
    UI.meta.remoteChoice = null;
    b.choose(oppSide, oppChoice);
    const pair = UI.meta.mySide === 0 ? [myChoice, oppChoice] : [oppChoice, myChoice];
    UI.meta.actionLog.push({ kind: 'turn', turn: nextTurn, choices: pair });
    runTurnNow();
    if (!UI.battle) return;
    UI.meta.rtc?.send({ type: MSG.HASH, turn: b.turn, hash: b.stateHash() });
    checkHash();
}

// Compares the two sides' post-turn state hash. A mismatch means the two
// simulations diverged -- rather than let the game continue on
// inconsistent state, the match is voided.
// ==================== ruleset handshake ====================
// Both clients state which engine and which Showdown datasets they hold, and
// the battle is then compiled from what they BOTH have. Without this, a player
// whose CDN fetch failed would silently run a different simulation from their
// opponent: every Wicked Blow, every Gyro Ball, every Metronome roll would
// resolve differently, and the first sign of it would be a desync several
// turns in with no way back.
//
// Sent on every (re)connect. Only the first agreement counts -- a battle in
// progress never changes rules underneath itself.
// Counted from the moment the battle screen opens rather than from the moment
// the data channel does. The two are not the same wait: the opponent is still
// on their own lead-picker while this side is already sitting in the battle,
// so a deadline that only started on connect never started at all for a player
// whose opponent never arrived. That left the choice buttons answering every
// tap with "still agreeing on the rules" and no way out of it. Long enough to
// cover a slow lead pick plus ICE.
const HANDSHAKE_TIMEOUT_MS = 45000;

// Idempotent: whichever of "the battle opened" or "the channel opened" happens
// first arms it, and later calls leave the running deadline alone rather than
// pushing it out again.
function armHandshakeDeadline() {
    if (!UI.meta || UI.meta.mode !== 'pvp' || UI.meta.handshakeTimer || readyToPlay()) return;
    UI.meta.handshakeTimer = setTimeout(() => {
        if (!UI.meta || readyToPlay()) return;
        if (UI.meta.handshake && !UI.meta.handshake.ok) return;   // already refused, with a better reason
        // Three different silences, three different sentences. The deadline
        // covers the setup exchange as well as the hello, because "agreed on
        // the rules but never confirmed the battle" is just as stuck as never
        // having spoken, and it used to have no deadline at all.
        const reason = UI.meta.handshake?.ok
            ? 'Your opponent never confirmed the battle. One of you should go back '
                + 'to the lobby and start it again.'
            : UI.meta.connStatus === 'connected'
                ? 'Your opponent is on an older version of the battle engine. '
                    + 'One of you needs to reload the page.'
                : 'Could not reach your opponent. They may not have finished choosing '
                    + 'their lead, or the connection between you is being blocked.';
        UI.meta.handshake = { ok: false, reason };
        render();
    }, HANDSHAKE_TIMEOUT_MS);
}

function sendHello() {
    if (!UI.meta || UI.meta.mode !== 'pvp') return;
    armHandshakeDeadline();
    UI.meta.myHello = {
        engine: ENGINE_VERSION,
        moves: movesFingerprint(),
        abilities: abilitiesFingerprint(),
        items: itemsFingerprint(),
        lead: Number(UI.meta.myLead) || 0
    };
    UI.meta.rtc?.send({ type: MSG.HELLO, ...UI.meta.myHello });
}

function applyHello(theirs) {
    const b = UI.battle;
    if (!b || !UI.meta || UI.meta.handshake) return;   // agreed once, agreed for good
    // The deadline is deliberately left running: agreeing on the rules is only
    // half of being ready, and the other half (checkSetup) needs a deadline of
    // its own. It is cleared there, once there is genuinely nothing left to
    // wait for.
    if (!UI.meta.myHello) sendHello();
    const mine = UI.meta.myHello;

    const blocker = handshakeBlocker(mine, theirs);
    if (blocker) {
        UI.meta.handshake = { ok: false, reason: blocker };
        setStatus(blocker);
        render();
        return;
    }

    const agreed = negotiateCaps(mine, theirs);
    b.setCaps(agreed);
    // Seat their real lead. Until this arrives both clients had the opponent
    // starting from slot 0, so a player who picked anyone else was simulated
    // differently on the two machines and the very first state hash diverged.
    b.setLead(1 - UI.meta.mySide, Number.isInteger(theirs.lead) ? theirs.lead : 0);
    UI.scene?.paint();
    const lost = reducedCaps(mine, agreed);
    UI.meta.handshake = { ok: true, lost };

    // Rules agreed and both leads seated: this client's picture of the battle
    // is now complete, so say what it is and check it against theirs. Sent
    // here rather than on connect because the digest covers the negotiated
    // caps and the opponent's lead, neither of which existed a moment ago.
    UI.meta.mySetup = b.setupDigest();
    UI.meta.rtc?.send({ type: MSG.SETUP, ...UI.meta.mySetup });

    if (lost.length) {
        // Worth saying out loud: the battle is playable but not the full game,
        // and the player would otherwise just see moves quietly doing nothing.
        api.showToast?.(`Your opponent could not load Showdown's ${lost.join(' or ')}, so this battle runs without them.`, 'warning');
    }
    paintControls();

    // Last, because it can void the battle outright: their digest may already
    // be sitting here, or may still be in flight, and the check runs on
    // whichever half lands second and picks up anything held behind it.
    checkSetup();
}

// ==================== full team exchange ====================
// Challenges travel through the database, and the copy stored on the battle
// row has every Pokemon's artwork stripped (six base64 images per row would
// bloat the table badly). The engine data survives that trip -- stats, moves,
// abilities, and both players' bundled custom content are all on the row -- but
// the pictures do not, which is why each side used to face a team of blank
// silhouettes.
//
// So once the peer-to-peer channel is open, each client sends its OWN package
// in full, artwork and all, straight to the other. Nothing here touches the
// simulation: only presentation fields are filled in, and none of them are part
// of the state hash, so the two clients stay in lockstep whether the exchange
// lands, arrives late, or never happens at all.
function sendMyTeam() {
    if (!UI.meta || UI.meta.mode !== 'pvp') return;
    const pkg = UI.myPendingPackage;
    if (!pkg) return;
    const text = JSON.stringify(pkg);
    const total = Math.max(1, Math.ceil(text.length / TEAM_CHUNK_CHARS));
    if (total > 512) return;    // beyond what the protocol will accept; the row copy still plays
    for (let seq = 0; seq < total; seq++) {
        UI.meta.rtc?.send({
            type: MSG.TEAM, seq, total,
            data: text.slice(seq * TEAM_CHUNK_CHARS, (seq + 1) * TEAM_CHUNK_CHARS)
        });
    }
}

function receiveTeamChunk(msg) {
    if (!UI.meta) return;
    let buf = UI.meta.oppTeamChunks;
    // A different `total` means a fresh send (the peer reconnected mid-transfer),
    // so the half-filled buffer is dropped rather than mixed with the new one.
    if (!buf || buf.total !== msg.total) {
        buf = UI.meta.oppTeamChunks = { total: msg.total, parts: new Array(msg.total).fill(null) };
    }
    buf.parts[msg.seq] = msg.data;
    if (buf.parts.some(part => part === null)) return;
    UI.meta.oppTeamChunks = null;
    let pkg;
    try { pkg = JSON.parse(buf.parts.join('')); }
    catch { return; }                                   // truncated or malformed; the row copy stands
    if (checkIncomingPackage(pkg).length) return;       // never trusted, always shape-checked
    applyOpponentPackage(pkg);
}

// Fills a side's pictures back in from a package that still has them. Both
// teams are now built from the battle row, which is artwork-stripped on purpose,
// so BOTH sides need this: the opponent's from the copy they send peer-to-peer,
// this player's own from the copy that never left the browser.
//
// Presentation only, by design. Nothing touched here is in the state hash or
// the setup digest, so it does not matter whether it lands, lands late, or
// never lands at all -- which is exactly why it is safe to feed it a local
// package that the opponent has no way to verify.
function paintSideArtwork(sideIndex, pkg) {
    const b = UI.battle;
    const side = b?.sides?.[sideIndex];
    if (!side) return;
    // Matched by source id, never by position. A package whose members are in a
    // different order than the row's would otherwise hang one Pokemon's picture
    // on another, and since the local package is allowed to be a different team
    // entirely, position means nothing here.
    const byId = new Map();
    for (const m of (pkg?.members || [])) {
        const key = String(m?.source_fakemon_id ?? m?.sourceFakemonId ?? '');
        if (key && !byId.has(key)) byId.set(key, m);
    }
    side.team.forEach(mon => {
        const sourceId = String(mon?.species?.sourceId || '');
        if (!sourceId) return;
        // The package first, then this browser's own collection. The second is
        // what covers this player's own side after a reload, or when the local
        // package slot has been overwritten by a later challenge: the pictures
        // live in the collection regardless of which team was staged last.
        const m = byId.get(sourceId);
        const own = (state.fakemonDB || []).find(f => String(f.id) === sourceId);
        const artwork = m?.artwork || own?.artwork || mon.species.artwork || '';
        const shiny = m?.shinyArtwork || own?.shinyArtwork || mon.species.shinyArtwork || '';
        const number = m?.number || own?.number || mon.species.number || '';
        if (artwork === mon.species.artwork && shiny === mon.species.shinyArtwork
            && number === mon.species.number) return;
        // A species record is frozen on purpose, so swap in a copy rather than
        // reach into it. Only the pictures and the dex number change.
        mon.species = Object.freeze({ ...mon.species, artwork, shinyArtwork: shiny, number });
    });
    UI.scene?.paint();
    paintControls();
}

function applyOpponentPackage(pkg) {
    if (!UI.battle || !UI.meta) return;
    UI.meta.oppPkg = pkg;
    paintSideArtwork(1 - UI.meta.mySide, pkg);
}

// A PvP battle plays no turn until two separate things are true: the two
// clients agreed on the rules, AND they have shown each other that they built
// the same battle out of them. The second used to be assumed. Nothing here is
// a long wait in practice -- both are settled within a round trip of the
// channel opening -- and an opponent too old to answer either one is already
// refused by the engine-version check in handshakeBlocker().
function readyToPlay() {
    if (!UI.meta || UI.meta.mode !== 'pvp') return true;
    return UI.meta.handshake?.ok === true && UI.meta.setupVerified === true;
}

function checkHash() {
    const b = UI.battle;
    const rh = UI.meta?.remoteHash;
    if (!b || !rh || rh.turn !== b.turn) return;
    // Held, not compared, until this side has finished its own handshake. The
    // opponent can settle theirs first and send the turn-0 hash while this
    // client still has their lead unseated and the caps unapplied, and
    // comparing then would report a desync that does not exist. applyHello()
    // calls back in once the picture is complete.
    if (!readyToPlay()) return;
    UI.meta.remoteHash = null;
    if (rh.hash !== b.stateHash()) endOnDesync();
}

// The two clients' pictures of the battle, compared before a turn is played.
// Runs whenever either half arrives, in whichever order they do.
function checkSetup() {
    if (!UI.meta || UI.meta.desynced) return;
    const { mySetup, theirSetup } = UI.meta;
    if (!mySetup || !theirSetup) return;
    const bad = setupMismatch(mySetup, theirSetup);
    if (!bad) {
        UI.meta.setupVerified = true;
        clearTimeout(UI.meta.handshakeTimer);
        UI.meta.handshakeTimer = null;
        // This is the last gate in readyToPlay(), so anything that was held
        // waiting on it has to be picked back up now: a turn-0 hash that
        // arrived early, a choice already made, and the controls that were
        // rendering as "not ready".
        checkHash();
        tryResolveTurn();
        paintControls();
        return;
    }
    log.warn?.('BATTLE', 'Setup mismatch before turn one', { part: bad.part, mine: mySetup, theirs: theirSetup });
    endOnDesync(bad.reason);
}

// `reason` is set when the mismatch was caught at setup, where we know exactly
// which part disagreed. A divergence found mid-battle by the per-turn hash has
// no such answer -- by then anything could have caused it -- so it stays on the
// generic wording.
function endOnDesync(reason = '') {
    const b = UI.battle;
    if (!b || b.ended || UI.meta.desynced) return;
    stopTimer();
    UI.meta.desyncReason = reason || '';
    UI.meta.desynced = true;
    UI.meta.rtc?.destroy();
    setStatus('');
    render();
    if (UI.meta.battleId) {
        // Recorded apart from a mid-battle desync. One is two simulations
        // drifting; the other is a battle that never legitimately started, and
        // reading them as the same thing later would hide how often each
        // actually happens.
        UI.lobby?.finish(UI.meta.battleId, null, reason ? 'setup-mismatch' : 'desync', UI.meta.actionLog)
            .catch(() => {});
    }
}

// Rebuilds a client's view of the battle after a reconnect by replaying
// whatever it missed from the opponent's action log. The engine is
// deterministic from the shared seed, so replaying the same actions in the
// same order reproduces the exact same state.
function applyResync(actions) {
    const b = UI.battle;
    if (!b || !Array.isArray(actions)) return;
    for (let i = UI.meta.actionLog.length; i < actions.length; i++) {
        const a = actions[i];
        if (a.kind === 'switch') {
            if (b.needsSwitch(a.side)) b.switchTo(a.side, a.index);
        } else if (a.kind === 'turn') {
            b.choose(0, a.choices[0]);
            b.choose(1, a.choices[1]);
            b.runTurn();
        }
        UI.meta.actionLog.push(a);
    }
    UI.pendingChoice = null;
    UI.meta.remoteChoice = null;
    UI.meta.resyncing = false;
    UI.scene?.snapToEngine();
    paintControls();
    if (!b.ended) resetTimer();
}

export function retryBattleConnection() { UI.meta?.rtc?.reconnect(); }

// ==================== battle pane ====================
// The page draws the rails, toolbar and controls from the data below. The
// scene host and the log belong to BattleScene: the page renders them empty
// and never touches their contents, so repainting mid-turn can never
// interrupt an animation that is still playing.

/**
 * One side's trainer card data: [{ name, artwork, fainted, active, revealed }].
 * Nothing about the opponent is shown that a real battle would not reveal:
 * before a Pokémon has been sent out it stays a silhouette.
 */
export function partyRails() {
    const pick = UI.leadPick;
    const you = state.user?.displayName || state.user?.username || 'You';
    if (pick) {
        const db = state.fakemonDB || [];
        return {
            left: { title: you, subtitle: 'Your team', slots: myLeadMembers(pick).map((m, i) => ({ ...memberFace(m, db), active: pick.lead === i, fainted: false, revealed: true })) },
            // revealed, because a team preview is the point of this screen
            right: { title: pick.kind === 'bot' ? 'Bot' : (UI.meta?.oppName || 'Opponent'), subtitle: 'Their team',
                slots: leadOpponentMembers(pick).map(m => ({ ...memberFace(m, db), active: false, fainted: false, revealed: true })) }
        };
    }
    const b = UI.battle;
    if (!b) return null;
    const mine = UI.meta.mySide;
    const rail = (sideIndex) => {
        const engineSide = b.sides[sideIndex];
        const isMine = sideIndex === mine;
        return {
            title: isMine ? you : (UI.meta.oppName || 'Opponent'),
            subtitle: isMine ? 'Your team' : 'Their team',
            slots: engineSide.team.map((mon, i) => ({
                name: mon.name,
                artwork: mon.species?.artwork || '',
                fainted: mon.fainted,
                active: i === engineSide.activeIndex,
                // you always see your own team; theirs is revealed as it is used
                revealed: isMine || mon.isActive || mon.fainted || mon.switchedInTurn > 0
            }))
        };
    };
    return { left: rail(mine), right: rail(1 - mine) };
}

/** Whether the connection banner above a PvP battle should show. */
export function battleNeedsBanner() {
    const b = UI.battle;
    return !!b && UI.meta?.mode === 'pvp' && !b.ended && !UI.meta.desynced && (UI.meta.connStatus !== 'connected' || !readyToPlay());
}

function paintControls() {
    notify();
}

export function setBattleSpeed(id) { UI.speed = id; UI.scene?.setSpeed(id); notify(); }
export function skipBattleAnimation() { UI.scene?.skip(); }

// Called by the scene as it starts and finishes draining its queue.
function onAnimPhase(busy) {
    UI.animating = busy;
    paintControls();
    if (busy) return;
    const b = UI.battle;
    if (!b) return;
    if (b.ended) { stopTimer(); onBattleEnded(); }
    else resetTimer();
}

// Before a battle exists there is no BattleScene to build, but the field can
// still be up: mount the 3D backdrop on its own and stand both teams on it, the
// way Showdown shows a team preview. Torn down the moment the real scene mounts.
async function attachPreviewScene() {
    const host = document.getElementById('battle-scene');
    if (!host || !UI.leadPick) return;
    if (UI.previewField && UI.previewHost === host) { paintPreview(); return; }
    UI.previewField?.destroy();
    UI.previewField = null;
    UI.previewHost = host;
    // The same backdrop markup BattleScene builds, so the preview looks like
    // the battle rather than an empty box if three.js is slow or absent.
    host.innerHTML = `
      <div class="ps-field">
        <div class="ps-sky"></div>
        <div class="ps-ground"></div>
        <div class="ps-weather" data-w=""></div>
        <div class="ps-platform ps-platform-far"></div>
        <div class="ps-platform ps-platform-near"></div>
      </div>`;
    const field = await mountField3D(host.querySelector('.ps-field'), UI.leadPick.field);
    // The screen may have moved on while three.js loaded.
    if (!field) return;
    if (!UI.leadPick || UI.previewHost !== host) { field.destroy(); return; }
    UI.previewField = field;
    paintPreview();
}

// Your six against theirs. Theirs are unknown until the battle starts, so they
// stand as silhouettes -- the same information a real team preview gives you.
function paintPreview() {
    const pick = UI.leadPick;
    const field = UI.previewField;
    if (!pick || !field) return;
    const db = state.fakemonDB || [];
    const mine = (pick.pkg?.members || []).map(m => memberFace(m, db).artwork);
    // Their real count, not a fixed six -- and their real artwork when we have
    // it. An empty string still draws a silhouette, so a PvP opponent shows as
    // the right number of shapes rather than as nothing.
    const oppMembers = leadOpponentMembers(pick);
    const theirs = oppMembers.length
        ? oppMembers.map(m => memberFace(m, db).artwork)
        : Array.from({ length: 6 }, () => '');
    field.showTeamPreview(mine, theirs);
}

function detachPreviewScene() {
    UI.previewField?.destroy();
    UI.previewField = null;
    UI.previewHost = null;
}

function attachScene(battle, mySide) {
    detachPreviewScene();
    UI.scene?.destroy();
    UI.scene = new BattleScene({
        battle, mySide, formatLine: formatLogLine, onPhaseChange: onAnimPhase
    });
    UI.scene.setSpeed(UI.speed);
}

// ==================== actions ====================
export function chooseBattleMove(index) { submitChoice({ type: 'move', index }); }
export function chooseBattleSwitch(index) { UI.switchPanelOpen = false; submitChoice({ type: 'switch', index }); }
// Only the control strip changes, so only the control strip is repainted.
// A full render() here tore down the 3D canvas and rebuilt it, which is what
// made the field flash every time the switch panel was opened.
export function toggleBattleSwitchPanel() { UI.switchPanelOpen = !UI.switchPanelOpen; paintControls(); }

export async function forfeitBattle() {
    const b = UI.battle;
    if (!b || b.ended) return;
    if (!await confirmDialog({ title: 'Forfeit this battle?', message: 'It counts as a loss.', confirmLabel: 'Forfeit' })) return;
    if (UI.meta.mode === 'pvp') {
        // Forfeit ends the match immediately rather than waiting on the
        // normal choice lockstep -- the opponent doesn't need to act.
        UI.meta.rtc?.send({ type: MSG.FORFEIT });
        b.forfeit(UI.meta.mySide);
        paintAll();
        stopTimer();
        onBattleEnded();
    } else {
        submitChoice({ type: 'forfeit' });
    }
}

function submitChoice(choice) {
    const b = UI.battle;
    if (!b || b.ended) return;
    if (!readyToPlay()) {
        api.showToast?.(UI.meta.handshake?.reason
            || (UI.meta.handshake?.ok
                ? 'Just checking your game and your opponent\'s match…'
                : 'Still agreeing on the rules with your opponent…'), 'warning');
        return;
    }

    // Replacing a fainted Pokémon happens outside the normal turn cycle.
    if (b.needsSwitch(UI.meta.mySide) && choice.type === 'switch') {
        b.switchTo(UI.meta.mySide, choice.index);
        if (UI.meta.mode === 'bot') {
            resolveBotReplacements(b);
        } else {
            UI.meta.actionLog.push({ kind: 'switch', turn: b.turn, side: UI.meta.mySide, index: choice.index });
            UI.meta.rtc?.send({ type: MSG.SWITCH, index: choice.index });
        }
        paintControls();
        UI.scene?.pump();
        return;
    }

    if (!b.choose(UI.meta.mySide, choice)) {
        api.showToast?.('That move is not available.', 'warning');
        return;
    }
    UI.pendingChoice = choice;

    if (UI.meta.mode === 'bot') {
        const botChoice = chooseBotAction(b, 1 - UI.meta.mySide);
        if (botChoice) b.choose(1 - UI.meta.mySide, botChoice);
        runTurnNow();
    } else {
        // PvP: send our choice and try to resolve immediately in case the
        // opponent's already arrived (see handleRtcMessage / tryResolveTurn).
        UI.meta.rtc?.send({ type: MSG.CHOICE, turn: b.turn + 1, choice });
        tryResolveTurn();
        paintControls();
    }
}

function runTurnNow() {
    const b = UI.battle;
    b.runTurn();
    UI.pendingChoice = null;
    UI.switchPanelOpen = false;
    if (UI.meta.mode === 'bot') resolveBotReplacements(b);
    // The engine is already done; the scene now replays what just happened.
    // onAnimPhase re-enables the controls and settles the timer once it lands.
    paintControls();
    UI.scene?.pump();
}

// The bot never needs a human prompt for a forced replacement.
function resolveBotReplacements(b) {
    const botSide = 1 - UI.meta.mySide;
    let guard = 0;
    while (!b.ended && b.needsSwitch(botSide) && guard++ < 6) {
        const c = chooseBotAction(b, botSide);
        if (!c || c.type !== 'switch') break;
        b.switchTo(botSide, c.index);
    }
}

async function onBattleEnded() {
    const b = UI.battle;
    if (!b || UI.meta.endHandled) return;
    UI.meta.endHandled = true;
    UI.lobby?.setStatus('open');
    if (UI.meta.mode === 'pvp' && UI.meta.battleId) {
        UI.meta.rtc?.destroy();
        const row = UI.meta.row;
        const winnerId = b.winner === 0 ? row.p1_id : row.p2_id;
        try { await UI.lobby.finish(UI.meta.battleId, winnerId, b.endReason, UI.meta.actionLog); }
        catch (e: any) { setStatus(e.message || String(e)); }
    }
}

// ==================== painting ====================
// The scene owns the field and the log; the pane only repaints its controls.
function paintAll() { paintControls(); UI.scene?.pump(); }

// Turns the structured protocol into readable lines. `nameFor` resolves a
// ==================== timer ====================
function startTimer() { UI.timeLeft = TURN_SECONDS; stopTimer(); UI.timer = setInterval(tickTimer, 1000); }
function resetTimer() { UI.timeLeft = TURN_SECONDS; }
function stopTimer() { if (UI.timer) { clearInterval(UI.timer); UI.timer = null; } }
function tickTimer() {
    if (!UI.battle || UI.battle.ended) { stopTimer(); return; }
    UI.timeLeft--;
    notify();
    if (UI.timeLeft <= 0) {
        // Running out of time forfeits, matching how a timer works in a real
        // ladder game rather than silently stalling the battle.
        stopTimer();
        if (UI.meta.mode === 'pvp') UI.meta.rtc?.send({ type: MSG.FORFEIT });
        UI.battle.forfeit(UI.meta.mySide);
        paintAll();
        onBattleEnded();
    }
}
export function formatTime(s) {
    const m = Math.max(0, Math.floor(s / 60));
    return `${m}:${String(Math.max(0, s % 60)).padStart(2, '0')}`;
}

// ==================== replay ====================
export function downloadBattleReplay() {
    const b = UI.battle;
    if (!b) return;
    const replay = {
        version: 1, engineVersion: b.engineVersion, seed: b.seed,
        format: b.format, savedAt: new Date().toISOString(),
        players: b.sides.map(s => s.name),
        log: b.log, winner: b.winner, endReason: b.endReason
    };
    const blob = new Blob([JSON.stringify(replay, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `woogidex-battle-${b.seed.slice(0, 8)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Leaving the tab should not leave a stale "online" row behind.
export function onBattleViewLeave() {
    stopTimer();
    if (UI.lobby?.joined) UI.lobby.leave();
    clearTimeout(UI.meta?.handshakeTimer);
    UI.meta?.rtc?.destroy();
    UI.scene?.destroy();
    UI.scene = null;
}

