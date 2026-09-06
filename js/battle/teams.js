// Battle teams. Teams are LOCAL (IndexedDB), storing *references* to Fakemon
// by id plus the competitive set -- never a copy, so editing a Fakemon updates
// every team using it. The only thing sent off-device is a "battle package": a
// frozen, self-contained snapshot (species data, custom moves/abilities) of the
// six Pokemon entering one battle, since the opponent can't simulate your side
// otherwise. Two flavours: toPeerPackage() (full, with artwork, over WebRTC)
// and toServerSnapshot() (artwork stripped, stored server-side for replay).
// Pure module (no DOM) so it's unit-testable in Node.

import { toId } from './engine/dex.js';

// structural limits only, not a legality ruleset -- these exist because the
// engine needs them (no moves = can't take a turn), not to judge team design
export const TEAM_FORMAT_RULES = {
    maxMembers: 6,
    minMembers: 1,
    maxMoves: 4,
    minMoves: 1,
    maxLevel: 100
};

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

export function makeTeam(name = 'New Team') {
    return {
        id: 'tm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name,
        format: 'singles',
        members: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
}

// ------------------------------------------------------------ mon lookup
// a vanilla Pokemon (no collection record) stores a frozen snapshot under
// `vanilla` instead; resolving through here avoids false "no longer in your collection" errors
export function monForMember(member, fakemonDB = []) {
    if (!member) return null;
    const found = (fakemonDB || []).find(f => String(f.id) === String(member.sourceFakemonId));
    return found || member.vanilla || null;
}

export function makeMember(fakemon) {
    const firstAbility = fakemon?.abilities?.[0]?.name || '';
    return {
        sourceFakemonId: String(fakemon?.id ?? ''),
        nickname: '',
        level: 100,
        nature: 'Serious',
        ability: firstAbility,
        item: '',
        moves: [],
        evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }
    };
}

// ---------------------------------------------------------------- readiness
// [] when the team can enter a battle, else human-readable problems. Checks
// only what the engine requires -- not learnset/ability-slot/EV legality,
// since these are custom creations and there's nothing objective to police.
export function checkTeamReady(team, fakemonDB = []) {
    const errors = [];
    const members = team?.members || [];

    if (members.length < TEAM_FORMAT_RULES.minMembers) errors.push('Add at least one Pokémon to this team.');
    if (members.length > TEAM_FORMAT_RULES.maxMembers) errors.push(`Teams may hold at most ${TEAM_FORMAT_RULES.maxMembers} Pokémon.`);

    members.forEach((m, i) => {
        const f = monForMember(m, fakemonDB);
        const label = m.nickname || f?.name || `Slot ${i + 1}`;
        // the one hard check: a deleted Fakemon leaves a slot the engine can't build
        if (!f) {
            errors.push(`${label}: this Fakémon is no longer in your collection.`);
            return;
        }
        const moves = (m.moves || []).filter(Boolean);
        if (moves.length < TEAM_FORMAT_RULES.minMoves) errors.push(`${label}: needs at least one move.`);
        if (moves.length > TEAM_FORMAT_RULES.maxMoves) errors.push(`${label}: has more than ${TEAM_FORMAT_RULES.maxMoves} moves.`);
        if (new Set(moves.map(toId)).size !== moves.length) errors.push(`${label}: has the same move twice.`);

        const level = Number(m.level) || 100;
        if (level < 1 || level > TEAM_FORMAT_RULES.maxLevel) errors.push(`${label}: level must be 1-${TEAM_FORMAT_RULES.maxLevel}.`);
    });

    return errors;
}

export const validateTeam = checkTeamReady;

// ---------------------------------------------------------------- packaging
// only the custom content this team actually references gets bundled --
// sending the whole library would leak unrelated designs to the opponent
export function toPeerPackage(team, fakemonDB = [], libs = {}) {
    const customMoves = new Map();
    const customAbilities = new Map();
    const customItems = new Map();

    const members = (team.members || []).map(m => {
        const f = monForMember(m, fakemonDB);
        if (!f) return null;

        // own library first, then the Fakemon's own learnset (a Fakemon from
        // elsewhere has no library entry -- its custom moves live inline on the learnset)
        for (const name of m.moves || []) {
            const cm = (libs.customMoves || []).find(x => toId(x.name) === toId(name))
                || (f.learnset || []).find(x => x && (x.source === 'custom' || x.custom === true) && toId(x.name) === toId(name));
            if (cm) customMoves.set(cm.id || cm.customId || toId(cm.name), cm);
        }
        const abilityRef = (f.abilities || []).find(a => toId(a?.name) === toId(m.ability)) || f.abilities?.[0];
        if (abilityRef) {
            // own library first, then embedded on the Fakemon; matched by id where
            // possible, else by name (so pre-id-era abilities still resolve)
            const ca = (abilityRef.customId && (libs.customAbilities || []).find(x => String(x.id) === String(abilityRef.customId)))
                || (abilityRef.customId && (f.customAbilities || []).find(x => String(x.id) === String(abilityRef.customId)))
                || (f.customAbilities || []).find(x => toId(x?.name) === toId(abilityRef.name));
            if (ca) customAbilities.set(ca.id || toId(ca.name), ca);
        }
        if (m.item) {
            const ci = (libs.customItems || []).find(x => toId(x.name) === toId(m.item));
            if (ci) customItems.set(ci.id || toId(ci.name), ci);
        }

        return {
            source_fakemon_id: String(f.id),
            name: f.name || 'Unnamed',
            nickname: m.nickname || '',
            level: Number(m.level) || 100,
            nature: m.nature || 'Serious',
            ability: m.ability || abilityRef?.name || '',
            item: m.item || '',
            moves: (m.moves || []).filter(Boolean).slice(0, 4),
            evs: { ...{ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, ...(m.evs || {}) },
            ivs: { ...{ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, ...(m.ivs || {}) },
            // species data the opponent needs to simulate this Pokémon
            stats: { ...f.stats },
            type1: f.type1 || 'Normal',
            type2: f.type2 || '',
            number: f.number || '',
            abilities: (f.abilities || []).map(a => ({ name: a.name, source: a.source, customId: a.customId || null })),
            learnset: (f.learnset || []).map(x => x?.name).filter(Boolean),
            artwork: f.artwork || '',
            shinyArtwork: f.shinyArtwork || ''
        };
    }).filter(Boolean);

    return {
        version: 1,
        format: team.format || 'singles',
        members,
        customMoves: [...customMoves.values()],
        customAbilities: [...customAbilities.values()],
        customItems: [...customItems.values()]
    };
}

// separate rather than mutating in place, so the peer package is never accidentally changed
export function toServerSnapshot(pkg) {
    return {
        ...pkg,
        members: (pkg.members || []).map(({ artwork, shinyArtwork, ...rest }) => rest)
    };
}

// ------------------------------------------------------ incoming package
// run by the receiving client; a PARSE check only (structurally sound enough
// to build a battle), not a legality check on the opponent's stats/moves/ability
export function checkIncomingPackage(pkg) {
    const errors = [];
    if (!pkg || typeof pkg !== 'object') return ['Opponent sent no team.'];
    if (!Array.isArray(pkg.members) || !pkg.members.length) return ['Opponent sent an empty team.'];
    if (pkg.members.length > TEAM_FORMAT_RULES.maxMembers) {
        errors.push(`Opponent's team has ${pkg.members.length} Pokémon (max ${TEAM_FORMAT_RULES.maxMembers}).`);
    }
    pkg.members.forEach((m, i) => {
        const label = m?.name || `Slot ${i + 1}`;
        if (!m || typeof m !== 'object') { errors.push(`${label}: unreadable.`); return; }
        const moves = (m.moves || []).filter(Boolean);
        if (!moves.length) errors.push(`${label}: has no moves.`);
        if (moves.length > TEAM_FORMAT_RULES.maxMoves) errors.push(`${label}: has more than ${TEAM_FORMAT_RULES.maxMoves} moves.`);
        for (const s of STATS) {
            if (!Number.isFinite(Number(m.stats?.[s]))) errors.push(`${label}: missing ${s.toUpperCase()} stat.`);
        }
    });
    return errors;
}

export const validatePeerPackage = checkIncomingPackage;

// ------------------------------------------------------- engine conversion
// turns a package into what the Battle constructor wants; works for own or
// opponent's team, so both clients run the identical simulation
export function packageToSide(pkg, id, name, lead = 0) {
    return {
        id, name,
        lead: Number(lead) || 0,
        team: (pkg.members || []).map(m => ({
            fakemon: {
                id: m.source_fakemon_id,
                name: m.nickname || m.name,
                stats: m.stats,
                type1: m.type1,
                type2: m.type2,
                abilities: m.abilities || [],
                learnset: (m.learnset || []).map(n => ({ name: n })),
                artwork: m.artwork || '',
                shinyArtwork: m.shinyArtwork || '',
                number: m.number || ''
            },
            set: {
                level: m.level, nature: m.nature, ability: m.ability,
                item: m.item, moves: m.moves, evs: m.evs, ivs: m.ivs
            }
        }))
    };
}

// merges both players' bundled custom content so each client resolves the other's identically
export function mergeDexPayload(pkgA, pkgB, local = {}) {
    const dedupe = (...lists) => {
        const out = new Map();
        for (const list of lists) for (const item of list || []) {
            if (item) out.set(String(item.id ?? item.name), item);
        }
        return [...out.values()];
    };
    return {
        customMoves: dedupe(local.customMoves, pkgA?.customMoves, pkgB?.customMoves),
        customAbilities: dedupe(local.customAbilities, pkgA?.customAbilities, pkgB?.customAbilities),
        customItems: dedupe(local.customItems, pkgA?.customItems, pkgB?.customItems)
    };
}
