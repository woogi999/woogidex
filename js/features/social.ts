// ==================== the social side of the Community Hub ====================
// Following creators, blocking, the feed (mons and posts together, ranked by
// js/features/feed-algorithm.ts), posting, emoji reactions and post comments.
// The pages that draw all this are js/app/pages/CommunityPage.tsx (the feed),
// PostPage.tsx (one post) and ProfilePage.tsx (a creator's timeline).
//
// What the feed remembers about you lives on this device only (localStorage):
// which items you've scrolled past, which creators you interact with. It's
// used to rank, never sent anywhere.

import { log } from '../core/log.ts';
import { state, api } from '../core/app.ts';
import { notify } from '../app/store.ts';
import { navigateRoute, routeUrl } from '../core/router.ts';
import { publicName } from '../core/html.ts';
import { confirmDialog } from '../core/confirm-dialog.ts';
import { chronological, dailySeed, rankFeed, typeAffinityFrom, type FeedItem } from './feed-algorithm.ts';

export type FeedTab = 'foryou' | 'following' | 'latest';

interface SocialState {
    following: Set<string>;
    followingFor: string | null;
    blocked: Set<string>;
    feed: Record<FeedTab, { items: FeedItem[]; loading: boolean; fetchedAt: number; hasMore: boolean; error: string }>;
    post: { id: string | null; row: any; comments: any[] | null; loading: boolean; error: string };
}

function emptyTab() { return { items: [] as FeedItem[], loading: false, fetchedAt: 0, hasMore: true, error: '' }; }

function ss(): SocialState {
    if (!state.social) {
        state.social = {
            following: new Set<string>(), followingFor: null, blocked: new Set<string>(),
            feed: { foryou: emptyTab(), following: emptyTab(), latest: emptyTab() },
            post: { id: null, row: null, comments: null, loading: false, error: '' }
        } as SocialState;
    }
    return state.social;
}

export function socialState(): SocialState { return ss(); }

// ==================== what this device remembers ====================
const SEEN_KEY = 'woogidex.feed.seen.v1';
const OPENED_KEY = 'woogidex.feed.opened.v1';
const AFFINITY_KEY = 'woogidex.feed.affinity.v1';
const MAX_SEEN = 600;

function readJson<T>(key: string, fallback: T): T {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
function writeJson(key: string, value: unknown) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked: ranking just forgets */ }
}

let seenBuffer: Record<string, number> | null = null;
let seenFlush: any = null;

/** A card was on screen for a moment. Counted once per page view per item. */
const seenThisVisit = new Set<string>();
export function recordImpression(id: string) {
    if (!id || seenThisVisit.has(id)) return;
    seenThisVisit.add(id);
    seenBuffer ||= readJson<Record<string, number>>(SEEN_KEY, {});
    seenBuffer[id] = (seenBuffer[id] || 0) + 1;
    seenFlush ||= setTimeout(() => {
        seenFlush = null;
        const entries = Object.entries(seenBuffer || {});
        // keep the newest-touched ids; object order is insertion order
        writeJson(SEEN_KEY, Object.fromEntries(entries.slice(-MAX_SEEN)));
    }, 1500);
}

export function recordOpened(id: string, authorId?: string) {
    const opened: string[] = readJson(OPENED_KEY, []);
    if (!opened.includes(id)) writeJson(OPENED_KEY, [...opened, id].slice(-300));
    if (authorId) recordInteraction(authorId);
}

/** Liking, reacting, commenting or opening something by this creator. Slowly forgotten. */
export function recordInteraction(authorId: string) {
    if (!authorId || authorId === state.user?.id) return;
    const aff: Record<string, number> = readJson(AFFINITY_KEY, {});
    // older interactions fade: everything shrinks a little each time
    for (const k of Object.keys(aff)) { aff[k] *= 0.98; if (aff[k] < 0.2) delete aff[k]; }
    aff[authorId] = (aff[authorId] || 0) + 1;
    writeJson(AFFINITY_KEY, aff);
}

function viewerSignals() {
    return {
        viewerId: state.user?.id || null,
        following: ss().following,
        authorAffinity: readJson<Record<string, number>>(AFFINITY_KEY, {}),
        typeAffinity: typeAffinityFrom((state.fakemonDB || []).filter((f: any) => !f.pendingVanilla)),
        seen: { ...readJson<Record<string, number>>(SEEN_KEY, {}), ...(seenBuffer || {}) },
        opened: new Set<string>(readJson(OPENED_KEY, [])),
        seed: dailySeed(state.user?.id || null)
    };
}

// ==================== follows and blocks ====================
export async function onSocialAuthChange() {
    const s = ss();
    const uid = state.user?.id || null;
    if (s.followingFor === uid) return;
    s.followingFor = uid;
    s.following = new Set();
    s.blocked = new Set();
    s.feed = { foryou: emptyTab(), following: emptyTab(), latest: emptyTab() };
    if (!uid) { notify(); return; }
    try {
        const client = await api.getClient();
        const [follows, blocks] = await Promise.all([
            client.from('follows').select('followee_id').eq('follower_id', uid).limit(5000),
            client.from('user_blocks').select('blocked_id').eq('blocker_id', uid).limit(5000)
        ]);
        if (follows.error) throw follows.error;
        s.following = new Set((follows.data || []).map((r: any) => r.followee_id));
        s.blocked = new Set((blocks.data || []).map((r: any) => r.blocked_id));
    } catch (e: any) {
        log.warn('SOCIAL', 'Could not load who you follow', e);
    }
    notify();
}

export function isFollowing(userId: string) { return ss().following.has(String(userId)); }
export function hasBlocked(userId: string) { return ss().blocked.has(String(userId)); }

export async function followUser(userId: string): Promise<boolean> {
    if (!api.requireAccount?.('Sign in to follow creators.')) return false;
    if (!userId || userId === state.user!.id) return false;
    const client = await api.getClient();
    const { error } = await client.from('follows').insert({ follower_id: state.user!.id, followee_id: userId });
    if (error && error.code !== '23505') {
        api.showToast?.(error.message || 'Could not follow.', 'error');
        return false;
    }
    ss().following.add(userId);
    recordInteraction(userId);
    api.invalidateProfile?.(userId);
    api.createNotification?.({
        userId, actorId: state.user!.id, actorName: publicName(state.user), actorAvatarUrl: state.user!.avatarUrl || null,
        type: 'follow', targetId: state.user!.id, preview: ''
    });
    notify();
    return true;
}

export async function unfollowUser(userId: string): Promise<boolean> {
    if (!state.user) return false;
    const client = await api.getClient();
    const { error } = await client.from('follows').delete().eq('follower_id', state.user.id).eq('followee_id', userId);
    if (error) { api.showToast?.('Could not unfollow: ' + error.message, 'error'); return false; }
    ss().following.delete(userId);
    api.invalidateProfile?.(userId);
    notify();
    return true;
}

/** Takes someone out of your followers (they can follow again unless blocked). */
export async function removeFollower(userId: string): Promise<boolean> {
    if (!state.user) return false;
    const client = await api.getClient();
    const { error } = await client.from('follows').delete().eq('follower_id', userId).eq('followee_id', state.user.id);
    if (error) { api.showToast?.('Could not remove them: ' + error.message, 'error'); return false; }
    api.invalidateProfile?.(state.user.id);
    notify();
    return true;
}

export async function blockUser(userId: string, name = 'them'): Promise<boolean> {
    if (!state.user || !userId) return false;
    if (!await confirmDialog({
        title: `Block ${name}?`,
        message: 'You won’t see each other’s posts in your feeds, you’ll unfollow each other, and neither of you can message the other. You can unblock them any time from their profile.',
        confirmLabel: 'Block'
    })) return false;
    const client = await api.getClient();
    const { error } = await client.from('user_blocks').insert({ blocker_id: state.user.id, blocked_id: userId });
    if (error && error.code !== '23505') { api.showToast?.('Could not block: ' + error.message, 'error'); return false; }
    ss().blocked.add(userId);
    ss().following.delete(userId);
    for (const tab of Object.values(ss().feed)) tab.items = tab.items.filter(i => i.user_id !== userId);
    api.invalidateProfile?.(userId);
    api.showToast?.(`Blocked ${name}.`, 'info');
    notify();
    return true;
}

export async function unblockUser(userId: string): Promise<boolean> {
    if (!state.user) return false;
    const client = await api.getClient();
    const { error } = await client.from('user_blocks').delete().eq('blocker_id', state.user.id).eq('blocked_id', userId);
    if (error) { api.showToast?.('Could not unblock: ' + error.message, 'error'); return false; }
    ss().blocked.delete(userId);
    api.invalidateProfile?.(userId);
    notify();
    return true;
}

// ==================== the feed ====================
const FEED_MAX_AGE_MS = 60000;

/** A feed row as the hub's existing cards expect a published mon (fakemon_data.*). */
function shapeItem(raw: any): FeedItem {
    if (raw.kind === 'mon') {
        api.registerTypeLooks?.(raw.customTypes);
        return {
            ...raw,
            fakemon_data: { name: raw.name, species: raw.species, number: raw.number, type1: raw.type1, type2: raw.type2, customTypes: raw.customTypes || [] },
            published_at: raw.created_at
        };
    }
    for (const m of raw.mons || []) api.registerTypeLooks?.(m.customTypes);
    return { ...raw, mon_ids: raw.mon_ids || [], tags: raw.tags || [], reactions: raw.reactions || {}, my_reactions: raw.my_reactions || [] };
}

export async function fetchFeed(tab: FeedTab = 'foryou', { force = false, older = false }: { force?: boolean; older?: boolean } = {}) {
    if (!state.user) return;
    const t = ss().feed[tab];
    if (t.loading) return;
    if (!force && !older && t.items.length && Date.now() - t.fetchedAt < FEED_MAX_AGE_MS) return;
    t.loading = true;
    t.error = '';
    notify();
    try {
        const client = await api.getClient();
        const before = older && t.items.length ? chronological(t.items).at(-1)!.created_at : null;
        const { data, error } = await client.rpc('community_feed', {
            p_before: before, p_limit: tab === 'foryou' && !older ? 120 : 40, p_following_only: tab === 'following'
        });
        if (error) throw error;
        const rows = (data || []).map(shapeItem);
        await api.attachLiveAuthorInfo?.(rows);
        if (older) {
            const known = new Set(t.items.map(i => `${i.kind}:${i.id}`));
            const fresh = rows.filter(r => !known.has(`${r.kind}:${r.id}`));
            t.items = [...t.items, ...fresh];
            t.hasMore = fresh.length > 0;
        } else {
            t.items = rows;
            t.hasMore = rows.length > 0;
            t.fetchedAt = Date.now();
        }
    } catch (e: any) {
        log.error('SOCIAL', 'Feed load failed', e);
        t.error = /community_feed/.test(String(e?.message)) ? 'The feed isn’t switched on yet.' : 'Couldn’t load the feed.';
    } finally {
        t.loading = false;
        notify();
    }
}

// the order is computed once per load (and kept while you scroll), so cards
// don't jump around as impressions are recorded
const rankedCache = new Map<string, { fetchedAt: number; count: number; order: string[] }>();

/** The tab's items in the order to show them. */
export function feedItems(tab: FeedTab): FeedItem[] {
    const t = ss().feed[tab];
    const blocked = ss().blocked;
    const items = t.items.filter(i => !blocked.has(i.user_id));
    if (tab !== 'foryou') return chronological(items);
    const cached = rankedCache.get(tab);
    const byKey = new Map(items.map(i => [`${i.kind}:${i.id}`, i]));
    if (cached && cached.fetchedAt === t.fetchedAt) {
        if (cached.count === items.length) return cached.order.map(k => byKey.get(k)).filter(Boolean) as FeedItem[];
        // "show older" added items: rank just those, below what's already on screen
        const known = new Set(cached.order);
        const extra = rankFeed(items.filter(i => !known.has(`${i.kind}:${i.id}`)), viewerSignals()).map(s => `${s.item.kind}:${s.item.id}`);
        cached.order = [...cached.order.filter(k => byKey.has(k)), ...extra];
        cached.count = items.length;
        return cached.order.map(k => byKey.get(k)).filter(Boolean) as FeedItem[];
    }
    const ranked = rankFeed(items, viewerSignals()).map(s => s.item);
    rankedCache.set(tab, { fetchedAt: t.fetchedAt, count: items.length, order: ranked.map(i => `${i.kind}:${i.id}`) });
    return ranked;
}

/** Why an item is where it is: the algorithm's breakdown, for the "why am I seeing this" peek. */
export function explainFeedItem(item: FeedItem) {
    return rankFeed([item], viewerSignals())[0]?.why || {};
}

// ==================== posts ====================
/** #tags in a post's text, lowercased, as the server wants them. */
export function tagsIn(text: string): string[] {
    const tags = new Set<string>();
    for (const m of String(text || '').matchAll(/(^|\s)#([A-Za-z0-9_]{1,24})\b/g)) tags.add(m[2].toLowerCase());
    return [...tags].slice(0, 8);
}

export async function createPost({ body = '', monIds = [] as string[] }): Promise<string | null> {
    if (!api.requireAccount?.('Sign in to post.')) return null;
    const text = String(body || '').trim();
    if (!text && !monIds.length) { api.showToast?.('Write something or add a Fakemon first.', 'warning'); return null; }
    if (text.length > 4000) { api.showToast?.('Posts can be up to 4000 characters.', 'warning'); return null; }
    if (text && !(await api.guardContent?.(text, 'community post') ?? true)) return null;
    const client = await api.getClient();
    const { data, error } = await client.from('community_posts')
        .insert({ user_id: state.user!.id, body: text, mon_ids: monIds.slice(0, 12), tags: tagsIn(text) })
        .select('id').single();
    if (error) {
        log.error('SOCIAL', 'Post failed', error);
        api.showToast?.(api.friendlyModerationError?.(error) || error.message || 'Could not post.', 'error');
        return null;
    }
    api.showToast?.('Posted!', 'success');
    for (const t of Object.values(ss().feed)) t.fetchedAt = 0;
    api.invalidateProfile?.(state.user!.id);
    fetchFeed(currentFeedTab(), { force: true });
    return data?.id || null;
}

export async function editPost(postId: string, body: string): Promise<boolean> {
    const text = String(body || '').trim();
    if (text && !(await api.guardContent?.(text, 'community post') ?? true)) return false;
    const client = await api.getClient();
    const { data, error } = await client.from('community_posts').update({ body: text, tags: tagsIn(text) }).eq('id', postId).select('id, body, tags, edited_at');
    if (error || !data?.length) { api.showToast?.(api.friendlyModerationError?.(error) || error?.message || 'Could not edit that post.', 'error'); return false; }
    patchPostEverywhere(postId, data[0]);
    api.showToast?.('Post updated.', 'success');
    return true;
}

export async function deletePost(postId: string): Promise<boolean> {
    if (!await confirmDialog({ title: 'Delete this post?', message: 'Its comments and reactions go with it.', confirmLabel: 'Delete' })) return false;
    const client = await api.getClient();
    const { error } = await client.from('community_posts').delete().eq('id', postId);
    if (error) { api.showToast?.('Could not delete: ' + error.message, 'error'); return false; }
    for (const t of Object.values(ss().feed)) t.items = t.items.filter(i => !(i.kind === 'post' && i.id === postId));
    if (ss().post.id === postId) { ss().post = { id: null, row: null, comments: null, loading: false, error: '' }; api.openCommunityHub?.(); }
    api.invalidateProfile?.(state.user?.id);
    api.showToast?.('Post deleted.', 'info');
    notify();
    return true;
}

/** Every copy of a post on screen (feed tabs, the open post, a profile's timeline). */
function postCopies(postId: string): any[] {
    const out: any[] = [];
    for (const t of Object.values(ss().feed)) for (const i of t.items) if (i.kind === 'post' && i.id === postId) out.push(i);
    if (ss().post.row?.id === postId) out.push(ss().post.row);
    for (const i of state.profilePageUser?.timeline || []) if (i.kind === 'post' && i.id === postId) out.push(i);
    return [...new Set(out)];
}

function patchPostEverywhere(postId: string, patch: any) {
    for (const p of postCopies(postId)) Object.assign(p, patch);
    notify();
}

export async function toggleReaction(post: any, emoji: string) {
    if (!api.requireAccount?.('Sign in to react.')) return;
    const mine: string[] = post.my_reactions || [];
    const had = mine.includes(emoji);
    const client = await api.getClient();
    const { error } = had
        ? await client.from('post_reactions').delete().eq('post_id', post.id).eq('user_id', state.user!.id).eq('emoji', emoji)
        : await client.from('post_reactions').insert({ post_id: post.id, user_id: state.user!.id, emoji });
    if (error && error.code !== '23505') { api.showToast?.(error.message || 'Could not react.', 'error'); return; }
    for (const p of postCopies(post.id)) {
        const reactions = { ...(p.reactions || {}) };
        reactions[emoji] = Math.max(0, Number(reactions[emoji] || 0) + (had ? -1 : 1));
        if (!reactions[emoji]) delete reactions[emoji];
        p.reactions = reactions;
        p.my_reactions = had ? (p.my_reactions || []).filter((e: string) => e !== emoji) : [...(p.my_reactions || []), emoji];
    }
    if (!had) recordInteraction(post.user_id);
    notify();
}

/** Like/unlike a published mon shown in the feed or a timeline (rows that aren't in the hub's grid). */
export async function toggleFeedMonLike(row: any) {
    if (!api.requireAccount?.('Sign in to like Fakemon.')) return;
    const client = await api.getClient();
    const liked = !!row.liked_by_me;
    const { error } = liked
        ? await client.from('mon_likes').delete().eq('mon_id', row.id).eq('user_id', state.user!.id)
        : await client.from('mon_likes').insert({ mon_id: row.id, user_id: state.user!.id });
    if (error && error.code !== '23505') { api.showToast?.('Could not like: ' + error.message, 'error'); return; }
    const copies = new Set<any>([row]);
    for (const t of Object.values(ss().feed)) for (const i of t.items) if (i.kind === 'mon' && i.id === row.id) copies.add(i);
    for (const i of state.profilePageUser?.timeline || []) if (i.kind === 'mon' && i.id === row.id) copies.add(i);
    for (const r of copies) { r.liked_by_me = !liked; r.like_count = Math.max(0, Number(r.like_count || 0) + (liked ? -1 : 1)); }
    if (!liked) recordInteraction(row.user_id);
    notify();
}

// ==================== one post (/post/<id>) ====================
export async function openPost(postId: string, { preserveRoute = false } = {}): Promise<boolean> {
    if (!api.requireAccount?.('Sign in to see this post.', () => openPost(postId, { preserveRoute }))) return false;
    const p = ss().post;
    p.id = postId;
    p.loading = true;
    p.error = '';
    p.row = postCopies(postId)[0] || null;
    p.comments = null;
    api.activateTopLevelView?.('post-view');
    if (!preserveRoute) navigateRoute(`post/${encodeURIComponent(postId)}`);
    api.setPageTitle?.('Post');
    notify();
    try {
        const client = await api.getClient();
        const [{ data: row, error }, stats, comments] = await Promise.all([
            client.from('community_posts').select('*').eq('id', postId).maybeSingle(),
            client.rpc('community_post_stats', { p_ids: [postId] }),
            client.from('post_comments').select('*').eq('post_id', postId).order('created_at', { ascending: true }).limit(500)
        ]);
        if (error) throw error;
        if (!row) { p.error = 'This post was deleted, or the link is wrong.'; return true; }
        const s = stats.data?.[0] || {};
        let mons: any[] = [];
        if (row.mon_ids?.length) {
            const { data } = await client.from('published_mons')
                .select('id, fakemon_data->>name, fakemon_data->>type1, fakemon_data->>type2, customTypes:fakemon_data->customTypes')
                .in('id', row.mon_ids);
            mons = (row.mon_ids as string[]).map(id => (data || []).find((m: any) => m.id === id)).filter(Boolean);
        }
        const full = shapeItem({ ...row, kind: 'post', mons, comment_count: Number(s.comment_count || 0), reactions: s.reactions || {}, my_reactions: s.my_reactions || [] });
        const rows = [full, ...(comments.data || [])];
        await api.attachLiveAuthorInfo?.(rows);
        p.row = full;
        p.comments = comments.data || [];
        recordOpened(postId, row.user_id);
        api.setPageTitle?.(`Post by ${full.author_name || 'someone'}`);
        api.setShareMeta?.({ title: `Post by ${full.author_name || 'someone'}`, description: String(row.body || '').slice(0, 200) });
        return true;
    } catch (e: any) {
        log.error('SOCIAL', 'Post load failed', e);
        p.error = 'Couldn’t load this post.';
        return true;
    } finally {
        p.loading = false;
        notify();
    }
}

export function postShareUrl(postId: string) { return routeUrl(`post/${encodeURIComponent(postId)}`); }

export async function copyPostLink(postId: string) {
    const url = postShareUrl(postId);
    try { await navigator.clipboard.writeText(url); api.showToast?.('Link copied!', 'success'); }
    catch { window.prompt('Copy this link:', url); }
}

export async function commentOnPost(postId: string, body: string): Promise<boolean> {
    if (!api.requireAccount?.('Sign in to comment.')) return false;
    const text = String(body || '').trim();
    if (!text) return false;
    if (text.length > 1000) { api.showToast?.('Comments are limited to 1000 characters.', 'warning'); return false; }
    if (!(await api.guardContent?.(text, 'post comment') ?? true)) return false;
    const client = await api.getClient();
    const { data, error } = await client.from('post_comments').insert({ post_id: postId, user_id: state.user!.id, body: text }).select('*').single();
    if (error) { api.showToast?.(api.friendlyModerationError?.(error) || error.message || 'Comment failed.', 'error'); return false; }
    await api.attachLiveAuthorInfo?.([data]);
    const p = ss().post;
    if (p.id === postId) p.comments = [...(p.comments || []), data];
    for (const c of postCopies(postId)) c.comment_count = Number(c.comment_count || 0) + 1;
    const owner = postCopies(postId)[0]?.user_id;
    if (owner) {
        recordInteraction(owner);
        api.createNotification?.({
            userId: owner, actorId: state.user!.id, actorName: publicName(state.user), actorAvatarUrl: state.user!.avatarUrl || null,
            type: 'post_comment', targetId: postId, targetName: 'your post', preview: text
        });
    }
    notify();
    return true;
}

export async function deletePostComment(commentId: string, postId: string) {
    const client = await api.getClient();
    const { error } = await client.from('post_comments').delete().eq('id', commentId);
    if (error) { api.showToast?.('Could not delete: ' + error.message, 'error'); return; }
    const p = ss().post;
    if (p.id === postId && p.comments) p.comments = p.comments.filter(c => c.id !== commentId);
    for (const c of postCopies(postId)) c.comment_count = Math.max(0, Number(c.comment_count || 0) - 1);
    notify();
}

// ==================== a creator's timeline and follow lists ====================
export async function fetchTimeline(userId: string, before: string | null = null): Promise<any[]> {
    const client = await api.getClient();
    const { data, error } = await client.rpc('profile_timeline', { p_user: userId, p_before: before, p_limit: 30 });
    if (error) throw error;
    const rows = (data || []).map(shapeItem);
    await api.attachLiveAuthorInfo?.(rows);
    return rows;
}

export async function fetchSocialStats(userId: string) {
    const client = await api.getClient();
    const { data, error } = await client.rpc('profile_social_stats', { p_user: userId });
    if (error) throw error;
    return data || {};
}

export async function fetchFollowList(userId: string, which: 'followers' | 'following') {
    const client = await api.getClient();
    const { data, error } = await client.rpc('profile_follow_list', { p_user: userId, p_which: which, p_limit: 200 });
    if (error) throw error;
    return data || [];
}

/** Your followers (the people you're allowed to add to a group chat). */
export async function myFollowers() {
    if (!state.user) return [];
    return fetchFollowList(state.user.id, 'followers');
}

// ==================== which tab ====================
const TAB_KEY = 'woogidex.community.feedtab.v1';
export function currentFeedTab(): FeedTab {
    try {
        const t = localStorage.getItem(TAB_KEY);
        return t === 'following' || t === 'latest' ? t : 'foryou';
    } catch { return 'foryou'; }
}
export function setFeedTab(tab: FeedTab) {
    try { localStorage.setItem(TAB_KEY, tab); } catch {}
    notify();
    fetchFeed(tab);
}
