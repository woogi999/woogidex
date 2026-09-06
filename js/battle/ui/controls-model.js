// ==================== what the battle controls should be showing ====================
// The control strip below the field is a small state machine, and it was
// written as a chain of early returns inside a function that also built HTML.
// The order of those returns is the whole behaviour, and every one of them was
// added because showing the wrong thing at that moment broke a battle:
//
//   * The animation check comes before everything about choices. Asking for a
//     move while the previous turn is still playing shows stale HP and a
//     Pokemon that has already fainted.
//   * A forced switch comes before the switch panel the player opened, because
//     "choose your next Pokemon" is not a cancellable panel.
//   * Waiting on the opponent's replacement comes before offering moves,
//     because choosing against a Pokemon that is not on the field yet is
//     choosing against nothing.
//
// Ordering rules like that are exactly what a test can hold still, and exactly
// what nothing could check while they lived inside a template literal.

/**
 * @typedef {'none'|'lead'|'desync'|'ended'|'animating'|'forced-switch'
 *           |'waiting-opponent-switch'|'switch'|'moves'} ControlsKind
 */

/**
 * Which pane the controls should show, given everything the UI knows.
 *
 * @param {object} ui the battle UI state: {leadPick, battle, meta, animating, switchPanelOpen}
 * @returns {{kind: ControlsKind}}
 */
export function controlsView(ui = {}) {
    if (ui.leadPick) return { kind: 'lead' };

    const b = ui.battle;
    if (!b) return { kind: 'none' };

    if (ui.meta?.desynced) return { kind: 'desync' };
    if (b.ended) return { kind: 'ended' };
    if (ui.animating) return { kind: 'animating' };

    const mySide = ui.meta?.mySide ?? 0;
    if (b.needsSwitch?.(mySide)) return { kind: 'forced-switch' };

    // Only in PvP. Against a bot the replacement is chosen locally and there is
    // nothing to wait for.
    if (ui.meta?.mode === 'pvp' && b.needsSwitch?.(1 - mySide)) {
        return { kind: 'waiting-opponent-switch' };
    }

    if (ui.switchPanelOpen) return { kind: 'switch' };
    return { kind: 'moves' };
}

/**
 * Who can be switched in: anyone still standing who is not already out.
 * An empty result is a real state -- the last Pokemon is on the field and there
 * is nobody behind it.
 */
export function switchOptions(side) {
    if (!side?.team) return [];
    return side.team
        .map((m, i) => ({ m, i }))
        .filter(({ m, i }) => !m.fainted && i !== side.activeIndex);
}

/** Which band an HP bar is in. Drives its colour, so it has to be exhaustive. */
export function hpTone(percent) {
    if (percent > 50) return 'is-high';
    if (percent > 20) return 'is-mid';
    return 'is-low';
}

/** A Pokemon's remaining HP as a whole percentage, clamped to the bar's range. */
export function hpPercent(member) {
    if (!member?.maxhp) return 0;
    return Math.max(0, Math.min(100, Math.round((member.hp / member.maxhp) * 100)));
}

/**
 * The connection banner above a PvP battle, or null when there is nothing to
 * say. Reporting the connection honestly matters more here than anywhere else
 * in the app: when two players cannot reach each other there is nothing on
 * screen to explain it, and "it just never connects" is unactionable.
 *
 * @returns {{tone: 'bad'|'', icon: string, label: string, note: string, canRetry: boolean}|null}
 */
export function connectionBanner(meta = {}) {
    const status = meta.connStatus;

    // A refused handshake is fatal to the battle, and the reason is the useful
    // part -- it says which side's rules did not match.
    if (status === 'connected' && meta.handshake && !meta.handshake.ok) {
        return { tone: 'bad', icon: 'wifi-off', label: meta.handshake.reason || '', note: '', canRetry: false };
    }

    const label = {
        connecting: 'Connecting to opponent…',
        reconnecting: 'Connection lost - reconnecting…',
        lost: 'Could not reconnect to your opponent.',
        connected: meta.handshake?.ok
            ? 'Checking both games match…'
            : 'Agreeing on the rules with your opponent…'
    }[status] || '';

    if (!label) return null;

    // Two players behind symmetric NAT need a TURN relay to reach each other at
    // all. When the relay credentials could not be fetched the connection is
    // STUN-only, and saying so turns a silent failure into something the player
    // -- or whoever runs the site -- can act on.
    const note = status !== 'connected' && meta.rtc && meta.rtc.hasTurn === false
        ? "No relay server available - if this doesn't connect, the metered-ice function needs its Metered.ca credentials."
        : '';

    return {
        tone: status === 'lost' ? 'bad' : '',
        icon: status === 'lost' ? 'wifi-off' : 'loader',
        label,
        note,
        canRetry: status === 'lost'
    };
}
