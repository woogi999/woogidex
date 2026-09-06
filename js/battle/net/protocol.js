// Battle wire protocol: explicit message shapes for the P2P data channel.
// Every inbound message is shape-checked before the engine sees it, since the
// sender is the opponent's browser, not a trusted server.

export const MSG = {
    HELLO: 'hello',               // engine + dataset versions this client runs
    SETUP: 'setup',               // digest of the battle each client actually built
    TEAM: 'team',                 // one chunk of the sender's full team package
    CHOICE: 'choice',             // a move/switch/forfeit chosen for a specific turn
    SWITCH: 'switch',             // out-of-band forced replacement (post-faint)
    HASH: 'hash',                 // post-turn state hash, for desync detection
    RESYNC_REQUEST: 'resync-request',
    RESYNC: 'resync',             // full ordered action log, to rebuild after a drop
    FORFEIT: 'forfeit',
    CHAT: 'chat'                  // a line of battle chat
};

const CHOICE_TYPES = new Set(['move', 'switch', 'forfeit']);

// 16k chars sits well inside data-channel message limits; 512 chunks is ~8MB.
export const TEAM_CHUNK_CHARS = 16000;
const TEAM_MAX_CHUNK_CHARS = 65536;
const TEAM_MAX_CHUNKS = 512;

// ==================== ruleset handshake ====================
// Lockstep only works if both clients run the SAME rules. Engine version must
// match outright; the move/ability tables are fetched data a client can
// legitimately lack, so clients declare what they have before turn 1 and play
// the intersection rather than diverging mid-battle. A fingerprint (see
// sd-moves.js movesFingerprint) is compared for equality only, not a security boundary.

// pure and symmetric so both sides reach the same result from the same two HELLOs
export function negotiateCaps(mine, theirs) {
    const agree = (a, b) => !!a && a === b;
    return {
        sdMoves: agree(mine?.moves, theirs?.moves),
        sdAbilities: agree(mine?.abilities, theirs?.abilities),
        sdItems: agree(mine?.items, theirs?.items)
    };
}

// ==================== lobby polling ====================
// an accepted challenge keeps showing as accepted on every poll, so this checks
// for challenges not yet announced to the UI, not just any accepted challenge,
// to avoid tearing down/rebuilding the battle screen every poll
export function nextBattleToAnnounce(challenges, announced) {
    return (challenges || []).find(c =>
        isPlainObject(c) && c.status === 'accepted' && c.battle_id
        && !announced?.has(c.battle_id)) || null;
}

// Null when the two can play; a human-readable reason when they cannot.
export function handshakeBlocker(mine, theirs) {
    if (!theirs) return null;
    if (mine?.engine !== theirs.engine) {
        return 'You and your opponent are on different versions of the battle engine. '
            + 'One of you needs to reload the page.';
    }
    return null;
}

// ==================== setup verification ====================
// The handshake settles what the rules are; this settles whether both clients
// actually built the same battle from them (stale local team, mismatched lead,
// etc). Each client hashes what it built before turn 1 so mismatches surface
// immediately, part by part, instead of as a confusing hash mismatch turns later.
const SETUP_PARTS = ['seed', 'teams', 'leads', 'caps'];

const SETUP_PART_REASON = {
    seed: 'The two of you are running different battle seeds. Neither client can trust the other\'s dice, so this battle cannot be played.',
    teams: 'The teams on the two clients do not match. One of you is holding an out-of-date copy of a team. Returning to the lobby and challenging again will rebuild both from the same source.',
    leads: 'The two clients disagree about who is starting in front. Returning to the lobby and challenging again will settle it.',
    caps: 'The two clients disagree about which rules are in force, despite agreeing on them a moment ago. One of you should reload the page.'
};

// null when battles match; otherwise the first differing part plus an actionable reason
export function setupMismatch(mine, theirs) {
    if (!isPlainObject(mine) || !isPlainObject(theirs)) return null;
    for (const part of SETUP_PARTS) {
        if (mine[part] !== theirs[part]) {
            return { part, reason: SETUP_PART_REASON[part] };
        }
    }
    return null;
}

// what was given up to reach agreement, for telling the player why the battle is limited
export function reducedCaps(mine, agreed) {
    const lost = [];
    if (mine?.moves && !agreed.sdMoves) lost.push('move effects');
    if (mine?.abilities && !agreed.sdAbilities) lost.push('ability effects');
    if (mine?.items && !agreed.sdItems) lost.push('item effects');
    return lost;
}

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// Struggle isn't one of the 4 real moves (engine supplies it), so it sits outside
// 0..5; kept as a literal (not imported) to keep this module dependency-free.
const STRUGGLE_CHOICE_INDEX = -1;

export function isValidChoice(c) {
    if (!isPlainObject(c) || !CHOICE_TYPES.has(c.type)) return false;
    if (c.type === 'forfeit') return true;
    if (!Number.isInteger(c.index)) return false;
    if (c.type === 'move' && c.index === STRUGGLE_CHOICE_INDEX) return true;
    return c.index >= 0 && c.index < 6;
}

function isValidAction(a) {
    if (!isPlainObject(a) || !Number.isInteger(a.turn)) return false;
    if (a.kind === 'switch') return (a.side === 0 || a.side === 1) && Number.isInteger(a.index) && a.index >= 0 && a.index < 6;
    if (a.kind === 'turn') return Array.isArray(a.choices) && a.choices.length === 2 && a.choices.every(isValidChoice);
    return false;
}

export function isValidPeerMessage(msg) {
    if (!isPlainObject(msg) || typeof msg.type !== 'string') return false;
    switch (msg.type) {
        case MSG.HELLO:
            return Number.isInteger(msg.engine)
                && typeof msg.moves === 'string' && msg.moves.length <= 32
                && typeof msg.abilities === 'string' && msg.abilities.length <= 32
                // older builds send no item fingerprint; absent reads as "no item table" rather than malformed
                && (msg.items === undefined || (typeof msg.items === 'string' && msg.items.length <= 32))
                // which of their six leads; rides the hello since each client builds the
                // opponent's side before knowing this. absent on older builds = "the first one"
                && (msg.lead === undefined || (Number.isInteger(msg.lead) && msg.lead >= 0 && msg.lead < 6));
        case MSG.SETUP:
            // bounded here so a hostile peer can't post a novel into the mismatch message
            return SETUP_PARTS.every(p => typeof msg[p] === 'string' && msg[p].length > 0 && msg[p].length <= 64);
        case MSG.TEAM:
            // bounds enforced here (not just at receiver) so a hostile peer can't grow the buffer unbounded
            return Number.isInteger(msg.total) && msg.total > 0 && msg.total <= TEAM_MAX_CHUNKS
                && Number.isInteger(msg.seq) && msg.seq >= 0 && msg.seq < msg.total
                && typeof msg.data === 'string' && msg.data.length <= TEAM_MAX_CHUNK_CHARS;
        case MSG.CHOICE:
            return Number.isInteger(msg.turn) && isValidChoice(msg.choice);
        case MSG.SWITCH:
            return Number.isInteger(msg.index) && msg.index >= 0 && msg.index < 6;
        case MSG.HASH:
            return Number.isInteger(msg.turn) && typeof msg.hash === 'string';
        case MSG.RESYNC_REQUEST:
            return true;
        case MSG.RESYNC:
            return Array.isArray(msg.actions) && msg.actions.every(isValidAction);
        case MSG.FORFEIT:
            return true;
        case MSG.CHAT:
            return typeof msg.text === 'string' && msg.text.length > 0 && msg.text.length <= 300;
        default:
            return false;
    }
}
