// The Battle page (/battle): Teams (build), Find a Battle (lobby), and the
// battle itself. js/battle/ui/battle-ui.ts runs the engine, the networking
// and the 3D scene; this draws everything around them. The scene host
// (#battle-scene) and the log (#battle-log) are rendered empty and belong to
// the scene from then on, so a repaint can't interrupt an animation.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, state } from '../../core/app.ts';
import { SCENE_SPEEDS } from '../../battle/ui/scene.ts';
import { connectionBanner } from '../../battle/ui/controls-model.ts';
import {
    battleNeedsBanner, battleUI, formatTime, loadBattlePickerCommunity, partyRails, pickCommunityMon, pickBattleMon,
    pickVanillaMon, readyTeams, regionEditedMons, setBattleTeamChoice, syncBattleScene, vanillaArtSlug
} from '../../battle/ui/battle-ui.ts';
import { BattleControls } from '../components/battle/Controls.tsx';
import { TeamsPane, TeamsSkeleton } from '../components/battle/Teams.tsx';
import { Icon } from '../components/Icon.tsx';
import { Modal } from '../components/Modal.tsx';
import { ShieldedArt } from '../components/ShieldedArt.tsx';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { useStore } from '../store.ts';

type Pane = 'teams' | 'lobby' | 'battle';

export function BattlePage() {
    useStore();
    const ui = battleUI();
    // Bind the scene to its host whenever the host element or the battle is new.
    // Not on every draw: binding pumps the scene, which re-renders this page.
    const bound = useRef<{ scene: Element | null; log: Element | null; battle: any; lead: any }>({ scene: null, log: null, battle: null, lead: null });
    useLayoutEffect(() => {
        if (ui.skeleton) return;
        const scene = document.getElementById('battle-scene');
        const log = document.getElementById('battle-log');
        const last = bound.current;
        if (scene === last.scene && log === last.log && ui.battle === last.battle && ui.leadPick === last.lead) return;
        bound.current = { scene, log, battle: ui.battle, lead: ui.leadPick };
        if (scene) syncBattleScene();
    });
    const panes: Array<[Pane, string, string]> = [['teams', 'Teams', 'users'], ['lobby', 'Find a Battle', 'swords'], ['battle', 'Battle', 'gamepad-2']];
    return (
        <>
            <div className="page-header battle-page-header">
                <div className="page-heading">
                    <h1 className="page-title">Battle</h1>
                    <p className="page-subtitle">Build a team from your Fakémon and battle other trainers.</p>
                </div>
                <div className="page-actions"><span className="events-status battle-status">{ui.status}</span></div>
            </div>
            <div className="battle-body">
                <div className="battle-tabs">
                    {panes.map(([p, label, icon]) => (
                        <button key={p} className={`battle-tab ${ui.pane === p ? 'is-active' : ''}`} type="button"
                            disabled={ui.skeleton || (p === 'battle' && !ui.battle && !ui.leadPick)} onClick={() => api.setBattlePane(p)}>
                            <Icon name={icon} /> {label}
                        </button>
                    ))}
                </div>
                {ui.skeleton ? <TeamsSkeleton /> : ui.pane === 'teams' ? <TeamsPane /> : ui.pane === 'lobby' ? <Lobby /> : <BattlePane />}
            </div>
        </>
    );
}

// ==================== lobby ====================

function TeamSelect({ which }: { which: 'find' | 'bot' }) {
    const ui = battleUI();
    const ready = readyTeams();
    const chosen = which === 'find' ? ui.findTeamId : ui.botTeamId;
    const value = ready.some((t: any) => t.id === chosen) ? chosen : ready[0]?.id || '';
    return (
        <select value={value} onChange={e => setBattleTeamChoice(which, e.target.value)}>
            {ready.length ? ready.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>) : <option value="">(no battle-ready team)</option>}
        </select>
    );
}

function BotBox() {
    return (
        <div className="battle-bot-box">
            <h4><Icon name="bot" /> Practice vs Bot</h4>
            <label>Team <TeamSelect which="bot" /></label>
            <button className="btn btn-primary" type="button" onClick={() => api.startBotBattle()}><Icon name="play" /> Start Practice Battle</button>
        </div>
    );
}

function PlayerRow({ p }: { p: any }) {
    const ui = battleUI();
    const name = p.display_name || p.username || 'Trainer';
    const sent = ui.challenges.find((c: any) => c.to_id === p.user_id && c.status === 'pending' && c.from_id === state.user?.id);
    return (
        <div className="battle-player-row">
            <span className="battle-player-avatar">{p.avatar_url ? <img src={p.avatar_url} alt="" /> : name.charAt(0).toUpperCase()}</span>
            <span className="battle-player-name"><strong>{name}</strong><small>@{p.username || 'unknown'}</small></span>
            <span className={`battle-player-status battle-status-${p.status}`}>{p.status}</span>
            {sent
                ? <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.cancelBattleChallenge(sent.id)}>Cancel</button>
                : <button className="btn btn-primary btn-sm" type="button" onClick={() => api.challengePlayer(p.user_id, name)}><Icon name="swords" /> Challenge</button>}
        </div>
    );
}

function Lobby() {
    const ui = battleUI();
    if (!state.user) {
        return (
            <div className="battle-empty">
                <Icon name="log-in" /><h3>Sign in to battle</h3>
                <p>You need an account to find opponents. You can still practise against a bot.</p>
                <button className="btn btn-primary" type="button" onClick={() => api.openAuthModal('signin')}>Sign In</button>
                <BotBox />
            </div>
        );
    }
    // anyone who pressed Find Match is who you actually want to pick from
    const searching = ui.players.filter((p: any) => p.status === 'searching');
    const others = ui.players.filter((p: any) => p.status !== 'searching');
    const incoming = ui.challenges.filter((c: any) => c.status === 'pending' && c.to_id === state.user?.id);
    return (
        <div className="battle-lobby">
            <div className="battle-lobby-main">
                <div className={`battle-findmatch ${ui.searching ? 'is-searching' : ''}`}>
                    <div className="battle-findmatch-copy">
                        <h3>{ui.searching ? 'Looking for a match…' : 'Find a match'}</h3>
                        <p>{ui.searching
                            ? 'Other trainers can see you and challenge you. Pick anyone below to challenge them first.'
                            : 'Announce that you want to play. Everyone else searching shows up here.'}</p>
                    </div>
                    <label className="battle-findmatch-team">Team <TeamSelect which="find" /></label>
                    <button className={`btn ${ui.searching ? 'btn-danger' : 'btn-primary'}`} type="button" onClick={() => api.toggleFindMatch()}>
                        <Icon name={ui.searching ? 'x' : 'search'} /> {ui.searching ? 'Stop searching' : 'Find Match'}
                    </button>
                </div>
                <div className="battle-section-head">
                    <h3>Looking for a match</h3>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.refreshBattleLobby()}><Icon name="refresh-cw" /> Refresh</button>
                </div>
                <div>
                    {searching.length ? searching.map((p: any) => <PlayerRow key={p.user_id} p={p} />) : (
                        <div className="community-empty">{ui.searching
                            ? 'Nobody else is searching yet. You will show up for them as soon as they look.'
                            : 'Nobody is searching right now. Press Find Match so others can see you.'}</div>
                    )}
                </div>
                <div className="battle-section-head"><h3>Also online</h3></div>
                <div>
                    {others.length ? others.map((p: any) => <PlayerRow key={p.user_id} p={p} />) : <div className="community-empty">Nobody else is in the Battle tab right now.</div>}
                </div>
            </div>
            <aside className="battle-lobby-side">
                {incoming.length > 0 && (
                    <div className="battle-challenge-box">
                        <h4><Icon name="bell" /> Challenges</h4>
                        {incoming.map((c: any) => (
                            <div className="battle-challenge-row" key={c.id}>
                                <span><strong>{c.from_name || 'A trainer'}</strong><small>wants to battle</small></span>
                                <div>
                                    <button className="btn btn-primary btn-sm" type="button" onClick={() => api.acceptChallenge(c.id)}>Accept</button>
                                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.declineChallenge(c.id)}>Decline</button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                <BotBox />
            </aside>
        </div>
    );
}

// ==================== the battle ====================

interface RailData { title: string; subtitle: string; slots: Array<{ name: string; artwork: string; fainted: boolean; active: boolean; revealed: boolean }>; }

function PartyRail({ rail, side }: { rail: RailData; side: 'left' | 'right' }) {
    return (
        <aside className={`battle-party battle-party-${side}`}>
            <div className="battle-party-head"><strong>{rail.title}</strong>{rail.subtitle && <small>{rail.subtitle}</small>}</div>
            <div className="battle-party-slots">
                {rail.slots.map((slot, i) => (
                    <div key={i} className={`battle-party-slot${slot.active ? ' is-active' : ''}${slot.fainted ? ' is-fainted' : ''}${slot.revealed ? '' : ' is-hidden'}`}
                        title={slot.revealed ? slot.name || '' : 'Not yet revealed'}>
                        {slot.revealed && slot.artwork ? <img src={slot.artwork} alt={slot.name || ''} />
                            : slot.revealed && slot.name ? <span className="battle-party-monogram">{slot.name.slice(0, 2)}</span>
                                : <span className="battle-party-unknown"><Icon name="help-circle" /></span>}
                    </div>
                ))}
                {Array.from({ length: Math.max(0, 6 - rail.slots.length) }, (_, i) => <div key={`e${i}`} className="battle-party-slot is-empty" />)}
            </div>
        </aside>
    );
}

function ConnBanner() {
    const banner = connectionBanner(battleUI().meta);
    if (!banner) return null;
    return (
        <div className={`battle-conn-banner ${banner.tone === 'bad' ? 'is-bad' : ''}`}>
            <Icon name={banner.icon} /> <span>{banner.label}{banner.note && <small>{banner.note}</small>}</span>
            {banner.canRetry && <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.retryBattleConnection()}>Try Again</button>}
        </div>
    );
}

function ChatBar() {
    const [text, setText] = useState('');
    return (
        <form className="ps-chatbar" onSubmit={e => { e.preventDefault(); if (api.sendBattleChat(text)) setText(''); }}>
            <input type="text" placeholder="Chat…" maxLength={300} autoComplete="off" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.stopPropagation()} />
            <button className="btn btn-primary btn-sm" type="submit" aria-label="Send"><Icon name="send" /></button>
        </form>
    );
}

function BattlePane() {
    const ui = battleUI();
    const b = ui.battle;
    const rails = partyRails();
    if (!ui.leadPick && !b) {
        return (
            <div className="battle-empty">
                <Icon name="gamepad-2" /><h3>No battle in progress</h3>
                <p>Find an opponent in the lobby, or start a practice battle.</p>
                <button className="btn btn-primary" type="button" onClick={() => api.setBattlePane('lobby')}>Find a Battle</button>
            </div>
        );
    }
    // the lead screen uses the same four-column grid as the battle, so the field doesn't resize a moment later
    return (
        <>
            {!ui.leadPick && battleNeedsBanner() && <ConnBanner />}
            <div className="ps-wrap">
                {rails && <PartyRail rail={rails.left} side="left" />}
                <div className="ps-main">
                    <div className="ps-scene" id="battle-scene" />
                    {!ui.leadPick && (
                        <div className="ps-toolbar">
                            <label className="ps-speed">
                                <span>Speed</span>
                                <select value={ui.speed} onChange={e => api.setBattleSpeed(e.target.value)}>
                                    {SCENE_SPEEDS.map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}
                                </select>
                            </label>
                            <div className="ps-toolbar-right">
                                <button className="btn btn-secondary btn-sm ps-skip" type="button" onClick={() => api.skipBattleAnimation()} disabled={!ui.animating}>
                                    <Icon name="fast-forward" /> Skip
                                </button>
                                {!b.ended && <span className={`battle-timer ${ui.timeLeft <= 15 ? 'is-urgent' : ''}`}>{formatTime(ui.timeLeft)}</span>}
                            </div>
                        </div>
                    )}
                    <div className="battle-controls"><BattleControls ui={ui} /></div>
                </div>
                {rails && <PartyRail rail={rails.right} side="right" />}
                <aside className="ps-logwrap">
                    {ui.leadPick
                        ? <div className="ps-log ps-log-empty">The battle log will appear here.</div>
                        : <>
                            <div className="ps-log" id="battle-log" />
                            {ui.meta?.mode === 'pvp' && <ChatBar />}
                        </>}
                </aside>
            </div>
        </>
    );
}

// ==================== adding a Pokémon to a team ====================

type PickerTab = 'custom' | 'regions' | 'vanilla' | 'community';

function CardArt({ src }: { src?: string }) {
    return <div className="card-art">{src ? <img src={src} alt="" draggable={false} /> : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="" draggable={false} />}</div>;
}

function Types({ types }: { types: Array<string | undefined> }) {
    return <div className="card-types">{types.filter(Boolean).map(t => <span key={t} className={`type-badge type-${String(t).toLowerCase()}`}>{t}</span>)}</div>;
}

function OwnCard({ f }: { f: any }) {
    const regions: string[] = (api.entryRegionIds?.(f) || []).map((id: string) => (api.getRegions?.() || []).find((r: any) => String(r.id) === id)?.name).filter(Boolean);
    return (
        <div className="collection-card" onClick={() => pickBattleMon(f.id)} title={regions.join(', ') || undefined}>
            <div className="card-art">
                {f.artwork ? <img src={f.artwork} alt="" draggable={false} /> : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="" draggable={false} />}
                {f.vanillaId && regions.length > 0 && <span className="vanilla-card-tag">{regions[0]}</span>}
            </div>
            <div className="card-name">{f.name || 'Unnamed'}</div>
            <Types types={[f.type1, f.type2]} />
        </div>
    );
}

function CommunityCard({ row }: { row: any }) {
    const d = row.fakemon_data || {};
    const [art, setArt] = useState('');
    useEffect(() => {
        let live = true;
        Promise.resolve(api.requestCardArtwork?.(String(row.id))).then((a: string) => { if (live && a) setArt(a); }).catch(() => {});
        return () => { live = false; };
    }, [row.id]);
    return (
        <div className="collection-card" onClick={() => pickCommunityMon(row.id)}>
            <div className="card-art">{art ? <ShieldedArt src={art} alt={`${d.name || ''} artwork`} /> : <img className="no-art-placeholder" src="assets/no_art_placeholder.png" alt="" draggable={false} />}</div>
            <div className="card-name">{d.name || 'Unnamed'}</div>
            <Types types={[d.type1, d.type2]} />
        </div>
    );
}

function BattleMonPickerDialog({ close, initialTab = 'custom' }: DialogProps<{ initialTab?: PickerTab }>) {
    useStore();
    const [tab, setTab] = useState<PickerTab>(initialTab);
    const [query, setQuery] = useState('');
    const edited = regionEditedMons();
    useEffect(() => { if (tab === 'community') loadBattlePickerCommunity(); }, [tab]);
    const q = query.trim().toLowerCase();
    const match = (name: string) => !q || String(name || '').toLowerCase().includes(q);

    let body;
    if (tab === 'community') {
        const cs = state.community || {};
        const rows = (cs.mons || []).filter((r: any) => match(r.fakemon_data?.name));
        body = cs.loading && !(cs.mons || []).length ? <div className="community-empty">Loading the Community Hub…</div>
            : rows.length ? rows.map((row: any) => <CommunityCard key={row.id} row={row} />)
                : <div className="community-empty">Nothing has been published to the Community Hub yet.</div>;
    } else if (tab === 'regions') {
        const groups = (api.getRegions?.() || []).map((r: any) => ({ r, mons: edited.filter((f: any) => api.entryInRegion?.(f, r.id) && match(f.name)) })).filter((g: any) => g.mons.length);
        body = groups.length ? groups.map(({ r, mons }: any) => (
            <div key={r.id} style={{ display: 'contents' }}>
                <div className="battle-picker-group"><span className="region-dot" style={{ ['--region-color' as any]: r.color || '' }} />{r.name}</div>
                {mons.map((f: any) => <OwnCard key={f.id} f={f} />)}
            </div>
        )) : <div className="community-empty">None of your regions has edited a main-game Pokémon yet.</div>;
    } else if (tab === 'vanilla') {
        const dex = Object.values(state.sdPokedex || {}).filter((p: any) => match(p.name));
        body = dex.length ? dex.map((p: any) => (
            <div className="collection-card" key={p.id} onClick={() => pickVanillaMon(p.id)}>
                <div className="card-art">
                    <img src={`https://img.pokemondb.net/artwork/large/${vanillaArtSlug(p)}.jpg`} alt="" draggable={false} loading="lazy"
                        onError={e => { (e.currentTarget as HTMLImageElement).src = 'assets/no_art_placeholder.png'; }} />
                </div>
                <div className="card-name">{p.name}</div>
                <Types types={p.types || []} />
            </div>
        )) : <div className="community-empty">Showdown data is still loading…</div>;
    } else {
        const own = (state.fakemonDB || []).filter(f => !f.pendingVanilla && match(f.name));
        body = own.length ? own.map(f => <OwnCard key={f.id} f={f} />) : <div className="community-empty">No Fakémon in your collection yet.</div>;
    }

    const tabs: Array<[PickerTab, string]> = [['custom', 'My Fakémon'], ...(edited.length ? [['regions', 'My Regions'] as [PickerTab, string]] : []), ['vanilla', 'Vanilla Pokémon'], ['community', 'Community']];
    return (
        <Modal onClose={close} className="contest-mon-picker-modal-box" title="Add a Fakémon to your team">
            <div className="battle-picker-tabs">
                {tabs.map(([key, label]) => (
                    <button key={key} className={`battle-picker-tab ${tab === key ? 'is-active' : ''}`} type="button" onClick={() => setTab(key)}>{label}</button>
                ))}
            </div>
            <div className="search-bar">
                <input type="text" placeholder="Search by name..." value={query} onChange={e => setQuery(e.target.value)} autoFocus />
            </div>
            <div className="collection-grid contest-mon-picker-grid">{body}</div>
        </Modal>
    );
}

registerDialog('battle-mon-picker', BattleMonPickerDialog);
