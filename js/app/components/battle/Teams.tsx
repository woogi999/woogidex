// The Battle page's Teams pane: your teams, and Showdown's teambuilder layout
// for editing one (slots down the left, the selected Pokémon's sheet on the
// right). Data and actions are js/battle/ui/battle-ui.ts.

import { useEffect, useState, type ReactNode } from 'react';
import { api, state } from '../../../core/app.ts';
import { NATURE_DATA } from '../../../core/data.ts';
import { toId } from '../../../battle/engine/dex.ts';
import { checkTeamReady, TEAM_FORMAT_RULES } from '../../../battle/teams.ts';
import {
    BATTLE_STAT_KEYS, BATTLE_STAT_LABELS, allItemNames, battleCalcStat, battleUI, findTeam, memberToSmogonText,
    monFor, teams, teamToSmogonText
} from '../../../battle/ui/battle-ui.ts';
import { CommitInput } from '../CommitInput.tsx';
import { Icon } from '../Icon.tsx';

const NATURES = ['Serious', 'Adamant', 'Modest', 'Jolly', 'Timid', 'Bold', 'Calm', 'Careful', 'Impish', 'Relaxed', 'Brave', 'Quiet'];

function TypeBadges({ types }: { types: Array<string | undefined> }) {
    return <>{types.filter(Boolean).map(t => <span key={t} className={`type-badge type-${String(t).toLowerCase()}`}>{t}</span>)}</>;
}

export function TeamsPane() {
    const ui = battleUI();
    const editing = ui.editingTeamId ? findTeam(ui.editingTeamId) : null;
    if (editing) return <TeamEditor team={editing} />;
    const list = teams();
    if (!list.length) {
        return (
            <div className="battle-empty">
                <Icon name="users" />
                <h3>No teams yet</h3>
                <p>Build a team from your own Fakémon to start battling.</p>
                <button className="btn btn-primary" type="button" onClick={() => api.createBattleTeam()}><Icon name="plus" /> New Team</button>
            </div>
        );
    }
    return (
        <>
            <div className="battle-section-head">
                <h3>Your Teams</h3>
                <button className="btn btn-primary btn-sm" type="button" onClick={() => api.createBattleTeam()}><Icon name="plus" /> New Team</button>
            </div>
            <div className="battle-team-grid">
                {list.map((t: any) => {
                    const problems: string[] = checkTeamReady(t, state.fakemonDB);
                    return (
                        <div className="battle-team-card" key={t.id}>
                            <div className="battle-team-card-head">
                                <strong>{t.name}</strong>
                                <span className="battle-team-count">{t.members.length}/{TEAM_FORMAT_RULES.maxMembers}</span>
                            </div>
                            <div className="battle-team-mons">
                                {t.members.length ? t.members.map((m: any, i: number) => {
                                    const f = monFor(m);
                                    return <span className="battle-team-chip" title={f?.name || 'Missing'} key={i}>{f?.artwork ? <img src={f.artwork} alt="" /> : <Icon name="help-circle" />}</span>;
                                }) : <span className="battle-team-empty">Empty</span>}
                            </div>
                            {problems.length > 0 && <div className="battle-team-warn"><Icon name="alert-triangle" /> {problems[0]}</div>}
                            <div className="battle-team-actions">
                                <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.editBattleTeam(t.id)}><Icon name="pencil" /> Edit</button>
                                <button className="btn btn-secondary btn-sm" type="button" title="Duplicate" onClick={() => api.duplicateBattleTeam(t.id)}><Icon name="copy" /></button>
                                <button className="btn btn-danger btn-sm" type="button" title="Delete" onClick={() => api.deleteBattleTeam(t.id)}><Icon name="trash-2" /></button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </>
    );
}

export function TeamsSkeleton() {
    return (
        <div className="battle-team-grid">
            {[0, 1, 2].map(i => (
                <div className="battle-team-card skel-card" key={i}>
                    <div className="battle-team-card-head"><span className="skel skel-text" style={{ width: 90 }} /><span className="skel skel-text" style={{ width: 32 }} /></div>
                    <div className="battle-team-mons">{[0, 1, 2, 3].map(j => <span className="battle-team-chip skel" key={j} />)}</div>
                </div>
            ))}
        </div>
    );
}

function TeamEditor({ team }: { team: any }) {
    const ui = battleUI();
    const problems: string[] = checkTeamReady(team, state.fakemonDB);
    const count = team.members.length;
    const sel = ui.editingSlotIndex == null || ui.editingSlotIndex >= Math.max(count, 1) ? 0 : ui.editingSlotIndex;
    return (
        <>
            <div className="battle-section-head">
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.closeBattleTeamEditor()}><Icon name="arrow-left" /> Back</button>
                <TeamName team={team} />
            </div>
            {problems.length > 0 && (
                <div className="battle-team-warn block"><Icon name="alert-triangle" /><div>{problems.map((p, i) => <div key={i}>{p}</div>)}</div></div>
            )}
            <div className="ps-teambuilder">
                <aside className="ps-tb-sidebar">
                    {team.members.map((m: any, i: number) => {
                        const f = monFor(m);
                        return (
                            <button key={i} className={`ps-tb-slot ${i === sel ? 'is-selected' : ''}`} type="button" onClick={() => api.selectBattleSlot(i)}>
                                <span className="ps-tb-slot-num">{i + 1}</span>
                                {f?.artwork ? <img src={f.artwork} alt="" /> : <span className="ps-tb-noart"><Icon name="image" /></span>}
                                <span className="ps-tb-slot-name">{f?.name || 'Missing'}</span>
                            </button>
                        );
                    })}
                    {count < TEAM_FORMAT_RULES.maxMembers && (
                        <button className="ps-tb-addslot" type="button" onClick={() => api.openBattleMonPicker(team.id)}><Icon name="plus" /><span>Add</span></button>
                    )}
                    <div className="ps-tb-sidebar-tools">
                        <button className="btn btn-secondary btn-sm" type="button" title="Move up" onClick={() => api.moveBattleMember(team.id, sel, -1)} disabled={sel === 0}><Icon name="chevron-up" /></button>
                        <button className="btn btn-secondary btn-sm" type="button" title="Move down" onClick={() => api.moveBattleMember(team.id, sel, 1)} disabled={sel >= count - 1}><Icon name="chevron-down" /></button>
                        <button className="btn btn-danger btn-sm" type="button" title="Remove" onClick={() => api.removeBattleMemberAt(team.id, sel)} disabled={!count}><Icon name="trash-2" /></button>
                    </div>
                </aside>
                <section className="ps-tb-detail">
                    {count ? <MemberEditor key={`${team.id}-${sel}`} team={team} index={sel} /> : <div className="community-empty">Add a Fakémon to begin.</div>}
                </section>
            </div>
            <TextIO key={`team-${team.id}-${team.updatedAt || ''}`} className="ps-tb-io ps-tb-team-io" icon="clipboard-list" summary="Import / Export team" rows={16}
                note="Showdown format - one set per block, separated by a blank line. Importing replaces every slot on this team."
                placeholder="Paste a whole Showdown team here…" initial={teamToSmogonText(team)}
                actions={text => (
                    <>
                        <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.copyBattleTeam(team.id)}><Icon name="copy" /> Copy team</button>
                        <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.downloadBattleTeam(team.id)}><Icon name="download" /> Download .txt</button>
                        <button className="btn btn-primary btn-sm" type="button" onClick={() => api.importBattleTeam(team.id, text)}><Icon name="upload" /> Import team</button>
                    </>
                )} />
        </>
    );
}

function TeamName({ team }: { team: any }) {
    const [name, setName] = useState(team.name);
    useEffect(() => { setName(team.name); }, [team.id]);
    return <input className="battle-team-name" value={name} aria-label="Team name" onChange={e => { setName(e.target.value); api.renameBattleTeam(team.id, e.target.value); }} />;
}

/** A collapsible Showdown-text box: shows the export, imports what's pasted. */
function TextIO({ className, icon, summary, note, rows, placeholder, initial, actions }:
    { className: string; icon: string; summary: string; note?: string; rows: number; placeholder: string; initial: string; actions: (text: string) => ReactNode }) {
    const [text, setText] = useState(initial);
    return (
        <details className={className}>
            <summary><Icon name={icon} /> {summary}</summary>
            {note && <p className="battle-slot-note">{note}</p>}
            <textarea rows={rows} spellCheck={false} placeholder={placeholder} value={text} onChange={e => setText(e.target.value)} />
            <div className="ps-tb-io-actions">{actions(text)}</div>
        </details>
    );
}

function MemberEditor({ team, index }: { team: any; index: number }) {
    const m = team.members[index];
    const f = monFor(m);
    const id = team.id;
    if (!f) {
        return (
            <div className="battle-slot is-missing">
                <div className="battle-slot-head">
                    <strong>Missing Fakémon</strong>
                    <button className="btn btn-danger btn-sm" type="button" onClick={() => api.removeBattleMember(id, index)}><Icon name="trash-2" /></button>
                </div>
                <p className="battle-slot-note">This Fakémon was deleted from your collection.</p>
            </div>
        );
    }
    const learn: string[] = (f.learnset || []).map((x: any) => x?.name).filter(Boolean);
    const abilities: string[] = (f.abilities || []).map((a: any) => a.name).filter(Boolean);
    const currentAbility = abilities.find(a => toId(a) === toId(m.ability)) || '';
    return (
        <div className="battle-slot">
            <div className="battle-slot-head">
                <div className="battle-slot-mon">
                    {f.artwork ? <img src={f.artwork} alt="" /> : <div className="battle-slot-noart"><Icon name="image" /></div>}
                    <div>
                        <strong>{f.name}</strong>
                        <span className="battle-slot-types"><TypeBadges types={[f.type1, f.type2]} /></span>
                    </div>
                </div>
                <div className="battle-slot-tools">
                    <button className="btn btn-secondary btn-sm" type="button" title="Move up" onClick={() => api.moveBattleMember(id, index, -1)} disabled={index === 0}><Icon name="chevron-up" /></button>
                    <button className="btn btn-secondary btn-sm" type="button" title="Move down" onClick={() => api.moveBattleMember(id, index, 1)} disabled={index === team.members.length - 1}><Icon name="chevron-down" /></button>
                    <button className="btn btn-danger btn-sm" type="button" title="Remove" onClick={() => api.removeBattleMember(id, index)}><Icon name="trash-2" /></button>
                </div>
            </div>

            <div className="battle-slot-grid">
                <label>Level<CommitInput type="number" min={1} max={100} value={Number(m.level) || 100} onCommit={v => api.setBattleMember(id, index, 'level', v)} /></label>
                <label>Nature
                    <select value={m.nature || 'Serious'} onChange={e => api.setBattleMember(id, index, 'nature', e.target.value)}>
                        {[...new Set([...(NATURES.includes(m.nature) || !m.nature ? [] : [m.nature]), ...NATURES])].map(nt => <option key={nt} value={nt}>{nt}</option>)}
                    </select>
                </label>
                <label>Ability
                    <select value={currentAbility} onChange={e => api.setBattleMember(id, index, 'ability', e.target.value)}>
                        {abilities.length ? abilities.map(a => <option key={a} value={a}>{a}</option>) : <option value="">(none)</option>}
                    </select>
                </label>
                <label>Item
                    <CommitInput type="text" list={`battle-items-${id}-${index}`} placeholder="e.g. Leftovers" value={m.item || ''} onCommit={v => api.setBattleMember(id, index, 'item', v)} />
                    <datalist id={`battle-items-${id}-${index}`}>{allItemNames().map((n: string) => <option key={n} value={n} />)}</datalist>
                </label>
            </div>

            <div className="battle-slot-moves">
                <div className="battle-slot-label">Moves <span>{(m.moves || []).filter(Boolean).length}/4</span></div>
                {[0, 1, 2, 3].map(i => (
                    <div className="battle-move-row" key={i}>
                        <CommitInput className="battle-move-input" list={`battle-learnset-${id}-${index}`} placeholder={`Move ${i + 1}`} value={m.moves?.[i] || ''}
                            onCommit={v => api.setBattleMove(id, index, i, v)} />
                        <button className="btn btn-secondary btn-sm" type="button" title="Browse this learnset" onClick={() => api.openBattleMoveBrowser(id, index, i)}><Icon name="search" /></button>
                    </div>
                ))}
                <datalist id={`battle-learnset-${id}-${index}`}>
                    {learn.map(n => <option key={n} value={n} />)}
                    {(state.customMoves || []).map((cm: any) => <option key={`c-${cm.id}`} value={cm.name} />)}
                </datalist>
            </div>

            <StatEditor team={team} m={m} index={index} f={f} />
            <TextIO key={`set-${id}-${index}-${team.updatedAt || ''}`} className="ps-tb-io" icon="clipboard-type" summary="Import / Export set" rows={9}
                placeholder="Paste a Showdown/Smogon set here…" initial={memberToSmogonText(m, f)}
                actions={text => (
                    <>
                        <button className="btn btn-secondary btn-sm" type="button" onClick={() => api.copyBattleSet(id, index)}><Icon name="copy" /> Copy</button>
                        <button className="btn btn-primary btn-sm" type="button" onClick={() => api.importBattleSet(id, index, text)}><Icon name="download" /> Import from text</button>
                    </>
                )} />
        </div>
    );
}

// Nature +/- buttons, base stat, EV input + slider (508 cap), IV input, and the calculated stat
function StatEditor({ team, m, index, f }: { team: any; m: any; index: number; f: any }) {
    const id = team.id;
    const nature = m.nature || 'Serious';
    const nd = (NATURE_DATA as Record<string, { up: string; down: string }>)[nature];
    const totalEVs = BATTLE_STAT_KEYS.reduce((sum: number, k: string) => sum + (m.evs?.[k] || 0), 0);
    return (
        <div className="ps-tb-stats">
            <div className="ps-tb-stats-header"><span>Stat</span><span>Base</span><span>EVs</span><span></span><span>IVs</span><span>Calc</span></div>
            {BATTLE_STAT_KEYS.map((key: string) => {
                const label = (BATTLE_STAT_LABELS as Record<string, string>)[key];
                const base = Number(f.stats?.[key]) || 60;
                const ev = m.evs?.[key] || 0;
                const iv = m.ivs?.[key] === undefined ? 31 : Number(m.ivs[key]);
                const boosted = !!nd && nd.up === key && nd.up !== nd.down;
                const reduced = !!nd && nd.down === key && nd.up !== nd.down;
                return (
                    <div key={key} className={`ps-tb-stat-row ${boosted ? 'stat-boosted' : reduced ? 'stat-reduced' : ''}`}>
                        <div className="ps-tb-stat-name">
                            <span>{label}</span>
                            <span className="ps-tb-nature-btns">
                                <button className={`nature-btn nature-plus ${boosted ? 'active' : ''}`} type="button" title={`Boost ${label}`} onClick={() => api.setBattleNatureBoost(id, index, key, 'up')}>+</button>
                                <button className={`nature-btn nature-minus ${reduced ? 'active' : ''}`} type="button" title={`Reduce ${label}`} onClick={() => api.setBattleNatureBoost(id, index, key, 'down')}>−</button>
                            </span>
                        </div>
                        <div className="ps-tb-stat-base">{base}</div>
                        <CommitInput type="number" className="ps-tb-ev-input" min={0} max={252} step={4} value={ev} onCommit={v => api.setBattleStat(id, index, 'evs', key, v)} />
                        <div className="ps-tb-ev-track">
                            <div className="ps-tb-ev-fill" style={{ width: `${(ev / 252) * 100}%` }} />
                            <input type="range" min={0} max={252} step={4} value={ev} onChange={e => api.setBattleStat(id, index, 'evs', key, e.target.value)} />
                        </div>
                        <CommitInput type="number" className="ps-tb-iv-input" min={0} max={31} value={iv} onCommit={v => api.setBattleStat(id, index, 'ivs', key, v)} />
                        <div className="ps-tb-stat-calc">{battleCalcStat(base, ev, iv, nature, key, Number(m.level) || 100)}</div>
                    </div>
                );
            })}
            <div className={`ps-tb-ev-total ${totalEVs > 508 ? 'is-over' : ''}`}>
                {totalEVs} / 508 EVs{totalEVs > 508 ? ' - over the limit!' : ` (${508 - totalEVs} remaining)`}
            </div>
        </div>
    );
}
