// ==================== Showdown item bridge ====================
// Runs Pokemon Showdown's own item handlers rather than re-implementing them.
// MIT licensed, https://github.com/smogon/pokemon-showdown
//
// Same arrangement as moves/abilities: builtin-items.js only hand-wrote a
// couple dozen items, so this fetches the simulator's full item table and
// runs it through the shared hook compiler, falling back to builtins on failure.

import { toId } from '../../core/html.js';
import { loadShowdownTable, fingerprint, sdDataUrl, SD_VERSION } from './sd-facade.js';
import { compileHookTable } from './sd-hooks.js';

let tablePromise = null;
let TABLE = null;
let FINGERPRINT = null;

// Pinned to SD_VERSION (sd-facade.js) so both players compile from the same table.
export function loadShowdownItems() {
    if (TABLE) return Promise.resolve(TABLE);
    tablePromise ||= loadShowdownTable(
        sdDataUrl('items'),
        (exports) => exports.Items || exports.BattleItems,
        'leftovers'
    ).then(table => { TABLE = table; return TABLE; })
        .catch(err => {
            tablePromise = null;
            console.warn('[BATTLE] Showdown items unavailable, using builtins', err);
            return null;
        });
    return tablePromise;
}

export function showdownItemsLoaded() { return !!TABLE; }

// Identifies which item table this client holds, so both players can check they match.
export function itemsFingerprint() {
    if (!TABLE) return '';
    FINGERPRINT ||= fingerprint(`${SD_VERSION}|${Object.keys(TABLE).sort().join(',')}`);
    return FINGERPRINT;
}

// One item's own handlers, in this engine's { event: [handler] } shape.
export function showdownItemHandlers(itemName) {
    if (!TABLE) return null;
    const id = toId(itemName);
    const entry = TABLE[id];
    if (!entry) return null;
    return compileHookTable(entry, entry.name || itemName, { isItem: true });
}

// The item table also carries the descriptive fields the editor's item picker
// wants (name, description, fling power), so it does not need a second fetch.
export function showdownItemEntry(itemName) {
    const entry = TABLE?.[toId(itemName)];
    if (!entry) return null;
    return {
        id: toId(itemName), name: entry.name || itemName,
        desc: entry.shortDesc || entry.desc || '',
        isBerry: !!entry.isBerry, megaStone: entry.megaStone || null
    };
}
