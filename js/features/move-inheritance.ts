// ==================== inherited moves ====================
// An option on each Fakemon (the Moves tab's "Inherit moves from prevolutions"
// switch): when it's on, the Fakemon also knows every move its prevolutions
// know, all the way down the line, the way an evolved Pokemon keeps what it
// learned before. A Mega or forme change counts its base form as the
// prevolution.
//
// How it's stored: the Fakemon's own moves stay in `learnset` as always, and
// the inherited ones are appended after them marked `inherited: true` (with
// `inheritedFrom`, the prevolution's name). Keeping a real copy means every
// reader of `learnset` -- exports, the battle sim, analysis, publishing --
// gets the full list without knowing this feature exists. The copies are
// rebuilt on every save (refreshInheritedMoves, called from saveToStorage),
// so editing a prevolution's moves flows down to its evolutions.
//
// The editor never holds the copies: loading a Fakemon strips them, the
// Moves tab shows them in their own read-only list (inheritedMovesForEditor),
// and the save writes only the Fakemon's own moves before they're re-added.

import { state, api } from '../core/app.ts';
import { log } from '../core/log.ts';
import { notify } from '../app/store.ts';

const nameKey = (m: any) => String(m?.name || '').trim().toLowerCase();

/** A Fakemon's own moves, without any inherited copies. */
export function ownMoves(learnset: any[]): any[] {
    return (learnset || []).filter(m => m && !m.inherited);
}

/**
 * Every move a Fakemon's prevolutions know, nearest prevolution first, each
 * tagged with where it came from. Moves the Fakemon already has itself are
 * skipped, and so is a second copy of the same move further down the line.
 *
 * @param refId the Fakemon's id
 * @param graph its evolution graph (the editor passes its live one)
 * @param own the Fakemon's own moves
 */
export function inheritedMoves(refId: string, graph: any, own: any[], db: any[] = state.fakemonDB || []): any[] {
    if (!refId || !graph) return [];
    const byId = new Map<string, any>(db.map(f => [String(f.id), f]));
    const have = new Set(ownMoves(own).map(nameKey));
    const out: any[] = [];
    const visited = new Set<string>([String(refId)]);
    let frontier = api.prevolutionRefIds?.(graph, refId) || [];
    // breadth-first so the nearest prevolution's version of a move wins
    while (frontier.length) {
        const next: string[] = [];
        for (const id of frontier) {
            if (visited.has(id)) continue;
            visited.add(id);
            const prevo = byId.get(id);
            if (!prevo) continue;
            for (const m of ownMoves(prevo.learnset)) {
                const key = nameKey(m);
                if (!key || have.has(key)) continue;
                have.add(key);
                const { inherited, inheritedFrom, ...move } = m;
                out.push({ ...move, inherited: true, inheritedFrom: prevo.name || 'its prevolution' });
            }
            // each Fakemon in a line carries the same graph, but read the
            // prevolution's own in case they've drifted apart
            next.push(...(api.prevolutionRefIds?.(prevo.evolutionGraph || graph, id) || []));
        }
        frontier = next;
    }
    return out;
}

/** Whether a Fakemon has a prevolution that's one of your Fakemon (so the option means something). */
export function hasFakemonPrevolution(refId: string, graph: any): boolean {
    return !!refId && (api.prevolutionRefIds?.(graph, refId) || []).length > 0;
}

/**
 * Rebuilds the inherited copies on every Fakemon that has the option on (and
 * removes stale ones from any that turned it off). Runs before each save.
 * @returns how many Fakemon changed
 */
export function refreshInheritedMoves(db: any[] = state.fakemonDB || []): number {
    let changed = 0;
    for (const f of db) {
        if (!f || !Array.isArray(f.learnset)) continue;
        const own = ownMoves(f.learnset);
        const extra = f.inheritPrevoMoves ? inheritedMoves(String(f.id), f.evolutionGraph, own, db) : [];
        // compared whole, so a prevolution changing how a move is learned flows down too
        const before = JSON.stringify(f.learnset.filter(m => m?.inherited));
        if (before === JSON.stringify(extra) && f.learnset.length === own.length + extra.length) continue;
        f.learnset = [...own, ...extra];
        changed++;
    }
    if (changed) log.debug('MOVES', 'Inherited moves refreshed', { changed });
    return changed;
}

// ---- the editor ----

/** The open Fakemon's inherited moves, for the Moves tab's read-only list. */
export function inheritedMovesForEditor(): any[] {
    // a community post can't look its prevolutions up in your collection, so
    // it shows the copies it was published with
    const list = state.isCommunityPreview
        ? (state.inheritedLearnset || [])
        : (state.inheritPrevoMoves && state.editingId ? inheritedMoves(String(state.editingId), state.evolutionGraph, state.learnset || []) : []);
    // stored copies of main-game moves are just a name; fill in type and power
    return list.map(m => {
        const full = api.hydrateLearnsetEntry ? api.hydrateLearnsetEntry(m) : m;
        return { ...full, inherited: true, inheritedFrom: m.inheritedFrom };
    });
}

/** Whether the open Fakemon has a prevolution to inherit from. */
export function editorHasPrevolution(): boolean {
    return hasFakemonPrevolution(String(state.editingId || ''), state.evolutionGraph);
}

export function setInheritPrevoMoves(enabled: boolean) {
    state.inheritPrevoMoves = !!enabled;
    notify();
    api.updatePreview?.();
    api.autoSave?.();
}
