// The battle control strip: lead picker, move grid, switch panel, end-of-battle
// card. Mounted only into #battle-controls -- the 3D scene host sits outside
// it and must never be touched here, since re-rendering it would tear down and
// rebuild its canvas.
//
// Pane-selection state machine lives in js/battle/ui/controls-model.js and is
// tested there.

import { Icon } from './Icon.jsx';
import { controlsView, switchOptions, hpTone, hpPercent } from '../battle/ui/controls-model.js';

const call = (name, ...args) => window[name]?.(...args);

// ==================== shared pieces ====================

function Waiting({ children }) {
    return (
        <div className="ps-anim-wait">
            <Icon name="loader" /> <span>{children}</span>
        </div>
    );
}

function NoArt() {
    return <div className="battle-noart small"><Icon name="image" /></div>;
}

function Portrait({ artwork, name }) {
    return artwork ? <img src={artwork} alt={name || ''} /> : <NoArt />;
}

/** The two buttons under every move grid, plus the PvP waiting note. */
function ActionRow({ waiting }) {
    return (
        <div className="battle-action-row">
            <button className="btn btn-secondary" type="button" disabled={waiting} onClick={() => call('toggleBattleSwitchPanel')}>
                <Icon name="repeat-2" /> Switch
            </button>
            <button className="btn btn-danger" type="button" onClick={() => call('forfeitBattle')}>
                <Icon name="flag" /> Forfeit
            </button>
            {waiting && (
                <span className="battle-waiting"><Icon name="loader" /> Waiting for opponent…</span>
            )}
        </div>
    );
}

// ==================== choosing a move ====================

function MoveButton({ slot, index, disabled }) {
    const m = slot.move;
    const type = String(m.type || 'normal').toLowerCase();
    return (
        <button
            className={`battle-move type-${type}`}
            type="button"
            disabled={disabled}
            onClick={() => call('chooseBattleMove', index)}
        >
            <span className="battle-move-name">{m.name}</span>
            <span className="battle-move-meta">
                <span className={`type-badge type-${type}`}>{m.type}</span>
                <span>{m.category}</span>
                <span>{m.basePower || '-'} BP</span>
                <span className="battle-move-pp">{slot.pp}/{slot.maxpp}</span>
            </span>
        </button>
    );
}

function MovePanel({ me, waiting, mustStruggle, struggle, struggleIndex, canSelect }) {
    if (!me) return null;

    if (mustStruggle) {
        return (
            <>
                <div className="battle-move-grid">
                    <button
                        className="battle-move is-struggle"
                        type="button"
                        disabled={waiting}
                        onClick={() => call('chooseBattleMove', struggleIndex)}
                    >
                        <span className="battle-move-name">{struggle.name}</span>
                        <span className="battle-move-meta">
                            <span>Out of PP - this is all that is left</span>
                            <span>{struggle.basePower} BP</span>
                        </span>
                    </button>
                </div>
                <ActionRow waiting={waiting} />
            </>
        );
    }

    return (
        <>
            <div className="battle-move-grid">
                {me.moves.map((slot, i) => (
                    <MoveButton key={i} slot={slot} index={i} disabled={!canSelect(me, i) || waiting} />
                ))}
            </div>
            <ActionRow waiting={waiting} />
        </>
    );
}

// ==================== choosing a switch ====================

function SwitchPanel({ side, forced }) {
    const options = switchOptions(side);
    return (
        <div className="battle-switch-panel">
            <div className="battle-switch-head">{forced ? 'Choose your next Pokémon' : 'Switch to'}</div>
            <div className="battle-switch-grid">
                {options.length === 0
                    ? <div className="community-empty">No healthy Pokémon left.</div>
                    : options.map(({ m, i }) => {
                        const pct = hpPercent(m);
                        return (
                            <button key={i} className="battle-switch-card" type="button" onClick={() => call('chooseBattleSwitch', i)}>
                                <Portrait artwork={m.species?.artwork} name={m.name} />
                                <strong>{m.name}</strong>
                                <div className="battle-hp-bar small">
                                    <div className={`battle-hp-fill ${hpTone(pct)}`} style={{ width: `${pct}%` }} />
                                </div>
                                <small>{m.hp}/{m.maxhp}{m.status ? ` · ${String(m.status).toUpperCase()}` : ''}</small>
                            </button>
                        );
                    })}
            </div>
            {/* no cancel on a forced switch -- there's no other legal action */}
            {!forced && (
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => call('toggleBattleSwitchPanel')}>
                    Cancel
                </button>
            )}
        </div>
    );
}

// ==================== the battle is over ====================

function EndState({ battle, mySide }) {
    const iWon = battle.winner === mySide;
    return (
        <div className={`battle-end ${iWon ? 'is-win' : 'is-loss'}`}>
            <Icon name={iWon ? 'trophy' : 'flag'} />
            <h3>{iWon ? 'You win!' : 'You lost'}</h3>
            <p>{battle.endReason === 'forfeit' ? 'By forfeit.' : 'All opposing Pokémon fainted.'}</p>
            <div className="battle-end-actions">
                <button className="btn btn-primary" type="button" onClick={() => call('setBattlePane', 'lobby')}>
                    Back to Lobby
                </button>
                <button className="btn btn-secondary" type="button" onClick={() => call('downloadBattleReplay')}>
                    <Icon name="download" /> Save Replay
                </button>
            </div>
        </div>
    );
}

function DesyncState({ reason }) {
    return (
        <div className="battle-end is-desync">
            <Icon name="alert-triangle" />
            <h3>{reason ? 'Battle could not start' : 'Battle out of sync'}</h3>
            <p>
                {reason
                    || "Something didn't match between your game and your opponent's, so this match wasn't counted to keep things fair."}
            </p>
            <div className="battle-end-actions">
                <button className="btn btn-primary" type="button" onClick={() => call('setBattlePane', 'lobby')}>
                    Back to Lobby
                </button>
            </div>
        </div>
    );
}

// ==================== choosing a lead ====================

/**
 * What you're up against on the lead-picker screen. PvP opponent teams are
 * stored without artwork (would bloat the table), so this shows names/typing
 * only; a bot's team is local and comes with pictures.
 */
function LeadOpponent({ members = [], kind, oppName, faceOf }) {
    if (!members.length) {
        // a bot with no team is normal; an unreadable PvP row needs to say so
        if (kind === 'bot') return null;
        return (
            <div className="battle-lead-opp">
                <div className="battle-lead-opp-head">Their team could not be read from this battle.</div>
            </div>
        );
    }

    const who = kind === 'bot' ? 'The bot' : (oppName || 'Your opponent');

    return (
        <div className="battle-lead-opp">
            <div className="battle-lead-opp-head">{who} brings {members.length} Pokémon</div>
            <div className="battle-lead-opp-grid">
                {members.map((m, i) => {
                    const face = faceOf(m);
                    const types = [m.type1, m.type2].filter(Boolean);
                    return (
                        <div className="battle-lead-opp-card" key={i} title={face.name}>
                            <Portrait artwork={face.artwork} name={face.name} />
                            <strong>{face.name}</strong>
                            <div className="battle-lead-opp-types">
                                {types.map(t => (
                                    <span key={t} className={`type-badge type-${String(t).toLowerCase()}`}>{t}</span>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function LeadPane({ pick, myMembers = [], oppMembers = [], oppName, faceOf }) {
    return (
        <div className="battle-lead-screen">
            <div className="battle-section-head">
                <h3><Icon name="swords" /> Choose your lead</h3>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => call('cancelLeadPick')}>
                    <Icon name="x" /> Cancel
                </button>
            </div>
            <p className="battle-lead-hint">
                Who starts at the front? Click a Pokémon, then start the battle.
                Your pick is highlighted on the left.
            </p>
            <div className="battle-lead-grid">
                {myMembers.map((m, i) => {
                    const face = faceOf(m);
                    const selected = pick.lead === i;
                    return (
                        <button
                            key={i}
                            className={`battle-lead-card ${selected ? 'is-selected' : ''}`}
                            type="button"
                            onClick={() => call('setBattleLead', i)}
                        >
                            <Portrait artwork={face.artwork} name={face.name} />
                            <strong>{face.name}</strong>
                            {selected && <span className="battle-lead-badge">Lead</span>}
                        </button>
                    );
                })}
            </div>
            <LeadOpponent members={oppMembers} kind={pick.kind} oppName={oppName} faceOf={faceOf} />
            <div className="battle-end-actions">
                <button className="btn btn-primary" type="button" onClick={() => call('confirmLeadAndStart')}>
                    <Icon name="play" /> Start Battle
                </button>
            </div>
        </div>
    );
}

// ==================== the strip itself ====================

/**
 * @param {object} props
 * @param {object} props.ui the battle UI state, passed whole so the pane choice
 *   is made by controlsView() rather than by the caller
 * @param {object} props.lead {myMembers, oppMembers, oppName, faceOf} for the picker
 * @param {(me: object, index: number) => boolean} props.canSelect
 * @param {object} props.struggle the Struggle move definition, and its index
 */
export function BattleControls({ ui = {}, lead = {}, canSelect = () => true, struggle = null, struggleIndex = -1 }) {
    const { kind } = controlsView(ui);
    const b = ui.battle;
    const mySide = ui.meta?.mySide ?? 0;

    switch (kind) {
        case 'lead':
            return <LeadPane pick={ui.leadPick} faceOf={lead.faceOf || (m => m)} {...lead} />;
        case 'desync':
            return <DesyncState reason={ui.meta?.desyncReason} />;
        case 'ended':
            return <EndState battle={b} mySide={mySide} />;
        case 'animating':
            return <Waiting>Playing turn…</Waiting>;
        case 'forced-switch':
            return <SwitchPanel side={b.sides[mySide]} forced />;
        case 'waiting-opponent-switch':
            return <Waiting>Waiting for your opponent to send out…</Waiting>;
        case 'switch':
            return <SwitchPanel side={b.sides[mySide]} forced={false} />;
        case 'moves':
            return (
                <MovePanel
                    me={b.active(mySide)}
                    waiting={!!ui.pendingChoice && ui.meta?.mode === 'pvp'}
                    mustStruggle={!!b.mustStruggle?.(mySide)}
                    struggle={struggle}
                    struggleIndex={struggleIndex}
                    canSelect={canSelect}
                />
            );
        default:
            return null;
    }
}
