// The Community Hub (/community): a landing page of shelves, the browsable
// listing, events and contests, and your own uploads. Data and actions stay in
// js/features/community.ts; this draws state.community.

import { api, state } from '../../core/app.ts';
import { CommunityFeed, LandingCard, LazyArt, type FeedRow } from '../components/community.tsx';
import { EventsPanel } from '../components/EventsPanel.tsx';
import { Icon } from '../components/Icon.tsx';
import { getLiveContests } from '../../features/contests.ts';
import { useStore } from '../store.ts';

type Panel = 'landing' | 'browse' | 'events' | 'uploads';

const TABS: Array<[Panel, string]> = [['landing', 'Hub'], ['browse', 'Browse'], ['events', 'Events'], ['uploads', 'My uploads']];

export function CommunityPage() {
    useStore();
    const cs = api.communityState();
    const panel: Panel = cs.panel || 'landing';
    return (
        <>
            <div className="page-header">
                <div className="page-heading">
                    <h1 className="page-title">Community Hub</h1>
                    <p className="page-subtitle">Every Fakémon here was designed by someone in this community. Browse, comment, or publish one of your own.</p>
                </div>
                <div className="page-actions">
                    <button className="btn btn-primary" type="button" onClick={() => api.openCommunityPublishModal()}><Icon name="upload" /><span>Publish a Fakémon</span></button>
                </div>
            </div>

            <div className="tabs community-tabs" id="community-tabs" role="tablist" aria-label="Community Hub">
                {TABS.map(([key, label]) => (
                    <button key={key} className={`tab${panel === key ? ' active' : ''}`} type="button" role="tab" aria-selected={panel === key}
                        onClick={() => api.showCommunityPanel(key)}>{label}</button>
                ))}
            </div>

            {panel === 'landing' && <Landing rows={cs.mons || []} loading={!!cs.loading} />}
            {panel === 'browse' && <Browse />}
            {panel === 'events' && <div className="community-panel"><EventsPanel /></div>}
            {panel === 'uploads' && <Uploads />}
        </>
    );
}

// ==================== landing ====================

// enough to fill one row on the widest screen; the row clips the rest
const LANDING_ROW_SIZE = 12;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function Landing({ rows, loading }: { rows: FeedRow[]; loading: boolean }) {
    if (loading && !rows.length) {
        return (
            <div className="community-landing">
                <section className="community-landing-section">
                    <div className="community-landing-row">
                        {Array.from({ length: LANDING_ROW_SIZE }, (_, i) => (
                            <div className="community-landing-card skel-card" key={i}><span className="community-landing-art skel" /><span className="skel skel-text" /></div>
                        ))}
                    </div>
                </section>
            </div>
        );
    }
    const creators = new Set(rows.map(r => r.user_id)).size;
    const likes = rows.reduce((sum, r) => sum + Number(r.like_count || 0), 0);
    const comments = rows.reduce((sum, r) => sum + Number(r.comment_count || 0), 0);
    const stats: Array<[string, number, string]> = [
        ['Fakémon published', rows.length, 'sparkles'], ['Creators', creators, 'users'], ['Likes given', likes, 'heart'], ['Comments', comments, 'message-circle']
    ];

    if (!rows.length) {
        return (
            <div className="community-landing">
                <div className="community-hero-stats">{stats.map(s => <HeroStat key={s[0]} stat={s} />)}</div>
                <section className="community-landing-section">
                    <div className="community-landing-empty">
                        <Icon name="sparkles" />
                        <p>Nothing has been published yet. Be the first: open a Fakémon in your collection and publish it.</p>
                    </div>
                </section>
            </div>
        );
    }

    const since = Date.now() - WEEK_MS;
    const recent = rows.filter(r => new Date(r.published_at).getTime() >= since);
    // featured draws from everything, so a quiet week still has a shelf
    const featured: FeedRow[] = api.featuredThisWeek(rows, LANDING_ROW_SIZE);
    // trending = engagement; comments weigh double (they cost more to leave)
    const trendingPool = recent.length >= LANDING_ROW_SIZE ? recent : rows;
    const score = (r: FeedRow) => Number(r.like_count || 0) + Number(r.comment_count || 0) * 2;
    const trending = [...trendingPool].sort((a, b) => score(b) - score(a)).slice(0, LANDING_ROW_SIZE);
    const fresh = [...rows].sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime()).slice(0, LANDING_ROW_SIZE);

    return (
        <div className="community-landing">
            <div className="community-hero-stats">{stats.map(s => <HeroStat key={s[0]} stat={s} />)}</div>
            <LiveContests />
            <Shelf title="Featured this week" subtitle="A rotating pick from the whole hub. Changes every Monday." rows={featured} />
            <Shelf title="Trending now" subtitle={recent.length >= LANDING_ROW_SIZE ? 'Most liked and talked about in the last seven days.' : 'Most liked and talked about so far.'} rows={trending} />
            <Shelf title="Freshly published" subtitle="The newest Fakemon in the hub." rows={fresh} />
        </div>
    );
}

function HeroStat({ stat: [label, value, icon] }: { stat: [string, number, string] }) {
    return <div className="community-hero-stat"><Icon name={icon} /><strong>{value}</strong><span>{label}</span></div>;
}

function Shelf({ title, subtitle, rows }: { title: string; subtitle: string; rows: FeedRow[] }) {
    if (!rows.length) return null;
    return (
        <section className="community-landing-section">
            <div className="community-landing-section-head">
                <div><h3>{title}</h3><p>{subtitle}</p></div>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.showCommunityPanel('browse')}>See all <Icon name="arrow-right" /></button>
            </div>
            <div className="community-landing-row">{rows.map(row => <LandingCard key={`${title}-${row.id}`} row={row} />)}</div>
        </section>
    );
}

// contests have a deadline, so they sit above the browsing shelves; drawn only while one is live
function LiveContests() {
    const live = getLiveContests();
    if (!live.length) return null;
    return (
        <section className="community-landing-section community-contest-section">
            <div className="community-landing-section-head">
                <div>
                    <h3><span className="event-live-dot" /> Happening now</h3>
                    <p>{live.length === 1 ? 'A contest is' : `${live.length} contests are`} open. Enter one of your Fakémon, or vote on everyone else's.</p>
                </div>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.showCommunityPanel('events')}>All events</button>
            </div>
            <div className="community-contest-row">
                {live.slice(0, 3).map(c => {
                    const n = (c.submissions || []).length;
                    return (
                        <button type="button" className="community-contest-card" key={c.id} onClick={() => api.showCommunityPanel('events')}>
                            <span className="community-contest-phase">{c.phase === 'voting' ? 'Voting open' : 'Accepting entries'}</span>
                            <strong>{c.title || 'Contest'}</strong>
                            <span className="community-contest-event">{c.eventTitle || ''}</span>
                            <span className="community-contest-count">{n} entr{n === 1 ? 'y' : 'ies'}</span>
                        </button>
                    );
                })}
            </div>
        </section>
    );
}

// ==================== browse ====================

function Browse() {
    const cs = api.communityState();
    const prefs = api.getCommunityPrefs();
    const list = api.communityLayoutMode() === 'list';
    return (
        <div className="community-panel">
            <div className="search-bar community-controls">
                <input type="search" id="community-search-input" placeholder="Search the Community Hub..." aria-label="Search the Community Hub"
                    value={cs.search || ''} onChange={e => api.filterCommunity(e.target.value)} />
                <select value={prefs.sortBy} onChange={e => api.changeCommunitySort(e.target.value, prefs.sortOrder)} aria-label="Sort the community hub by">
                    <option value="activity">Activity</option>
                    <option value="likes">Total likes</option>
                    <option value="comments">Total comments</option>
                    <option value="views">Total views</option>
                    <option value="published">Date published</option>
                    <option value="name">Name</option>
                    <option value="author">Creator</option>
                    <option value="number">Pokédex number</option>
                </select>
                <select value={prefs.sortOrder} onChange={e => api.changeCommunitySort(prefs.sortBy, e.target.value)} aria-label="Community sort direction">
                    <option value="desc">Descending</option>
                    <option value="asc">Ascending</option>
                </select>
                <button className="btn btn-secondary btn-icon" type="button" onClick={() => api.toggleCommunityLayout()}
                    title={list ? 'Switch to grid view' : 'Switch to list view'} aria-label="Toggle list or grid view" aria-pressed={list}>
                    <Icon name={list ? 'layout-grid' : 'list'} />
                </button>
            </div>
            <div id="community-grid" className={`collection-grid${list ? ' collection-list' : ''}`}>
                <CommunityFeed rows={cs.mons || []} loading={!!cs.loading} prefs={{ ...prefs, search: (cs.search || '').trim().toLowerCase() }}
                    viewerId={state.user?.id || null} viewerIsStaff={!!api.isStaff?.()} />
            </div>
        </div>
    );
}

// ==================== my uploads ====================

function Uploads() {
    if (!state.user) {
        return <div className="community-panel"><div className="community-uploads-list"><div className="community-empty">Sign in to manage your uploads.</div></div></div>;
    }
    const cs = api.communityState();
    const mine: FeedRow[] = (cs.mons || []).filter((row: FeedRow) => row.user_id === state.user!.id)
        .sort((a: FeedRow, b: FeedRow) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
    const { max, cooldownSeconds } = api.publishLimits();
    const cadence: string = api.describeCooldown(cooldownSeconds);
    const hintStart = cadence ? `You can publish ${cadence}` : 'You can publish any time';
    const used = mine.length;
    const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 100;
    const tone = used >= max ? ' is-full' : pct >= 80 ? ' is-high' : '';
    return (
        <div className="community-panel">
            <div className="cloud-meters community-uploads-meter">
                {max === Infinity ? (
                    <div className="cloud-meter is-unlimited">
                        <div className="cloud-meter-head"><span>Community uploads</span><span>{used} / unlimited</span></div>
                        <div className="cloud-meter-hint">{hintStart}, with no limit on how many listings you hold.</div>
                    </div>
                ) : (
                    <div className={`cloud-meter${tone}`}>
                        <div className="cloud-meter-head"><span>Community uploads</span><span>{used}/{max}</span></div>
                        <div className="cloud-meter-track"><div className="cloud-meter-fill" style={{ width: `${pct}%` }} /></div>
                        <div className="cloud-meter-hint">{hintStart}, and hold up to {max} listings at a time. Unpublishing one frees a slot.</div>
                    </div>
                )}
            </div>
            <div className="community-uploads-list">
                {!mine.length ? (
                    <div className="community-empty">You have not published anything yet. Use the publish button above to put a Fakemon on the hub.</div>
                ) : mine.map(row => {
                    const mon = row.fakemon_data || {};
                    return (
                        <div className="community-upload-row" key={row.id}>
                            <LazyArt row={row} className="community-upload-art" />
                            <div className="community-upload-info">
                                <strong>{mon.name || 'Unnamed'}</strong>
                                <span>Published {new Date(row.published_at).toLocaleDateString()}</span>
                                <span className="community-upload-stats">
                                    <span><Icon name="heart" size={12} /> {Number(row.like_count || 0)}</span>
                                    <span><Icon name="message-circle" size={12} /> {Number(row.comment_count || 0)}</span>
                                    <span><Icon name="eye" size={12} /> {Number(row.view_count || 0)}</span>
                                </span>
                            </div>
                            <div className="community-upload-actions">
                                <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openMonDetail(row.id)}>View</button>
                                <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.openCommunityUpdateModalFor(row.id)}>Update</button>
                                <button className="btn btn-danger btn-sm" type="button" onClick={() => api.unpublishMon(row.id)}>Unpublish</button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
