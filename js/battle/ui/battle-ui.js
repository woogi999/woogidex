// ==================== battle tab UI ====================
// Three panes: Teams (build), Lobby (find/challenge), Battle (play).
// No mock mode -- bot and player battles run the same Battle instance.

import { state, api } from '../../core/app.js';
import { log } from '../../core/log.js';
import { NATURE_DATA } from '../../core/data.js';
import { Battle, canSelectMove, ENGINE_VERSION, STRUGGLE, STRUGGLE_INDEX } from '../engine/battle.js';
import { mountIsland } from '../../react/island.jsx';
import { BattleControls } from '../../react/BattleControls.jsx';
import { connectionBanner } from './controls-model.js';
import { loadShowdownAbilities, abilitiesFingerprint } from '../engine/sd-abilities.js';
import { loadShowdownMoves, movesFingerprint } from '../engine/sd-moves.js';
import { loadShowdownItems, itemsFingerprint } from '../engine/sd-items.js';
import { loadBattleText } from './battle-text.js';
import { formatLogLine } from './battle-log.js';
import { BattleDex, toId } from '../engine/dex.js';
import {
    makeTeam, makeMember, checkTeamReady, toPeerPackage, toServerSnapshot,
    checkIncomingPackage, packageToSide, mergeDexPayload, monForMember, TEAM_FORMAT_RULES
} from '../teams.js';
import { chooseBotAction } from '../bot.js';
import { BattleLobby } from '../net/lobby.js';
import { BattleRTC } from '../net/rtc.js';
import { MSG, negotiateCaps, handshakeBlocker, reducedCaps, setupMismatch, TEAM_CHUNK_CHARS } from '../net/protocol.js';
import { BattleScene, SCENE_SPEEDS } from './scene.js';
import { mountField3D, fieldForSeed } from './field3d.js';

import { esc, publicName } from '../../core/html.js';

const UI = {
    pane: 'teams',
    scene: null,
    speed: 'normal',
    animating: false,
    editingTeamId: null,
    lobby: null,
    players: [],
    challenges: [],
    battle: null,
    meta: null,          // { mode, mySide, battleId, oppName }
    searching: false,    // announces "Find Match" presence
    previewField: null,  // 3D field during lead selection
    previewHost: null,
    logCursor: 0,
    pendingChoice: null,
    switchPanelOpen: false,
    timer: null,
    timeLeft: 0
};

const TURN_SECONDS = 90;

// Skeleton shown at boot before Showdown data loads; render() replaces it.
export function renderBattleSkeleton() {
    const root = document.getElementById('battle-body');
    if (!root) return;
    const card = () => `<div class="battle-team-card skel-card">
        <div class="battle-team-card-head">
          <span class="skel skel-text" style="width:90px;"></span>
          <span class="skel skel-text" style="width:32px;"></span>
        </div>
        <div class="battle-team-mons">${Array.from({ length: 4 }, () => '<span class="battle-team-chip skel"></span>').join('')}</div>
      </div>`;
    root.innerHTML = `
      <div class="battle-tabs">
        <button class="battle-tab is-active" type="button" disabled><i data-lucide="users"></i> Teams</button>
        <button class="battle-tab" type="button" disabled><i data-lucide="swords"></i> Find a Battle</button>
        <button class="battle-tab" type="button" disabled><i data-lucide="gamepad-2"></i> Battle</button>
      </div>
      <div class="battle-team-grid">${Array.from({ length: 3 }, card).join('')}</div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
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
    if (!UI.battle) UI.pane = UI.pane === 'battle' ? 'teams' : UI.pane;
    render();
    if (UI.pane === 'lobby') await ensureLobby();
}

function setStatus(msg) {
    const el = document.getElementById('battle-status');
    if (el) el.textContent = msg || '';
}

export function setBattlePane(pane) {
    UI.pane = pane;
    render();
    if (pane === 'lobby') ensureLobby();
    else if (UI.lobby?.joined && pane !== 'battle') UI.lobby.setStatus('away');
}

// ==================== render root ====================
function render() {
    const root = document.getElementById('battle-body');
    if (!root) return;
    healVanillaMembers();
    const tabs = `
      <div class="battle-tabs">
        ${['teams', 'lobby', 'battle'].map(p => `
          <button class="battle-tab ${UI.pane === p ? 'is-active' : ''}" type="button"
                  onclick="setBattlePane('${p}')" ${p === 'battle' && !UI.battle && !UI.leadPick ? 'disabled' : ''}>
            <i data-lucide="${p === 'teams' ? 'users' : p === 'lobby' ? 'swords' : 'gamepad-2'}"></i>
            ${p === 'teams' ? 'Teams' : p === 'lobby' ? 'Find a Battle' : 'Battle'}
          </button>`).join('')}
      </div>`;
    root.innerHTML = tabs + (
        UI.pane === 'teams' ? renderTeamsPane()
            : UI.pane === 'lobby' ? renderLobbyPane()
                : renderBattlePane()
    );
    if (typeof lucide !== 'undefined') lucide.createIcons();
    // React root needs #battle-controls in the DOM first.
    paintControls();
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
function teams() { return state.battleTeams || (state.battleTeams = []); }
function findTeam(id) { return teams().find(t => t.id === id) || null; }

// ---- resolving a team slot to the Pokemon it stands for ----
// Collection Fakemon resolve by id; a vanilla Pokemon carries its own
// Fakemon-shaped snapshot on the member (see teams.js monForMember). Teams
// built before that snapshot existed only kept an `sd_<dexid>` reference, so
// they are rebuilt from the Showdown dex the first time they are read --
// otherwise every vanilla slot reads as a deleted Fakemon.
function monFor(m) {
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
function vanillaFakemonRecord(p, learnsetNames = null) {
    const names = learnsetNames
        || Object.keys(state.sdLearnsets?.[p.id] || {}).map(k => state.sdMoves?.[k]?.name).filter(Boolean);
    return {
        id: `sd_${p.id}`,
        name: p.name,
        stats: { ...p.stats },
        type1: p.types?.[0] || 'Normal',
        type2: p.types?.[1] || '',
        abilities: Object.values(p.abilities || {}).map(name => ({ name, source: 'sd' })),
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

function renderTeamsPane() {
    const editing = UI.editingTeamId ? findTeam(UI.editingTeamId) : null;
    if (editing) return renderTeamEditor(editing);

    if (!teams().length) {
        return `<div class="battle-empty">
            <i data-lucide="users"></i>
            <h3>No teams yet</h3>
            <p>Build a team from your own Fakémon to start battling.</p>
            <button class="btn btn-primary" type="button" onclick="createBattleTeam()"><i data-lucide="plus"></i> New Team</button>
          </div>`;
    }

    return `
      <div class="battle-section-head">
        <h3>Your Teams</h3>
        <button class="btn btn-primary btn-sm" type="button" onclick="createBattleTeam()"><i data-lucide="plus"></i> New Team</button>
      </div>
      <div class="battle-team-grid">
        ${teams().map(t => {
            const problems = checkTeamReady(t, state.fakemonDB);
            return `<div class="battle-team-card">
              <div class="battle-team-card-head">
                <strong>${esc(t.name)}</strong>
                <span class="battle-team-count">${t.members.length}/${TEAM_FORMAT_RULES.maxMembers}</span>
              </div>
              <div class="battle-team-mons">
                ${t.members.length ? t.members.map(m => {
                    const f = monFor(m);
                    return `<span class="battle-team-chip" title="${esc(f?.name || 'Missing')}">
                        ${f?.artwork ? `<img src="${esc(f.artwork)}" alt="">` : '<i data-lucide="help-circle"></i>'}
                      </span>`;
                }).join('') : '<span class="battle-team-empty">Empty</span>'}
              </div>
              ${problems.length ? `<div class="battle-team-warn"><i data-lucide="alert-triangle"></i> ${esc(problems[0])}</div>` : ''}
              <div class="battle-team-actions">
                <button class="btn btn-secondary btn-sm" type="button" onclick="editBattleTeam('${t.id}')"><i data-lucide="pencil"></i> Edit</button>
                <button class="btn btn-secondary btn-sm" type="button" onclick="duplicateBattleTeam('${t.id}')"><i data-lucide="copy"></i></button>
                <button class="btn btn-danger btn-sm" type="button" onclick="deleteBattleTeam('${t.id}')"><i data-lucide="trash-2"></i></button>
              </div>
            </div>`;
        }).join('')}
      </div>`;
}

// Showdown's teambuilder layout: a narrow sidebar of team slots on the left
// (click to select, drag-free reordering via arrows) and the selected mon's
// full detail sheet on the right.
function renderTeamEditor(team) {
    const db = state.fakemonDB || [];
    const problems = checkTeamReady(team, db);
    if (UI.editingSlotIndex === undefined || UI.editingSlotIndex >= Math.max(team.members.length, 1)) {
        UI.editingSlotIndex = 0;
    }
    const sel = UI.editingSlotIndex;
    const hasSel = team.members.length > 0;
    return `
      <div class="battle-section-head">
        <button class="btn btn-secondary btn-sm" type="button" onclick="closeBattleTeamEditor()"><i data-lucide="arrow-left"></i> Back</button>
        <input class="battle-team-name" value="${esc(team.name)}" oninput="renameBattleTeam('${team.id}', this.value)" aria-label="Team name">
      </div>
      ${problems.length ? `<div class="battle-team-warn block"><i data-lucide="alert-triangle"></i><div>${problems.map(esc).join('<br>')}</div></div>` : ''}
      <div class="ps-teambuilder">
        <aside class="ps-tb-sidebar">
          ${team.members.map((m, i) => {
            const f = monFor(m);
            return `<button class="ps-tb-slot ${i === sel ? 'is-selected' : ''}" type="button"
                        onclick="selectBattleSlot(${i})">
                <span class="ps-tb-slot-num">${i + 1}</span>
                ${f?.artwork ? `<img src="${esc(f.artwork)}" alt="">` : '<span class="ps-tb-noart"><i data-lucide="image"></i></span>'}
                <span class="ps-tb-slot-name">${esc(f?.name || 'Missing')}</span>
              </button>`;
          }).join('')}
          ${team.members.length < TEAM_FORMAT_RULES.maxMembers ? `
            <button class="ps-tb-addslot" type="button" onclick="openBattleMonPicker('${team.id}')">
              <i data-lucide="plus"></i><span>Add</span>
            </button>` : ''}
          <div class="ps-tb-sidebar-tools">
            <button class="btn btn-secondary btn-sm" type="button" onclick="moveBattleMember('${team.id}',${sel},-1)" ${sel === 0 ? 'disabled' : ''}><i data-lucide="chevron-up"></i></button>
            <button class="btn btn-secondary btn-sm" type="button" onclick="moveBattleMember('${team.id}',${sel},1)" ${sel >= team.members.length - 1 ? 'disabled' : ''}><i data-lucide="chevron-down"></i></button>
            <button class="btn btn-danger btn-sm" type="button" onclick="removeBattleMemberAt('${team.id}',${sel})" ${hasSel ? '' : 'disabled'}><i data-lucide="trash-2"></i></button>
          </div>
        </aside>
        <section class="ps-tb-detail">
          ${hasSel ? renderMemberEditor(team, team.members[sel], sel, db)
                   : '<div class="community-empty">Add a Fakémon to begin.</div>'}
        </section>
      </div>
      ${renderTeamImportExport(team)}`;
}

// ---- whole-team import / export, the way Showdown's teambuilder does it ----
// The per-member panel below only ever moved one set; a team is what people
// actually trade, so the same Smogon text format is offered for all six at
// once (sets separated by a blank line).
function renderTeamImportExport(team) {
    return `
      <details class="ps-tb-io ps-tb-team-io">
        <summary><i data-lucide="clipboard-list"></i> Import / Export team</summary>
        <p class="battle-slot-note">Showdown format - one set per block, separated by a blank line. Importing replaces every slot on this team.</p>
        <textarea id="battle-team-text-${team.id}" rows="16" spellcheck="false"
                  placeholder="Paste a whole Showdown team here…">${esc(teamToSmogonText(team))}</textarea>
        <div class="ps-tb-io-actions">
          <button class="btn btn-secondary btn-sm" type="button" onclick="copyBattleTeam('${team.id}')"><i data-lucide="copy"></i> Copy team</button>
          <button class="btn btn-secondary btn-sm" type="button" onclick="downloadBattleTeam('${team.id}')"><i data-lucide="download"></i> Download .txt</button>
          <button class="btn btn-primary btn-sm" type="button" onclick="importBattleTeam('${team.id}')"><i data-lucide="upload"></i> Import team</button>
        </div>
      </details>`;
}

function teamToSmogonText(team) {
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
        || Object.values(state.sdPokedex || {}).find(x => toId(x.name) === key);
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

export async function importBattleTeam(teamId) {
    const t = findTeam(teamId); if (!t) return;
    const ta = document.getElementById(`battle-team-text-${teamId}`);
    if (!ta) return;
    const blocks = String(ta.value || '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
    if (!blocks.length) { api.showToast?.('Nothing to import.', 'error'); return; }
    // A vanilla species is only usable once its learnset is in, so wait for it
    // rather than importing slots with an empty move pool.
    await api.ensureLearnsets?.();

    const members = [];
    const unknown = [];
    for (const block of blocks.slice(0, TEAM_FORMAT_RULES.maxMembers)) {
        const header = parseSetHeader(block.split('\n')[0]);
        const f = findSpeciesRecord(header.species);
        if (!f) { unknown.push(header.species || '(unnamed)'); continue; }
        const m = makeMember(f);
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

function renderMemberEditor(team, m, index, db) {
    const f = monFor(m);
    if (!f) {
        return `<div class="battle-slot is-missing">
            <div class="battle-slot-head"><strong>Missing Fakémon</strong>
              <button class="btn btn-danger btn-sm" type="button" onclick="removeBattleMember('${team.id}',${index})"><i data-lucide="trash-2"></i></button>
            </div>
            <p class="battle-slot-note">This Fakémon was deleted from your collection.</p>
          </div>`;
    }
    const learn = (f.learnset || []).map(x => x?.name).filter(Boolean);
    // The learnset is offered first because it's the natural pick-list, but a
    // free-text box is always available: these are your creations, so the
    // builder never blocks a move you want on them.
    const abilities = (f.abilities || []).map(a => a.name).filter(Boolean);
    return `
      <div class="battle-slot">
        <div class="battle-slot-head">
          <div class="battle-slot-mon">
            ${f.artwork ? `<img src="${esc(f.artwork)}" alt="">` : '<div class="battle-slot-noart"><i data-lucide="image"></i></div>'}
            <div>
              <strong>${esc(f.name)}</strong>
              <span class="battle-slot-types">${[f.type1, f.type2].filter(Boolean).map(t => `<span class="type-badge type-${t.toLowerCase()}">${t}</span>`).join('')}</span>
            </div>
          </div>
          <div class="battle-slot-tools">
            <button class="btn btn-secondary btn-sm" type="button" onclick="moveBattleMember('${team.id}',${index},-1)" ${index === 0 ? 'disabled' : ''}><i data-lucide="chevron-up"></i></button>
            <button class="btn btn-secondary btn-sm" type="button" onclick="moveBattleMember('${team.id}',${index},1)" ${index === team.members.length - 1 ? 'disabled' : ''}><i data-lucide="chevron-down"></i></button>
            <button class="btn btn-danger btn-sm" type="button" onclick="removeBattleMember('${team.id}',${index})"><i data-lucide="trash-2"></i></button>
          </div>
        </div>

        <div class="battle-slot-grid">
          <label>Level<input type="number" min="1" max="100" value="${Number(m.level) || 100}" onchange="setBattleMember('${team.id}',${index},'level',this.value)"></label>
          <label>Nature
            <select onchange="setBattleMember('${team.id}',${index},'nature',this.value)">
              ${['Serious','Adamant','Modest','Jolly','Timid','Bold','Calm','Careful','Impish','Relaxed','Brave','Quiet'].map(nt =>
                `<option value="${nt}" ${m.nature === nt ? 'selected' : ''}>${nt}</option>`).join('')}
            </select>
          </label>
          <label>Ability
            <select onchange="setBattleMember('${team.id}',${index},'ability',this.value)">
              ${abilities.map(a => `<option value="${esc(a)}" ${toId(m.ability) === toId(a) ? 'selected' : ''}>${esc(a)}</option>`).join('') || '<option value="">(none)</option>'}
            </select>
          </label>
          <label>Item<input type="text" list="battle-items-${team.id}-${index}" value="${esc(m.item || '')}"
                            placeholder="e.g. Leftovers" onchange="setBattleMember('${team.id}',${index},'item',this.value)">
            <datalist id="battle-items-${team.id}-${index}">
              ${itemOptionsHTML()}
            </datalist>
          </label>
        </div>

        <div class="battle-slot-moves">
          <div class="battle-slot-label">Moves <span>${(m.moves || []).filter(Boolean).length}/4</span></div>
          ${[0, 1, 2, 3].map(i => `
            <div class="battle-move-row">
              <input class="battle-move-input" list="battle-learnset-${team.id}-${index}" placeholder="Move ${i + 1}"
                     value="${esc(m.moves?.[i] || '')}" onchange="setBattleMove('${team.id}',${index},${i},this.value)">
              <button class="btn btn-secondary btn-sm" type="button" title="Browse this learnset"
                      onclick="openBattleMoveBrowser('${team.id}',${index},${i})"><i data-lucide="search"></i></button>
            </div>
          `).join('')}
          <datalist id="battle-learnset-${team.id}-${index}">
            ${learn.map(n => `<option value="${esc(n)}"></option>`).join('')}
            ${(state.customMoves || []).map(cm => `<option value="${esc(cm.name)}"></option>`).join('')}
          </datalist>
        </div>

        ${renderBattleStatEditor(team, m, index, f)}
        ${renderBattleImportExport(team, m, index, f)}
      </div>`;
}

// ---- Smogon plain-text import/export ----
// Same format as Showdown's import/export: "Name @ Item / Ability: X / EVs: …
// / Nature / IVs: … / - Move" lines. Export writes it; import parses it back
// into this member, accepting anything the format allows.
function renderBattleImportExport(team, m, index, f) {
    const text = memberToSmogonText(m, f);
    return `
      <details class="ps-tb-io">
        <summary><i data-lucide="clipboard-type"></i> Import / Export set</summary>
        <textarea id="battle-set-text-${team.id}-${index}" rows="9" spellcheck="false"
                  placeholder="Paste a Showdown/Smogon set here…">${esc(text)}</textarea>
        <div class="ps-tb-io-actions">
          <button class="btn btn-secondary btn-sm" type="button" onclick="copyBattleSet('${team.id}',${index})"><i data-lucide="copy"></i> Copy</button>
          <button class="btn btn-primary btn-sm" type="button" onclick="importBattleSet('${team.id}',${index})"><i data-lucide="download"></i> Import from text</button>
        </div>
      </details>`;
}

function memberToSmogonText(m, f) {
    const lines = [];
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

export function importBattleSet(teamId, index) {
    const t = findTeam(teamId); const m = t?.members[index]; if (!m) return;
    const ta = document.getElementById(`battle-set-text-${teamId}-${index}`);
    if (!ta) return;
    try {
        parseSmogonSetInto(m, ta.value);
        t.updatedAt = Date.now();
        api.saveToStorage?.();
        render();
        api.showToast?.('Set imported.', 'success');
    } catch (e) {
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
const BATTLE_STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const BATTLE_STAT_LABELS = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

function battleCalcStat(base, ev, iv, nature, statKey, level) {
    const data = NATURE_DATA[nature];
    let mult = 1;
    if (data && data.up !== data.down) {
        if (data.up === statKey) mult = 1.1;
        if (data.down === statKey) mult = 0.9;
    }
    if (statKey === 'hp') return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + level + 10;
    return Math.floor((Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5) * mult);
}

function renderBattleStatEditor(team, m, index, f) {
    const teamId = team.id;
    const nature = m.nature || 'Serious';
    const nd = NATURE_DATA[nature];
    const totalEVs = BATTLE_STAT_KEYS.reduce((s, k) => s + (m.evs?.[k] || 0), 0);
    const rows = BATTLE_STAT_KEYS.map(key => {
        const base = Number(f.stats?.[key]) || 60;
        const ev = m.evs?.[key] || 0;
        const iv = m.ivs?.[key] === undefined ? 31 : Number(m.ivs[key]);
        const calc = battleCalcStat(base, ev, iv, nature, key, Number(m.level) || 100);
        const boosted = nd && nd.up === key && nd.up !== nd.down;
        const reduced = nd && nd.down === key && nd.up !== nd.down;
        return `
          <div class="ps-tb-stat-row ${boosted ? 'stat-boosted' : reduced ? 'stat-reduced' : ''}">
            <div class="ps-tb-stat-name">
              <span>${BATTLE_STAT_LABELS[key]}</span>
              <span class="ps-tb-nature-btns">
                <button class="nature-btn nature-plus ${boosted ? 'active' : ''}" type="button"
                        onclick="setBattleNatureBoost('${teamId}',${index},'${key}','up')" title="Boost ${BATTLE_STAT_LABELS[key]}">+</button>
                <button class="nature-btn nature-minus ${reduced ? 'active' : ''}" type="button"
                        onclick="setBattleNatureBoost('${teamId}',${index},'${key}','down')" title="Reduce ${BATTLE_STAT_LABELS[key]}">−</button>
              </span>
            </div>
            <div class="ps-tb-stat-base">${base}</div>
            <input type="number" class="ps-tb-ev-input" min="0" max="252" step="4" value="${ev}"
                   onchange="setBattleStat('${teamId}',${index},'evs','${key}',this.value)">
            <div class="ps-tb-ev-track">
              <div class="ps-tb-ev-fill" style="width:${(ev / 252) * 100}%"></div>
              <input type="range" min="0" max="252" step="4" value="${ev}"
                     oninput="setBattleStat('${teamId}',${index},'evs','${key}',this.value)">
            </div>
            <input type="number" class="ps-tb-iv-input" min="0" max="31" value="${iv}"
                   onchange="setBattleStat('${teamId}',${index},'ivs','${key}',this.value)">
            <div class="ps-tb-stat-calc">${calc}</div>
          </div>`;
    }).join('');
    return `
      <div class="ps-tb-stats">
        <div class="ps-tb-stats-header">
          <span>Stat</span><span>Base</span><span>EVs</span><span></span><span>IVs</span><span>Calc</span>
        </div>
        ${rows}
        <div class="ps-tb-ev-total ${totalEVs > 508 ? 'is-over' : ''}">${totalEVs} / 508 EVs${totalEVs > 508 ? ' - over the limit!' : ` (${508 - totalEVs} remaining)`}</div>
      </div>`;
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

    let next = null;
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

// ---- Browse Moves (reuses the editor's move-browser modal, but scoped to
// THIS member's learnset and writing into a specific move slot).
let battleMoveBrowserTarget = null;   // { teamId, index, slot }

export function openBattleMoveBrowser(teamId, index, slot) {
    battleMoveBrowserTarget = { teamId, index, slot };
    for (const id of ['mb-filter-name', 'mb-filter-type', 'mb-filter-category', 'mb-filter-bp-min']) {
        const el = document.getElementById(id);
        if (el) el.value = '';
    }
    renderBattleMoveBrowserResults();
    document.getElementById('move-browser-modal')?.classList.add('active');
    setTimeout(() => document.getElementById('mb-filter-name')?.focus(), 0);
}

// The Browse Moves modal is shared with the editor, and its filter inputs call
// the editor's filterMoveBrowser() by name. While the teambuilder owns the
// modal that call has to come back here instead: the editor's renderer lists
// every move in the game and its cards write into the editor's learnset, so
// typing a search used to swap this list for that one -- which is why a
// searched move could not be added until the modal was closed and reopened.
export function battleMoveBrowserOwnsModal() { return !!battleMoveBrowserTarget; }

export function closeBattleMoveBrowser() { battleMoveBrowserTarget = null; }

// The moves this member may actually learn: its species learnset plus any
// custom moves it already references. Not the whole game's move list.
function memberLearnsetMoves(m) {
    const f = monFor(m);
    const names = new Set((f?.learnset || []).map(x => x?.name).filter(Boolean));
    for (const mv of m.moves || []) if (mv) names.add(mv);
    const out = [];
    const seen = new Set();
    for (const name of names) {
        const custom = (state.customMoves || []).find(cm => cm.name === name);
        const sdEntry = Object.entries(state.sdMoves).find(([, v]) => v.name === name)?.[1];
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
    const out = [];
    const seen = new Set();
    for (const cm of state.customMoves || []) {
        if (!cm?.name || seen.has(cm.name.toLowerCase())) continue;
        seen.add(cm.name.toLowerCase());
        out.push({ key: 'custom:' + cm.name, ...cm, name: cm.name, custom: true });
    }
    for (const sd of Object.values(state.sdMoves || {})) {
        if (!sd?.name || seen.has(sd.name.toLowerCase())) continue;
        seen.add(sd.name.toLowerCase());
        out.push({ key: sd.name, ...sd, custom: false });
    }
    return out;
}

function battleMoveFiltersActive() {
    return !!(document.getElementById('mb-filter-name')?.value.trim()
        || document.getElementById('mb-filter-type')?.value
        || document.getElementById('mb-filter-category')?.value
        || document.getElementById('mb-filter-bp-min')?.value);
}

function battleMoveMatchesFilters(move) {
    const name = document.getElementById('mb-filter-name')?.value.trim().toLowerCase() || '';
    const type = document.getElementById('mb-filter-type')?.value || '';
    const category = document.getElementById('mb-filter-category')?.value || '';
    const bpMin = parseInt(document.getElementById('mb-filter-bp-min')?.value, 10);
    if (name && !(move.name || '').toLowerCase().includes(name)) return false;
    if (type && move.type !== type) return false;
    if (category && move.category !== category) return false;
    if (Number.isFinite(bpMin) && (Number(move.basePower) || 0) < bpMin) return false;
    return true;
}

export function filterBattleMoveBrowser() {
    renderBattleMoveBrowserResults();
}

function renderBattleMoveBrowserResults() {
    const list = document.getElementById('move-browser-results');
    const countEl = document.getElementById('move-browser-count');
    if (!list || !battleMoveBrowserTarget) return;
    const t = findTeam(battleMoveBrowserTarget.teamId);
    const member = t?.members[battleMoveBrowserTarget.index];
    if (!member) return;
    const already = new Set((member.moves || []).filter(Boolean).map(x => x.toLowerCase()));
    const learnable = memberLearnsetMoves(member);
    const learnableNames = new Set(learnable.map(m => m.name.toLowerCase()));

    const matches = learnable.filter(battleMoveMatchesFilters);
    // A search reaches past the learnset so it can say "this move exists, but
    // not for this Pokemon". Without a search there is nothing to reach for.
    const locked = battleMoveFiltersActive()
        ? allBrowsableMoves()
            .filter(m => !learnableNames.has(m.name.toLowerCase()))
            .filter(battleMoveMatchesFilters)
            .sort((a, b) => a.name.localeCompare(b.name))
        : [];

    if (countEl) {
        countEl.textContent = `${matches.length} move${matches.length === 1 ? '' : 's'} in learnset`
            + (locked.length ? ` · ${locked.length} not learnable` : '');
    }

    const card = (m, isLocked) => {
        const typeClass = `type-${(m.type || 'normal').toLowerCase()}`;
        const acc = (m.accuracy === true || m.accuracy === undefined) ? '-' : `${m.accuracy}%`;
        const added = !isLocked && already.has(m.name.toLowerCase());
        const click = isLocked ? '' : ` onclick="pickBattleMove('${esc(m.key).replace(/'/g, "\\'")}')"`;
        const title = isLocked ? `${m.name} is not in this Pokémon's learnset`
            : (added ? 'Already chosen' : 'Click to choose');
        return `<div class="move-browser-card${added ? ' added' : ''}${isLocked ? ' is-locked' : ''}"${click} title="${esc(title)}">
            <div class="move-browser-card-top">
              <span class="type-pill ${typeClass}">${m.type || '?'}</span>
              <span class="cat-pill">${m.category || 'Status'}</span>
              ${added ? '<span class="move-browser-added-badge">Chosen</span>' : ''}
              ${isLocked ? '<span class="move-browser-locked-badge">Not learnable</span>' : ''}
            </div>
            <div class="move-browser-card-name">${esc(m.name)}</div>
            <div class="move-browser-card-stats">BP ${m.basePower || '-'} · Acc ${acc} · PP ${m.pp || '-'}</div>
          </div>`;
    };

    const html = matches.map(m => card(m, false)).join('') + locked.map(m => card(m, true)).join('');
    list.innerHTML = html || '<div class="move-browser-empty">No moves match those filters.</div>';
}

export function pickBattleMove(key) {
    if (!battleMoveBrowserTarget) return;
    const { teamId, index, slot } = battleMoveBrowserTarget;
    const t = findTeam(teamId); const m = t?.members[index];
    if (!m) return;
    // Checked here as well as in the markup: the list is only the door, and a
    // move this Pokemon cannot learn must not get in through it.
    const move = memberLearnsetMoves(m).find(x => x.key === key);
    if (!move) {
        api.showToast?.('That Pokémon cannot learn that move.', 'warning');
        return;
    }
    // Write into the exact slot that opened the browser.
    m.moves = m.moves || [];
    m.moves[slot] = move.name;
    t.updatedAt = Date.now();
    api.saveToStorage?.();
    document.getElementById('move-browser-modal')?.classList.remove('active');
    battleMoveBrowserTarget = null;
    render();
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
export function deleteBattleTeam(id) {
    const t = findTeam(id); if (!t) return;
    if (!confirm(`Delete team “${t.name}”?`)) return;
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
function allItemNames() {
    const names = Object.values(state.sdItems || {}).map(i => i?.name).filter(Boolean);
    for (const ci of state.customItems || []) if (ci?.name) names.push(ci.name);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function itemOptionsHTML() {
    return allItemNames().map(n => `<option value="${esc(n)}"></option>`).join('');
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
    UI.pickerTab = 'custom';
    renderMonPickerGrid();
    const modal = document.getElementById('battle-mon-picker-modal');
    if (modal) modal.classList.add('active');
}
export function setBattlePickerTab(tab) {
    UI.pickerTab = tab;
    renderMonPickerGrid();
    // The hub feed is shared with the Community tab and cached there, so this
    // is usually a no-op; it only actually fetches if the user came straight
    // to the teambuilder without opening the hub this session.
    if (tab === 'community') {
        Promise.resolve(api.fetchCommunityFeed?.())
            .then(() => { if (UI.pickerTab === 'community') renderMonPickerGrid(); })
            .catch(e => log.warn('BATTLE', 'Community picker feed failed', e));
    }
}
function renderMonPickerGrid() {
    const grid = document.getElementById('battle-mon-picker-grid');
    const tabs = document.getElementById('battle-mon-picker-tabs');
    if (!grid || !tabs) return;
    tabs.innerHTML = `
      <button class="battle-picker-tab ${UI.pickerTab === 'custom' ? 'is-active' : ''}" type="button" onclick="setBattlePickerTab('custom')">My Fakémon</button>
      <button class="battle-picker-tab ${UI.pickerTab === 'vanilla' ? 'is-active' : ''}" type="button" onclick="setBattlePickerTab('vanilla')">Vanilla Pokémon</button>
      <button class="battle-picker-tab ${UI.pickerTab === 'community' ? 'is-active' : ''}" type="button" onclick="setBattlePickerTab('community')">Community</button>`;
    if (UI.pickerTab === 'community') {
        const cs = state.community || {};
        if (cs.loading && !(cs.mons || []).length) {
            grid.innerHTML = '<div class="community-empty">Loading the Community Hub…</div>';
        } else {
            grid.innerHTML = (cs.mons || []).map(row => {
                const d = row.fakemon_data || {};
                const art = d.thumbnail || d.artwork || '';
                return `
            <div class="collection-card" onclick="pickCommunityMon('${esc(String(row.id))}')">
              <div class="card-art">${art ? `<img src="${esc(art)}" alt="" draggable="false">` : '<img class="no-art-placeholder" src="assets/no_art_placeholder.png" alt="" draggable="false">'}</div>
              <div class="card-name">${esc(d.name || 'Unnamed')}</div>
              <div class="card-types">${[d.type1, d.type2].filter(Boolean).map(t => `<span class="type-badge type-${String(t).toLowerCase()}">${t}</span>`).join('')}</div>
            </div>`;
            }).join('') || '<div class="community-empty">Nothing has been published to the Community Hub yet.</div>';
        }
    } else if (UI.pickerTab === 'vanilla') {
        const dex = Object.values(state.sdPokedex || {});
        grid.innerHTML = dex.map(p => `
            <div class="collection-card" onclick="pickVanillaMon('${esc(p.id)}')">
              <div class="card-art"><img src="https://img.pokemondb.net/artwork/large/${vanillaArtSlug(p)}.jpg" alt="" draggable="false"
                   onerror="this.src='assets/no_art_placeholder.png'"></div>
              <div class="card-name">${esc(p.name)}</div>
              <div class="card-types">${(p.types || []).map(t => `<span class="type-badge type-${String(t).toLowerCase()}">${t}</span>`).join('')}</div>
            </div>`).join('') || '<div class="community-empty">Showdown data is still loading…</div>';
    } else {
        grid.innerHTML = (state.fakemonDB || []).map(f => `
            <div class="collection-card" onclick="pickBattleMon('${esc(f.id)}')">
              <div class="card-art">${f.artwork ? `<img src="${esc(f.artwork)}" alt="" draggable="false">` : '<img class="no-art-placeholder" src="assets/no_art_placeholder.png" alt="" draggable="false">'}</div>
              <div class="card-name">${esc(f.name || 'Unnamed')}</div>
              <div class="card-types">${[f.type1, f.type2].filter(Boolean).map(t => `<span class="type-badge type-${t.toLowerCase()}">${t}</span>`).join('')}</div>
            </div>`).join('') || '<div class="community-empty">No Fakémon in your collection yet.</div>';
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function vanillaArtSlug(p) {
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
    const member = makeMember(f);
    // The snapshot rides on the member: a vanilla Pokemon has no collection
    // record for `sourceFakemonId` to resolve against.
    member.vanilla = f;
    // Pre-fill four moves from the learnset so a new slot is immediately usable.
    member.moves = learnset.slice(0, 4);
    t.members.push(member);
    t.updatedAt = Date.now();
    document.getElementById('battle-mon-picker-modal')?.classList.remove('active');
    api.saveToStorage?.(); render();
}
// A Fakémon someone else published. The hub feed row is deliberately slim
// (no artwork, no learnset), so the full record is fetched on pick and then
// frozen onto the member exactly like a vanilla pick -- it is a snapshot, not
// a link, so the team keeps working if the author later edits or unpublishes.
export async function pickCommunityMon(publishedId) {
    const t = findTeam(UI.pickerTeamId);
    if (!t) return;
    let row = null;
    try {
        const client = await api.getClient();
        const { data, error } = await client
            .from('published_mons')
            .select('id, fakemon_data, author_name')
            .eq('id', publishedId)
            .maybeSingle();
        if (error) throw error;
        row = data;
    } catch (e) {
        log.error('BATTLE', 'Could not load community Fakémon', e);
    }
    const f = communityFakemonRecord(row);
    if (!f) { api.showToast?.('Could not load that Fakémon.', 'error'); return; }
    const member = makeMember(f);
    member.vanilla = f;
    member.moves = (f.learnset || []).slice(0, 4).map(x => x?.name).filter(Boolean);
    t.members.push(member);
    t.updatedAt = Date.now();
    document.getElementById('battle-mon-picker-modal')?.classList.remove('active');
    api.saveToStorage?.(); render();
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
    document.getElementById('battle-mon-picker-modal')?.classList.remove('active');
    api.saveToStorage?.(); render();
}

// ==================== lobby pane ====================
async function ensureLobby() {
    if (!state.user) { render(); return; }
    if (!UI.lobby) {
        UI.lobby = new BattleLobby({
            onLobby: list => { UI.players = list; if (UI.pane === 'lobby') paintLobby(); },
            onChallenges: list => { UI.challenges = list; if (UI.pane === 'lobby') paintLobby(); },
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

function renderLobbyPane() {
    if (!state.user) {
        return `<div class="battle-empty">
            <i data-lucide="log-in"></i><h3>Sign in to battle</h3>
            <p>You need an account to find opponents. You can still practise against a bot.</p>
            <button class="btn btn-primary" type="button" onclick="openAuthModal('signin')">Sign In</button>
            ${renderBotBox()}
          </div>`;
    }
    return `<div class="battle-lobby">
        <div class="battle-lobby-main">
          <div class="battle-findmatch ${UI.searching ? 'is-searching' : ''}">
            <div class="battle-findmatch-copy">
              <h3>${UI.searching ? 'Looking for a match…' : 'Find a match'}</h3>
              <p>${UI.searching
                    ? 'Other trainers can see you and challenge you. Pick anyone below to challenge them first.'
                    : 'Announce that you want to play. Everyone else searching shows up here.'}</p>
            </div>
            <label class="battle-findmatch-team">Team
              <select id="battle-find-team">${teamOptions()}</select>
            </label>
            <button class="btn ${UI.searching ? 'btn-danger' : 'btn-primary'}" type="button" onclick="toggleFindMatch()">
              <i data-lucide="${UI.searching ? 'x' : 'search'}"></i> ${UI.searching ? 'Stop searching' : 'Find Match'}
            </button>
          </div>

          <div class="battle-section-head">
            <h3>Looking for a match</h3>
            <button class="btn btn-secondary btn-sm" type="button" onclick="refreshBattleLobby()"><i data-lucide="refresh-cw"></i> Refresh</button>
          </div>
          <div id="battle-search-list"></div>

          <div class="battle-section-head">
            <h3>Also online</h3>
          </div>
          <div id="battle-lobby-list"></div>
        </div>
        <aside class="battle-lobby-side">
          <div id="battle-challenge-list"></div>
          ${renderBotBox()}
        </aside>
      </div>`;
}

function renderBotBox() {
    return `<div class="battle-bot-box">
        <h4><i data-lucide="bot"></i> Practice vs Bot</h4>
        <label>Team
          <select id="battle-bot-team">${teamOptions()}</select>
        </label>
        <button class="btn btn-primary" type="button" onclick="startBotBattle()"><i data-lucide="play"></i> Start Practice Battle</button>
      </div>`;
}

function teamOptions() {
    const ready = teams().filter(t => !checkTeamReady(t, state.fakemonDB).length);
    if (!ready.length) return '<option value="">(no battle-ready team)</option>';
    return ready.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
}

function playerRow(p) {
    const name = p.display_name || p.username || 'Trainer';
    const sent = UI.challenges.find(c => c.to_id === p.user_id && c.status === 'pending' && c.from_id === state.user?.id);
    return `<div class="battle-player-row">
        <span class="battle-player-avatar">${p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="">` : esc(name.charAt(0).toUpperCase())}</span>
        <span class="battle-player-name"><strong>${esc(name)}</strong><small>@${esc(p.username || 'unknown')}</small></span>
        <span class="battle-player-status battle-status-${esc(p.status)}">${esc(p.status === 'searching' ? 'searching' : p.status)}</span>
        ${sent
            ? `<button class="btn btn-secondary btn-sm" type="button" onclick="cancelBattleChallenge('${sent.id}')">Cancel</button>`
            : `<button class="btn btn-primary btn-sm" type="button" onclick="challengePlayer('${p.user_id}','${esc(name)}')"><i data-lucide="swords"></i> Challenge</button>`}
      </div>`;
}

function paintLobby() {
    // Anyone who pressed Find Match is surfaced separately -- that is the list
    // you actually want to pick an opponent from.
    const searching = UI.players.filter(p => p.status === 'searching');
    const others = UI.players.filter(p => p.status !== 'searching');

    const queue = document.getElementById('battle-search-list');
    if (queue) {
        queue.innerHTML = searching.length
            ? searching.map(playerRow).join('')
            : `<div class="community-empty">${UI.searching
                ? 'Nobody else is searching yet. You will show up for them as soon as they look.'
                : 'Nobody is searching right now. Press Find Match so others can see you.'}</div>`;
    }

    const list = document.getElementById('battle-lobby-list');
    if (list) {
        list.innerHTML = others.length
            ? others.map(playerRow).join('')
            : '<div class="community-empty">Nobody else is in the Battle tab right now.</div>';
    }
    const ch = document.getElementById('battle-challenge-list');
    if (ch) {
        const incoming = UI.challenges.filter(c => c.status === 'pending' && c.to_id === state.user?.id);
        ch.innerHTML = incoming.length ? `<div class="battle-challenge-box">
            <h4><i data-lucide="bell"></i> Challenges</h4>
            ${incoming.map(c => `<div class="battle-challenge-row">
                <span><strong>${esc(c.from_name || 'A trainer')}</strong><small>wants to battle</small></span>
                <div>
                  <button class="btn btn-primary btn-sm" type="button" onclick="acceptChallenge('${c.id}')">Accept</button>
                  <button class="btn btn-secondary btn-sm" type="button" onclick="declineChallenge('${c.id}')">Decline</button>
                </div>
              </div>`).join('')}
          </div>` : '';
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

export async function refreshBattleLobby() { await UI.lobby?.refresh(); paintLobby(); }

// Find Match is just a presence status: it says "I want a game" so other
// trainers can see you rather than everyone having to sit on this screen at the
// same moment hoping to catch each other.
export async function toggleFindMatch() {
    if (!state.user) { api.showToast?.('Sign in to find a match.', 'warning'); return; }
    if (!UI.searching) {
        // Refuse to advertise without a legal team, so nobody challenges into
        // an error.
        if (!selectedTeamPackage('battle-find-team')) return;
    }
    UI.searching = !UI.searching;
    await ensureLobby();
    await UI.lobby?.setStatus(UI.searching ? 'searching' : 'open');
    await refreshBattleLobby();
    render();
}

function selectedTeamPackage(selectId = 'battle-bot-team') {
    const id = document.getElementById(selectId)?.value || teams()[0]?.id;
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
    const pkg = selectedTeamPackage('battle-find-team') || selectedTeamPackage('battle-bot-team');
    if (!pkg) return;
    try {
        await UI.lobby.challenge(userId, toServerSnapshot(pkg), publicName(state.user));
        UI.myPendingPackage = pkg;   // kept locally so artwork survives the round trip
        api.showToast?.(`Challenge sent to ${name}.`, 'success');
        await refreshBattleLobby();
    } catch (e) { api.showToast?.(e.message || String(e), 'error'); }
}

export async function cancelBattleChallenge(id) {
    try { await UI.lobby.cancelChallenge(id); await refreshBattleLobby(); }
    catch (e) { api.showToast?.(e.message || String(e), 'error'); }
}
export async function declineChallenge(id) {
    try { await UI.lobby.decline(id); await refreshBattleLobby(); }
    catch (e) { api.showToast?.(e.message || String(e), 'error'); }
}
export async function acceptChallenge(id) {
    const pkg = selectedTeamPackage('battle-bot-team');
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
    } catch (e) { api.showToast?.(e.message || String(e), 'error'); }
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
function myLeadMembers(pick) {
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
function leadOpponentMembers(pick) {
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

function memberFace(m, db) {
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
    // Repaint the picker and the party rail in place. A full render() would
    // rebuild the scene host underneath the 3D preview and flash the field.
    paintControls();
    const rail = document.querySelector('.battle-party-left');
    if (rail) {
        rail.outerHTML = leadRails(UI.leadPick).left;
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
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
function buildDex(pkgA, pkgB, { includeLocal = true } = {}) {
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
    const others = teams().filter(t => t.id !== (document.getElementById('battle-bot-team')?.value));
    const botTeam = others.find(t => !checkTeamReady(t, state.fakemonDB).length);
    return botTeam
        ? toPeerPackage(botTeam, state.fakemonDB, {
            customMoves: state.customMoves, customAbilities: state.customAbilities, customItems: state.customItems
        })
        : JSON.parse(JSON.stringify(pkg));
}

export function startBotBattle() {
    const pkg = selectedTeamPackage('battle-bot-team');
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
            // own browser. A PvP battle never sets this: see sd-hooks.js.
            trustLocalCode: true,
            sides: [packageToSide(pkg, 'p1', 'You', leadIndex), packageToSide(botPkg, 'p2', 'Bot')]
        });
    } catch (e) {
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
    } catch (e) {
        api.showToast?.(`Could not start: ${e.message}`, 'error');
        UI.pane = 'lobby'; render(); return;
    }
    UI.battle = battle;
    UI.meta = {
        mode: 'pvp', mySide, battleId: battleRow.id, row: battleRow, oppName: 'Opponent',
        rtc: null, actionLog: [], remoteChoice: null, remoteHash: null,
        connStatus: 'connecting', timerStarted: false, desynced: false,
        // Filled in by the peer-to-peer team exchange below: the opponent's
        // package in full (artwork included), and the chunk buffer building it.
        oppPkg: null, oppTeamChunks: null,
        // Whoever this player put in front. The sides above were built with the
        // opponent's lead defaulted to slot 0 because there is no way to know
        // it yet; theirs arrives with their hello and is seated before turn 1.
        myLead,
        // Set once both clients have said what rules they are running. No turn
        // may be played before then -- see readyToPlay().
        myHello: null, handshake: null, handshakeTimer: null,
        // Each side's digest of the battle it actually built, compared before
        // turn one so a mismatch is caught while it can still be explained.
        mySetup: null, theirSetup: null, setupVerified: false, desyncReason: ''
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
// Supabase only ever carries the WebRTC handshake (see net/rtc.js). Every
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
export function sendBattleChat(ev) {
    ev.preventDefault();
    const input = document.getElementById('battle-chat-input');
    const text = (input?.value || '').trim();
    if (!text || UI.meta?.mode !== 'pvp') return;
    UI.meta.rtc?.send({ type: MSG.CHAT, text });
    appendChatLine('me', text);
    if (input) input.value = '';
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
// The scene lives in a container that BattleScene builds once and render()
// otherwise leaves alone, so repainting the controls mid-turn can never
// interrupt an animation that is still playing.
// One side's trainer card: their name and their six Pokémon. Yours sits on the
// left, theirs on the right, so the screen reads the way the field does.
//
// `slots` is [{ name, artwork, fainted, active, revealed }]. Nothing about the
// opponent is shown that a real battle would not reveal: before a Pokémon has
// been sent out it stays a silhouette.
function renderPartyRail({ title, subtitle, slots, side }) {
    return `
      <aside class="battle-party battle-party-${side}">
        <div class="battle-party-head">
          <strong>${esc(title)}</strong>
          ${subtitle ? `<small>${esc(subtitle)}</small>` : ''}
        </div>
        <div class="battle-party-slots">
          ${slots.map(slot => `
            <div class="battle-party-slot${slot.active ? ' is-active' : ''}${slot.fainted ? ' is-fainted' : ''}${slot.revealed ? '' : ' is-hidden'}"
                 title="${esc(slot.revealed ? (slot.name || '') : 'Not yet revealed')}">
              ${slot.revealed && slot.artwork
                    ? `<img src="${esc(slot.artwork)}" alt="${esc(slot.name || '')}">`
                    : slot.revealed && slot.name
                        ? `<span class="battle-party-monogram">${esc(slot.name.slice(0, 2))}</span>`
                        : '<span class="battle-party-unknown"><i data-lucide="help-circle"></i></span>'}
            </div>`).join('')}
          ${Array.from({ length: Math.max(0, 6 - slots.length) }, () =>
                '<div class="battle-party-slot is-empty"></div>').join('')}
        </div>
      </aside>`;
}

// Rails for a live battle, straight off the engine's own teams.
function battleRails(b) {
    const mine = UI.meta.mySide;
    const rail = (sideIndex, side) => {
        const engineSide = b.sides[sideIndex];
        const isMine = sideIndex === mine;
        return renderPartyRail({
            side,
            title: isMine ? (state.user?.displayName || state.user?.username || 'You') : (UI.meta.oppName || 'Opponent'),
            subtitle: isMine ? 'Your team' : 'Their team',
            slots: engineSide.team.map((mon, i) => ({
                name: mon.name,
                artwork: mon.species?.artwork || '',
                fainted: mon.fainted,
                active: i === engineSide.activeIndex,
                // You always see your own team; theirs is revealed as it is used.
                revealed: isMine || mon.isActive || mon.fainted || mon.switchedInTurn > 0
            }))
        });
    };
    return {
        left: rail(mine, 'left'),
        right: rail(1 - mine, 'right')
    };
}

// Rails while choosing a lead: your team is known, the opponent's is not.
function leadRails(pick) {
    const db = state.fakemonDB || [];
    const members = myLeadMembers(pick);
    return {
        left: renderPartyRail({
            side: 'left',
            title: state.user?.displayName || state.user?.username || 'You',
            subtitle: 'Your team',
            slots: members.map((m, i) => {
                const face = memberFace(m, db);
                return {
                    name: face.name,
                    artwork: face.artwork,
                    active: pick.lead === i,
                    fainted: false,
                    revealed: true
                };
            })
        }),
        right: renderPartyRail({
            side: 'right',
            title: pick.kind === 'bot' ? 'Bot' : (UI.meta?.oppName || 'Opponent'),
            subtitle: 'Their team',
            // Revealed, because a team preview is exactly the point of this
            // screen. Six blank silhouettes told you nothing at all.
            slots: leadOpponentMembers(pick).map(m => {
                const face = memberFace(m, db);
                return { name: face.name, artwork: face.artwork, revealed: true, fainted: false };
            })
        })
    };
}

function renderBattlePane() {
    const b = UI.battle;
    // Choosing a lead happens ON the battle screen, with both trainers' rails
    // already in place, rather than on a separate screen beforehand.
    if (UI.leadPick) {
        const rails = leadRails(UI.leadPick);
        // The field is already up, with both teams lined up on it, and the lead
        // picker sits exactly where the move buttons will be a moment later.
        // The SAME four-column grid the battle uses, log column included. The
        // lead screen used to drop that column, which widened the middle one
        // and made the field a different size here than a moment later.
        return `<div class="ps-wrap">
            ${rails.left}
            <div class="ps-main">
              <div class="ps-scene" id="battle-scene"></div>
              <div class="battle-controls" id="battle-controls"></div>
            </div>
            ${rails.right}
            <aside class="ps-logwrap">
              <div class="ps-log ps-log-empty">The battle log will appear here.</div>
            </aside>
          </div>`;
    }
    if (!b) {
        return `<div class="battle-empty"><i data-lucide="gamepad-2"></i><h3>No battle in progress</h3>
            <p>Find an opponent in the lobby, or start a practice battle.</p>
            <button class="btn btn-primary" type="button" onclick="setBattlePane('lobby')">Find a Battle</button></div>`;
    }
    const rails = battleRails(b);
    return `
      ${UI.meta.mode === 'pvp' && !b.ended && !UI.meta.desynced && (UI.meta.connStatus !== 'connected' || !readyToPlay()) ? renderConnBanner() : ''}
      <div class="ps-wrap">
        ${rails.left}
        <div class="ps-main">
          <div class="ps-scene" id="battle-scene"></div>
          <div class="ps-toolbar">
            <label class="ps-speed">
              <span>Speed</span>
              <select onchange="setBattleSpeed(this.value)">
                ${SCENE_SPEEDS.map(s => `<option value="${s.id}" ${UI.speed === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}
              </select>
            </label>
            <div class="ps-toolbar-right">
              <button class="btn btn-secondary btn-sm ps-skip" type="button" onclick="skipBattleAnimation()" ${UI.animating ? '' : 'disabled'}>
                <i data-lucide="fast-forward"></i> Skip
              </button>
              ${!b.ended ? `<span class="battle-timer ${UI.timeLeft <= 15 ? 'is-urgent' : ''}" id="battle-timer">${formatTime(UI.timeLeft)}</span>` : ''}
            </div>
          </div>
          <div class="battle-controls" id="battle-controls"></div>
        </div>
        ${rails.right}
        <aside class="ps-logwrap">
          <div class="ps-log" id="battle-log"></div>
          ${UI.meta.mode === 'pvp' ? `
          <form class="ps-chatbar" onsubmit="sendBattleChat(event)">
            <input id="battle-chat-input" type="text" placeholder="Chat…" maxlength="300" autocomplete="off"
                   onkeydown="event.stopPropagation()">
            <button class="btn btn-primary btn-sm" type="submit"><i data-lucide="send"></i></button>
          </form>` : ''}
        </aside>
      </div>`;
}

// Everything under the scene. Repainted freely; never touches the field.
// The control strip is a React island (js/react/BattleControls.jsx). Which pane
// it shows is decided by controlsView() in ./controls-model.js, where the
// ordering rules that make a battle work can be read and tested on their own.
//
// This repaint stays deliberately narrow. #battle-controls is the only thing it
// touches; the 3D scene host sits outside it and belongs entirely to the scene.
// A full render() here tore down the canvas and rebuilt it, which is what made
// the field flash every time the switch panel opened.
function paintControls() {
    const el = document.getElementById('battle-controls');
    if (!el) return;

    const pick = UI.leadPick;
    const db = state.fakemonDB || [];

    mountIsland(el, BattleControls, {
        ui: UI,
        lead: pick
            ? {
                myMembers: myLeadMembers(pick),
                oppMembers: leadOpponentMembers(pick),
                oppName: UI.meta?.oppName,
                faceOf: m => memberFace(m, db)
            }
            : {},
        canSelect: canSelectMove,
        struggle: STRUGGLE,
        struggleIndex: STRUGGLE_INDEX
    });

    const skip = document.querySelector('.ps-skip');
    if (skip) skip.disabled = !UI.animating;
}

export function setBattleSpeed(id) { UI.speed = id; UI.scene?.setSpeed(id); }
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

// Sits above the battle rather than inside the control strip, so it stays a
// string in the pane markup. What it should say is connectionBanner() in
// ./controls-model.js -- one place, whether it is read from here or from React.
function renderConnBanner() {
    const banner = connectionBanner(UI.meta);
    if (!banner) return '';
    const note = banner.note ? `<small>${esc(banner.note)}</small>` : '';
    return `<div class="battle-conn-banner ${banner.tone === 'bad' ? 'is-bad' : ''}">
        <i data-lucide="${banner.icon}"></i> <span>${esc(banner.label)}${note}</span>
        ${banner.canRetry ? '<button class="btn btn-secondary btn-sm" type="button" onclick="retryBattleConnection()">Try Again</button>' : ''}
      </div>`;
}

// ==================== actions ====================
export function chooseBattleMove(index) { submitChoice({ type: 'move', index }); }
export function chooseBattleSwitch(index) { UI.switchPanelOpen = false; submitChoice({ type: 'switch', index }); }
// Only the control strip changes, so only the control strip is repainted.
// A full render() here tore down the 3D canvas and rebuilt it, which is what
// made the field flash every time the switch panel was opened.
export function toggleBattleSwitchPanel() { UI.switchPanelOpen = !UI.switchPanelOpen; paintControls(); }

export function forfeitBattle() {
    const b = UI.battle;
    if (!b || b.ended) return;
    if (!confirm('Forfeit this battle?')) return;
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
        catch (e) { setStatus(e.message || String(e)); }
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
    const el = document.getElementById('battle-timer');
    if (el) { el.textContent = formatTime(UI.timeLeft); el.classList.toggle('is-urgent', UI.timeLeft <= 15); }
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
function formatTime(s) {
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

// ==================== exports ====================
Object.assign(window, {
    openBattle, setBattlePane, createBattleTeam, editBattleTeam, closeBattleTeamEditor,
    renameBattleTeam, duplicateBattleTeam, deleteBattleTeam, removeBattleMember, moveBattleMember,
    setBattleMember, setBattleMove, setBattleStat, openBattleMonPicker, pickBattleMon,
    refreshBattleLobby, toggleFindMatch, challengePlayer, cancelBattleChallenge, declineChallenge, acceptChallenge,
    startBotBattle, chooseBattleMove, chooseBattleSwitch, toggleBattleSwitchPanel, forfeitBattle,
    downloadBattleReplay, retryBattleConnection, setBattleSpeed, skipBattleAnimation,
    sendBattleChat, setBattleLead, confirmLeadAndStart, cancelLeadPick,
    selectBattleSlot, removeBattleMemberAt, setBattlePickerTab, pickVanillaMon,
    importBattleSet, setBattleNatureBoost, copyBattleTeam, downloadBattleTeam, importBattleTeam,
    openBattleMoveBrowser, pickBattleMove, filterBattleMoveBrowser,
    battleMoveBrowserOwnsModal, closeBattleMoveBrowser, copyBattleSet
});
