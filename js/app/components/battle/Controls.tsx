// The strip under the battle field: lead picker, move grid, switch panel and
// the end-of-battle card. Which one shows is controlsView() in
// js/battle/ui/controls-model.ts, where the ordering rules are tested.

import { api } from '../../../core/app.ts';
import { canSelectMove, STRUGGLE, STRUGGLE_INDEX } from '../../../battle/engine/battle.ts';
import { controlsView, hpPercent, hpTone, switchOptions } from '../../../battle/ui/controls-model.ts';
import { leadOpponentMembers, memberFace, myLeadMembers } from '../../../battle/ui/battle-ui.ts';
import { Icon } from '../Icon.tsx';

function Waiting({ children }: { children: string }) {
    return <div className="ps-anim-wait"><Icon name="loader" /> <span>{children}</span></div>;
}

function Portrait({ artwork, name }: { artwork?: string; name?: string }) {
    return artwork ? <img src={artwork} alt={name || ''} /> : <div className="battle-noart small"><Icon name="image" /></div>;
}

function ActionRow({ waiting }: { waiting: boolean }) {
    return (
        <div className="battle-action-row">
            <button className="btn btn-secondary" type="button" disabled={waiting} onClick={() => api.toggleBattleSwitchPanel()}><Icon name="repeat-2" /> Switch</button>
            <button className="btn btn-danger" type="button" onClick={() => api.forfeitBattle()}><Icon name="flag" /> Forfeit</button>
            {waiting && <span className="battle-waiting"><Icon name="loader" /> Waiting for opponent…</span>}
        </div>
    );
}

function MovePanel({ me, waiting, mustStruggle }: { me: any; waiting: boolean; mustStruggle: boolean }) {
    if (!me) return null;
    if (mustStruggle) {
        return (
            <>
                <div className="battle-move-grid">
                    <button className="battle-move is-struggle" type="button" disabled={waiting} onClick={() => api.chooseBattleMove(STRUGGLE_INDEX)}>
                        <span className="battle-move-name">{STRUGGLE.name}</span>
                        <span className="battle-move-meta"><span>Out of PP - this is all that is left</span><span>{STRUGGLE.basePower} BP</span></span>
                    </button>
                </div>
                <ActionRow waiting={waiting} />
            </>
        );
    }
    return (
        <>
            <div className="battle-move-grid">
                {me.moves.map((slot: any, i: number) => {
                    const m = slot.move;
                    const type = String(m.type || 'normal').toLowerCase();
                    return (
                        <button key={i} className={`battle-move type-${type}`} type="button" disabled={!canSelectMove(me, i) || waiting} onClick={() => api.chooseBattleMove(i)}>
                            <span className="battle-move-name">{m.name}</span>
                            <span className="battle-move-meta">
                                <span className={`type-badge type-${type}`}>{m.type}</span>
                                <span>{m.category}</span>
                                <span>{m.basePower || '-'} BP</span>
                                <span className="battle-move-pp">{slot.pp}/{slot.maxpp}</span>
                            </span>
                        </button>
                    );
                })}
            </div>
            <ActionRow waiting={waiting} />
        </>
    );
}

function SwitchPanel({ side, forced }: { side: any; forced: boolean }) {
    const options = switchOptions(side);
    return (
        <div className="battle-switch-panel">
            <div className="battle-switch-head">{forced ? 'Choose your next Pokémon' : 'Switch to'}</div>
            <div className="battle-switch-grid">
                {options.length === 0 ? <div className="community-empty">No healthy Pokémon left.</div> : options.map(({ m, i }: { m: any; i: number }) => {
                    const pct = hpPercent(m);
                    return (
                        <button key={i} className="battle-switch-card" type="button" onClick={() => api.chooseBattleSwitch(i)}>
                            <Portrait artwork={m.species?.artwork} name={m.name} />
                            <strong>{m.name}</strong>
                            <div className="battle-hp-bar small"><div className={`battle-hp-fill ${hpTone(pct)}`} style={{ width: `${pct}%` }} /></div>
                            <small>{m.hp}/{m.maxhp}{m.status ? ` · ${String(m.status).toUpperCase()}` : ''}</small>
                        </button>
                    );
                })}
            </div>
            {/* no cancel on a forced switch: there's no other legal action */}
            {!forced && <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.toggleBattleSwitchPanel()}>Cancel</button>}
        </div>
    );
}

function EndState({ battle, mySide }: { battle: any; mySide: number }) {
    const iWon = battle.winner === mySide;
    return (
        <div className={`battle-end ${iWon ? 'is-win' : 'is-loss'}`}>
            <Icon name={iWon ? 'trophy' : 'flag'} />
            <h3>{iWon ? 'You win!' : 'You lost'}</h3>
            <p>{battle.endReason === 'forfeit' ? 'By forfeit.' : 'All opposing Pokémon fainted.'}</p>
            <div className="battle-end-actions">
                <button className="btn btn-primary" type="button" onClick={() => api.setBattlePane('lobby')}>Back to Lobby</button>
                <button className="btn btn-secondary" type="button" onClick={() => api.downloadBattleReplay()}><Icon name="download" /> Save Replay</button>
            </div>
        </div>
    );
}

function DesyncState({ reason }: { reason?: string }) {
    return (
        <div className="battle-end is-desync">
            <Icon name="alert-triangle" />
            <h3>{reason ? 'Battle could not start' : 'Battle out of sync'}</h3>
            <p>{reason || "Something didn't match between your game and your opponent's, so this match wasn't counted to keep things fair."}</p>
            <div className="battle-end-actions">
                <button className="btn btn-primary" type="button" onClick={() => api.setBattlePane('lobby')}>Back to Lobby</button>
            </div>
        </div>
    );
}

function LeadPane({ ui }: { ui: any }) {
    const pick = ui.leadPick;
    const mine = myLeadMembers(pick);
    const theirs = leadOpponentMembers(pick);
    const who = pick.kind === 'bot' ? 'The bot' : (ui.meta?.oppName || 'Your opponent');
    return (
        <div className="battle-lead-screen">
            <div className="battle-section-head">
                <h3><Icon name="swords" /> Choose your lead</h3>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.cancelLeadPick()}><Icon name="x" /> Cancel</button>
            </div>
            <p className="battle-lead-hint">Who starts at the front? Click a Pokémon, then start the battle. Your pick is highlighted on the left.</p>
            <div className="battle-lead-grid">
                {mine.map((m: any, i: number) => {
                    const face = memberFace(m);
                    const selected = pick.lead === i;
                    return (
                        <button key={i} className={`battle-lead-card ${selected ? 'is-selected' : ''}`} type="button" onClick={() => api.setBattleLead(i)}>
                            <Portrait artwork={face.artwork} name={face.name} />
                            <strong>{face.name}</strong>
                            {selected && <span className="battle-lead-badge">Lead</span>}
                        </button>
                    );
                })}
            </div>
            {theirs.length > 0 ? (
                <div className="battle-lead-opp">
                    <div className="battle-lead-opp-head">{who} brings {theirs.length} Pokémon</div>
                    <div className="battle-lead-opp-grid">
                        {theirs.map((m: any, i: number) => {
                            const face = memberFace(m);
                            return (
                                <div className="battle-lead-opp-card" key={i} title={face.name}>
                                    <Portrait artwork={face.artwork} name={face.name} />
                                    <strong>{face.name}</strong>
                                    <div className="battle-lead-opp-types">
                                        {[m.type1, m.type2].filter(Boolean).map((t: string) => <span key={t} className={`type-badge type-${String(t).toLowerCase()}`}>{t}</span>)}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : pick.kind !== 'bot' && (
                <div className="battle-lead-opp"><div className="battle-lead-opp-head">Their team could not be read from this battle.</div></div>
            )}
            <div className="battle-end-actions">
                <button className="btn btn-primary" type="button" onClick={() => api.confirmLeadAndStart()}><Icon name="play" /> Start Battle</button>
            </div>
        </div>
    );
}

export function BattleControls({ ui }: { ui: any }) {
    const { kind } = controlsView(ui);
    const b = ui.battle;
    const mySide = ui.meta?.mySide ?? 0;
    switch (kind) {
        case 'lead': return <LeadPane ui={ui} />;
        case 'desync': return <DesyncState reason={ui.meta?.desyncReason} />;
        case 'ended': return <EndState battle={b} mySide={mySide} />;
        case 'animating': return <Waiting>Playing turn…</Waiting>;
        case 'forced-switch': return <SwitchPanel side={b.sides[mySide]} forced />;
        case 'waiting-opponent-switch': return <Waiting>Waiting for your opponent to send out…</Waiting>;
        case 'switch': return <SwitchPanel side={b.sides[mySide]} forced={false} />;
        case 'moves':
            return <MovePanel me={b.active(mySide)} waiting={!!ui.pendingChoice && ui.meta?.mode === 'pvp'} mustStruggle={!!b.mustStruggle?.(mySide)} />;
        default: return null;
    }
}
