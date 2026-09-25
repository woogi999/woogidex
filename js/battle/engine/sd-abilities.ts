// ==================== Showdown ability bridge ====================
// Runs Pokemon Showdown's own ability handlers instead of re-implementing them.
// MIT licensed, https://github.com/smogon/pokemon-showdown
//
// The client data file (descriptive only: name/desc/rating) has no logic; the
// simulator's table has the real functions (e.g. onSwitchOut for regenerator).
// This fetches the compiled simulator table and runs it through the shared
// hook compiler (sd-hooks.ts), same as the item bridge.

import { toId } from '../../core/html.ts';
import { loadShowdownTable, fingerprint, sdDataUrl, SD_VERSION } from './sd-facade.ts';
import { compileHookTable } from './sd-hooks.ts';

let tablePromise: any = null;
let TABLE: any = null;
let FINGERPRINT: any = null;

// Pinned to SD_VERSION (sd-facade.ts) so both players compile from the same
// table. Falls back to builtins on failure.
export function loadShowdownAbilities() {
    if (TABLE) return Promise.resolve(TABLE);
    tablePromise ||= loadShowdownTable(
        sdDataUrl('abilities'),
        (exports) => exports.Abilities || exports.BattleAbilities,
        'regenerator'
    ).then(table => { TABLE = table; return TABLE; })
        .catch(err => {
            tablePromise = null;
            console.warn('[BATTLE] Showdown abilities unavailable, using builtins', err);
            return null;
        });
    return tablePromise;
}

export function showdownAbilityLoaded() { return !!TABLE; }

// Identifies which ability table this client holds, so both players can check they match.
export function abilitiesFingerprint() {
    if (!TABLE) return '';
    FINGERPRINT ||= fingerprint(`${SD_VERSION}|${Object.keys(TABLE).sort().join(',')}`);
    return FINGERPRINT;
}

// ---------------------------------------------------------------- compile
// Turns one Showdown ability into this engine's { event: [handler] } shape.
export function showdownAbilityHandlers(abilityName) {
    if (!TABLE) return null;
    const entry = TABLE[toId(abilityName)];
    if (!entry) return null;
    return compileHookTable(entry, entry.name || abilityName);
}
