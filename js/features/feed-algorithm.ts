// ==================== the "For you" feed ====================
// Ranks the Community Hub's mons and posts for one viewer. Pure functions,
// no network and no state: the caller hands in the candidate pool (from the
// community_feed() RPC) and what this device remembers about the viewer, and
// gets back an ordering. docs/feed-algorithm.md explains every number here in
// plain words; keep the two in step.
//
// The shape of it:
//   1. every item gets a quality score from its engagement (likes, reactions,
//      comments, views), with diminishing returns so one viral post can't
//      bury everything,
//   2. that score decays with age, gently, like Hacker News' gravity,
//   3. personal multipliers: people you follow, people you interact with,
//      types you like to make, things you've already seen,
//   4. a little seeded randomness, so the long tail gets a turn,
//   5. a diversity pass, so one creator (or ten text posts in a row) can't
//      take over the top of the feed.

export interface FeedItem {
    kind: 'mon' | 'post';
    id: string;
    user_id: string;
    created_at: string;
    activity_at?: string;
    // mons
    like_count?: number;
    comment_count?: number;
    view_count?: number;
    type1?: string;
    type2?: string;
    // posts
    body?: string;
    reactions?: Record<string, number>;
    mon_ids?: string[];
    mons?: any[];
    followed?: boolean;
    [extra: string]: any;
}

export interface ViewerSignals {
    viewerId: string | null;
    /** user ids the viewer follows */
    following: Set<string>;
    /** author id -> how many times the viewer liked, reacted, commented on or opened their things lately */
    authorAffinity: Record<string, number>;
    /** type name (lowercase) -> share of the viewer's own Fakemon with that type, 0..1 */
    typeAffinity: Record<string, number>;
    /** item id -> how many times it has been on the viewer's screen */
    seen: Record<string, number>;
    /** item ids the viewer opened */
    opened: Set<string>;
    /** fixes the randomness for a day, so refreshing doesn't reshuffle everything */
    seed: string;
    now?: number;
}

export interface Scored { item: FeedItem; score: number; why: Record<string, number>; }

// ---- the tuning knobs (docs/feed-algorithm.md, "The numbers") ----
export const WEIGHTS = {
    like: 1,
    reaction: 1,
    comment: 3,
    view: 0.02,
    engagementPower: 0.8,     // (1 + engagement)^0.8: diminishing returns
    gravity: 1.4,             // how fast age pulls a score down
    ageOffsetHours: 2,        // so a brand-new item isn't divided by ~0
    activityBoost: 0.35,      // extra weight for a fresh comment on an older item
    activityHalfLifeHours: 12,
    followed: 1.8,
    ownPost: 0.6,
    affinityPerInteraction: 0.15,
    affinityCap: 0.8,
    typeMatch: 0.3,           // at most +30% for a mon in types you love
    seenDecay: 0.75,          // each previous impression keeps 75%
    seenFloor: 0.25,
    opened: 0.5,
    withMons: 1.15,           // posts that show Fakemon off
    tinyText: 0.8,            // a post under 20 characters with nothing attached
    newVoice: 1.25,           // someone's only recent item, under two days old
    jitter: 0.1,              // +-10%
    authorRepeat: 0.65,       // each earlier pick by the same creator in the top
    kindStreak: 0.85,         // a third item of the same kind in a row
    diversityWindow: 12
};

const HOUR = 3600 * 1000;

function fnv(text: string): number {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

/** Likes, reactions, comments and views, weighted. */
export function engagement(item: FeedItem): number {
    const reactions = Object.values(item.reactions || {}).reduce((s, n) => s + Number(n || 0), 0);
    return Number(item.like_count || 0) * WEIGHTS.like
        + reactions * WEIGHTS.reaction
        + Number(item.comment_count || 0) * WEIGHTS.comment
        + Number(item.view_count || 0) * WEIGHTS.view;
}

/** Quality and age only: the same for every viewer. */
export function baseScore(item: FeedItem, now = Date.now()): { score: number; why: Record<string, number> } {
    const ageH = Math.max(0, (now - new Date(item.created_at).getTime()) / HOUR);
    const quality = Math.pow(1 + engagement(item), WEIGHTS.engagementPower);
    const decayed = quality / Math.pow(ageH + WEIGHTS.ageOffsetHours, WEIGHTS.gravity);
    // a comment or reaction today brings an older item back up, a little
    const activityAgeH = item.activity_at ? Math.max(0, (now - new Date(item.activity_at).getTime()) / HOUR) : ageH;
    const revived = activityAgeH < ageH
        ? WEIGHTS.activityBoost * quality * Math.pow(0.5, activityAgeH / WEIGHTS.activityHalfLifeHours) / Math.pow(WEIGHTS.ageOffsetHours + 24, WEIGHTS.gravity)
        : 0;
    return { score: decayed + revived, why: { quality, ageHours: ageH, decayed, revived } };
}

/** Everything about this viewer that moves an item up or down. */
export function personalMultiplier(item: FeedItem, v: ViewerSignals, authorCounts: Map<string, number>, now = Date.now()) {
    const why: Record<string, number> = {};
    let m = 1;
    const mine = !!v.viewerId && item.user_id === v.viewerId;
    if (mine) { m *= WEIGHTS.ownPost; why.own = WEIGHTS.ownPost; }
    else if (item.followed || v.following.has(item.user_id)) { m *= WEIGHTS.followed; why.followed = WEIGHTS.followed; }

    const interactions = v.authorAffinity[item.user_id] || 0;
    if (interactions && !mine) {
        const boost = 1 + Math.min(WEIGHTS.affinityCap, interactions * WEIGHTS.affinityPerInteraction);
        m *= boost; why.affinity = boost;
    }

    if (item.kind === 'mon') {
        const types = [item.type1, item.type2].filter(Boolean).map(t => String(t).toLowerCase());
        const love = Math.max(0, ...types.map(t => v.typeAffinity[t] || 0));
        if (love > 0) { const boost = 1 + WEIGHTS.typeMatch * Math.min(1, love * 2); m *= boost; why.types = boost; }
    } else {
        if ((item.mon_ids || []).length) { m *= WEIGHTS.withMons; why.withMons = WEIGHTS.withMons; }
        else if (String(item.body || '').trim().length < 20) { m *= WEIGHTS.tinyText; why.tinyText = WEIGHTS.tinyText; }
    }

    const seen = v.seen[item.id] || 0;
    if (seen) { const keep = Math.max(WEIGHTS.seenFloor, Math.pow(WEIGHTS.seenDecay, seen)); m *= keep; why.seen = keep; }
    if (v.opened.has(item.id)) { m *= WEIGHTS.opened; why.opened = WEIGHTS.opened; }

    const ageH = (now - new Date(item.created_at).getTime()) / HOUR;
    if (!mine && (authorCounts.get(item.user_id) || 0) === 1 && ageH < 48) { m *= WEIGHTS.newVoice; why.newVoice = WEIGHTS.newVoice; }

    // the same for a viewer all day, different between viewers and days
    const jitter = 1 + WEIGHTS.jitter * ((fnv(`${v.seed}:${item.id}`) / 0xffffffff) * 2 - 1);
    m *= jitter; why.jitter = jitter;
    return { multiplier: m, why };
}

/** Scores every item; no ordering decisions yet. */
export function scoreItems(items: FeedItem[], v: ViewerSignals): Scored[] {
    const now = v.now ?? Date.now();
    const authorCounts = new Map<string, number>();
    for (const it of items) authorCounts.set(it.user_id, (authorCounts.get(it.user_id) || 0) + 1);
    return items.map(item => {
        const base = baseScore(item, now);
        const personal = personalMultiplier(item, v, authorCounts, now);
        return { item, score: base.score * personal.multiplier, why: { ...base.why, ...personal.why } };
    });
}

/**
 * Picks the order greedily: at each step, the best remaining item after
 * penalising creators who already appear in the recent picks and a third
 * item of the same kind in a row. Everything still appears; diversity only
 * changes the order.
 */
export function diversify(scored: Scored[]): Scored[] {
    const left = [...scored].sort((a, b) => b.score - a.score);
    const out: Scored[] = [];
    while (left.length) {
        const recent = out.slice(-WEIGHTS.diversityWindow);
        const lastTwo = out.slice(-2).map(s => s.item.kind);
        let best = 0;
        let bestValue = -Infinity;
        // the best unpenalised score can't be beaten by anything below a
        // point, so only the top slice is worth checking each step
        for (let i = 0; i < Math.min(left.length, 40); i++) {
            const s = left[i];
            const repeats = recent.filter(r => r.item.user_id === s.item.user_id).length;
            let value = s.score * Math.pow(WEIGHTS.authorRepeat, repeats);
            if (lastTwo.length === 2 && lastTwo.every(k => k === s.item.kind)) value *= WEIGHTS.kindStreak;
            if (value > bestValue) { bestValue = value; best = i; }
        }
        out.push(left.splice(best, 1)[0]);
    }
    return out;
}

/** The whole thing: score, then order for variety. */
export function rankFeed(items: FeedItem[], v: ViewerSignals): Scored[] {
    return diversify(scoreItems(items, v));
}

/** Newest first; what the Latest and Following tabs use. */
export function chronological(items: FeedItem[]): FeedItem[] {
    return [...items].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

/** A seed that changes once a day per viewer (UTC), so the jitter is stable for a day. */
export function dailySeed(viewerId: string | null, date = new Date()): string {
    return `${viewerId || 'guest'}:${date.toISOString().slice(0, 10)}`;
}

/** The share of the viewer's own Fakemon that have each type, for typeAffinity. */
export function typeAffinityFrom(mons: Array<{ type1?: string; type2?: string }>): Record<string, number> {
    const counts: Record<string, number> = {};
    const list = (mons || []).filter(Boolean);
    for (const f of list) {
        for (const t of new Set([f.type1, f.type2].filter(Boolean).map(x => String(x).toLowerCase()))) counts[t] = (counts[t] || 0) + 1;
    }
    const total = list.length || 1;
    return Object.fromEntries(Object.entries(counts).map(([t, n]) => [t, n / total]));
}
