// The editor's Analysis tab: what to compare against, a status line while it
// works, and the estimated competitive profile (tier, strengths and
// weaknesses, stat and typing percentiles, CAP rating, matchups). The
// numbers come from js/features/analysis.ts.

import { api } from '../../../core/app.ts';
import { Icon } from '../Icon.tsx';

function Skeleton() {
    const detail = (i: number) => (
        <div key={i} className="analysis-card panel-lite">
            <div className="skel skel-text" style={{ width: '40%', height: 12, marginBottom: 14 }} />
            <div className="skel skel-text" style={{ width: 70, height: 38, marginBottom: 10 }} />
            <div className="skel skel-text" style={{ width: '90%' }} />
            <div className="skel skel-text" style={{ width: '60%' }} />
        </div>
    );
    const matchupCards = [0, 1, 2, 3].map(i => (
        <div key={i} className="analysis-matchup-card skel-card">
            <div className="analysis-matchup-icon skel" />
            <div className="analysis-matchup-info"><span className="skel skel-text" style={{ width: '80%' }} /><span className="skel skel-text" style={{ width: '60%', height: 9 }} /></div>
        </div>
    ));
    const strength = (widths: string[]) => (
        <div className="analysis-card panel-lite analysis-strength-card skel-card">
            <div className="skel skel-text" style={{ width: '45%', height: 15, marginBottom: 12 }} />
            {widths.map((w, i) => <div key={i} className="skel skel-text" style={{ width: w }} />)}
        </div>
    );
    return (
        <>
            <div className="analysis-profile panel-lite skel-card">
                <div className="analysis-profile-main">
                    <div className="skel skel-text" style={{ width: '60%', height: 11, marginBottom: 10 }} />
                    <div className="skel skel-text" style={{ width: '80%', height: 42, margin: '6px 0 8px' }} />
                    <div className="skel skel-text" style={{ width: '70%', height: 12 }} />
                </div>
                <div className="analysis-profile-summary">
                    <div className="analysis-discord-message">
                        <span className="analysis-discord-avatar skel skel-circle" />
                        <div className="analysis-discord-body">
                            <div className="skel skel-text" style={{ width: 80, marginBottom: 8 }} />
                            <div className="skel skel-text" style={{ width: '100%' }} />
                            <div className="skel skel-text" style={{ width: '85%' }} />
                        </div>
                    </div>
                </div>
                <div className="skel skel-text" style={{ width: '90%', height: 11 }} />
            </div>
            <div className="analysis-two-col analysis-strength-row">{strength(['95%', '88%', '70%'])}{strength(['92%', '80%', '65%'])}</div>
            <div className="analysis-detail-grid">{[0, 1, 2, 3].map(detail)}</div>
            <div className="analysis-card panel-lite analysis-matchups-card skel-card">
                <div className="analysis-matchups-header">
                    <div><div className="skel skel-text" style={{ width: 160, height: 15, marginBottom: 8 }} /><div className="skel skel-text" style={{ width: 220 }} /></div>
                    <div className="analysis-matchups-score"><span className="skel skel-text" style={{ width: 40, height: 9 }} /><b className="skel skel-text" style={{ width: 34, height: 16 }} /></div>
                </div>
                <div className="analysis-matchup-columns">
                    <div className="analysis-matchup-group favorable"><h4><span><Icon name="check" size={14} /></span> Looks good into</h4><div className="analysis-matchup-list">{matchupCards}</div></div>
                    <div className="analysis-matchup-group unfavorable"><h4><span><Icon name="x" size={14} /></span> Looks rough into</h4><div className="analysis-matchup-list">{matchupCards}</div></div>
                </div>
            </div>
        </>
    );
}

function Types({ types }: { types: string[] }) {
    if (!types.length) return <span>None</span>;
    return <>{types.map((t, i) => <span key={t}>{i ? ' ' : ''}<span className={`type-pill type-${t.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>{t}</span></span>)}</>;
}

function Matchups({ rows, empty }: { rows: any[]; empty: string }) {
    if (!rows.length) return <div className="analysis-muted">{empty}</div>;
    return (
        <>
            {rows.map(x => (
                <div key={x.name} className="analysis-matchup-card">
                    <div className="analysis-matchup-icon">
                        <img src={x.sprite.src} alt="" loading="lazy" onError={e => { const img = e.currentTarget; if (img.src !== x.sprite.fallback) img.src = x.sprite.fallback; }} />
                    </div>
                    <div className="analysis-matchup-info"><strong>{x.name}</strong><span>{x.scenario}</span></div>
                    <b className="analysis-matchup-score">{x.score}</b>
                </div>
            ))}
        </>
    );
}

function Results({ r }: { r: any }) {
    const combo = (items: Array<[string, string | number]>) => (
        <div className="analysis-stat-combo">{items.map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}</div>
    );
    return (
        <>
            <div className="analysis-profile panel-lite">
                <div className="analysis-profile-main">
                    <div className="analysis-kicker">Estimated competitive profile</div>
                    <div className="analysis-profile-tier">{r.tier}</div>
                    <div className="analysis-score">{r.score}/100 · {r.reliability}% confidence</div>
                </div>
                <div className="analysis-profile-summary">
                    <div className="analysis-discord-message">
                        <img className="analysis-discord-avatar" src="assets/inoue_profile.gif" alt="Inoue" />
                        <div className="analysis-discord-body"><div className="analysis-discord-name">Inoue</div><div className="analysis-discord-text">{r.summary}</div></div>
                    </div>
                </div>
                <div className="analysis-profile-note"><strong>Take it with a grain of salt.</strong> This is an estimate, not an official competitive ranking.</div>
            </div>

            <div className="analysis-two-col analysis-strength-row">
                <div className="analysis-card panel-lite analysis-strength-card">
                    <h3><span className="analysis-section-icon analysis-positive"><Icon name="arrow-up" size={14} /></span>Strengths</h3>
                    <ul>{(r.strengths.length ? r.strengths : ['No major strength crossed the current thresholds.']).map((x: string) => <li key={x}>{x}</li>)}</ul>
                </div>
                <div className="analysis-card panel-lite analysis-strength-card">
                    <h3><span className="analysis-section-icon analysis-negative"><Icon name="arrow-down" size={14} /></span>Weaknesses</h3>
                    <ul>{(r.weaknesses.length ? r.weaknesses : ['No major weakness crossed the current thresholds.']).map((x: string) => <li key={x}>{x}</li>)}</ul>
                </div>
            </div>

            <div className="analysis-detail-grid">
                <div className="analysis-card panel-lite">
                    <h3>Typing &amp; role</h3>
                    <div className="analysis-big">{r.typePct}</div>
                    <p><span className="analysis-type-list"><Types types={r.types} /></span> · {r.typing.weak} weaknesses · {r.typing.resist} resistances · {r.typing.immune} immunities</p>
                    <p>{r.tools.join(' · ')}</p>
                    <div className="analysis-role-score">Role value <b>{r.roleScore}/100</b></div>
                </div>
                <div className="analysis-card panel-lite">
                    <h3>Stat combination</h3>
                    <div className="analysis-big">{r.statCombination}/100</div>
                    <p>Overall quality of the stat spread relative to the selected pool.</p>
                    {combo([['Bulk', r.pcts.bulk], ['Offense', r.pcts.offense], ['Speed', r.pcts.speed], ['BST', r.pcts.bst]])}
                </div>
                <div className="analysis-card panel-lite">
                    <h3>Selected environment</h3>
                    <p><strong>{r.selectedFormat}</strong></p>
                    <p>{r.metagameCount} usage-weighted Pokémon represented</p>
                    {combo([['Stat profile', r.metagame.stat], ['Bulk', r.metagame.bulk], ['Offense', r.metagame.offense], ['Speed', r.metagame.speed], ['Matchups', r.metagame.matchups]])}
                </div>
                <div className="analysis-card panel-lite">
                    <h3>CAP stat rating</h3>
                    <div className="analysis-big">{r.cap.BSR}</div>
                    <p>{r.cap.category} · CAP's nonlinear stat rating. This is a stat-power measure, not an automatic tier.</p>
                    {combo([['PT', r.cap.PT], ['ST', r.cap.ST], ['PS', r.cap.PS], ['SS', r.cap.SS], ['ODB', r.cap.ODB], ['PSB', r.cap.PSB]])}
                    <p>Kit ceiling <b>{r.kitScore}/100</b> · Matchups <b>{r.matchupScore}/100</b></p>
                </div>
            </div>

            <div className="analysis-card panel-lite analysis-matchups-card">
                <div className="analysis-matchups-header">
                    <div>
                        <h3>Metagame matchups</h3>
                        <p>{r.usingComparableTier ? `Weighted matchups against ${r.tier} Pokémon. It's not a perfect tool. Use common sense.` : 'Using the selected environment because there were not enough same-tier Pokémon to make a useful sample.'}</p>
                    </div>
                    <div className="analysis-matchups-score"><span>Overall</span><b>{r.metagame.matchups}</b></div>
                </div>
                <div className="analysis-matchup-columns">
                    <div className="analysis-matchup-group favorable">
                        <h4><span><Icon name="check" size={14} /></span> Looks good into</h4>
                        <div className="analysis-matchup-list"><Matchups rows={r.good} empty="No clear favorable matchups." /></div>
                    </div>
                    <div className="analysis-matchup-group unfavorable">
                        <h4><span><Icon name="x" size={14} /></span> Looks rough into</h4>
                        <div className="analysis-matchup-list"><Matchups rows={r.bad} empty="No clear unfavorable matchups." /></div>
                    </div>
                </div>
            </div>
        </>
    );
}

export function AnalysisTab() {
    const cfg = api.getAnalysisCfg();
    const view = api.analysisView();
    const choices = api.analysisChoices(cfg.pool === 'pokemon');
    const set = (patch: object) => api.setAnalysisCfg(patch);
    return (
        <div className="analysis-shell">
            <div className="analysis-controls panel-lite">
                <div className="analysis-control">
                    <label>Compare Against</label>
                    <select value={cfg.pool} onChange={e => set({ pool: e.target.value })}>
                        <option value="generation">Generation</option>
                        <option value="pokemon">Single Pokémon</option>
                        <option value="collection">My Collection</option>
                        <option value="folder">Collection Folder</option>
                        {choices.regions.length > 0 && <option value="region">One of my regions</option>}
                    </select>
                </div>
                {cfg.pool === 'region' && (
                    <div className="analysis-control">
                        <label>Region</label>
                        <select value={cfg.region || choices.regions[0]?.id || ''} onChange={e => set({ region: e.target.value })}>
                            {choices.regions.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                    </div>
                )}
                {cfg.pool === 'generation' && (
                    <div className="analysis-control">
                        <label>Generation</label>
                        <select value={cfg.gen} onChange={e => set({ gen: Number(e.target.value) })}>
                            {[9, 8, 7, 6, 5, 4, 3, 2, 1].map(g => <option key={g} value={g}>Gen {g}</option>)}
                        </select>
                    </div>
                )}
                {cfg.pool === 'pokemon' && (
                    <div className="analysis-control">
                        <label>Pokémon</label>
                        <select value={cfg.comparePokemon || choices.pokemon[0]?.id || ''} onChange={e => set({ comparePokemon: e.target.value })}>
                            {choices.pokemon.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    </div>
                )}
                {cfg.pool === 'folder' && (
                    <div className="analysis-control">
                        <label>Folder</label>
                        <select value={cfg.folder || choices.folders[0]?.id || ''} onChange={e => set({ folder: e.target.value })}>
                            {choices.folders.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}
                        </select>
                    </div>
                )}
                {cfg.pool === 'generation' && (
                    <div className="analysis-check"><label><input type="checkbox" checked={cfg.natdex} onChange={e => set({ natdex: e.target.checked })} /> National Dex pool</label></div>
                )}
            </div>
            <div className="analysis-status">
                {view.status.kind === 'busy' && <span className="analysis-spinner" />}
                {view.status.kind === 'ok' && <span className="analysis-ok"><Icon name="check" size={14} /></span>}
                <span className={view.status.kind === 'error' ? 'analysis-error' : undefined}>{view.status.text}</span>
            </div>
            <div className="analysis-results">
                {view.error ? <div className="analysis-error panel-lite">{view.error}</div> : view.result ? <Results r={view.result} /> : <Skeleton />}
            </div>
        </div>
    );
}
