// Browse Moves and Browse Abilities. The move browser serves two callers:
// the editor (every move in the game; a click adds it to the learnset) and the
// battle teambuilder (one member's learnset; a click fills the slot that
// opened it). The filtering itself is js/editor/editor.ts.

import { useDeferredValue, useState } from 'react';
import { api } from '../../core/app.ts';
import { registerDialog, type DialogProps } from '../dialogs.tsx';
import { Modal } from '../components/Modal.tsx';
import { TypeDropdown, useClickAway } from '../components/editor/fields.tsx';
import { CategoryIcon } from '../components/editor/lists.tsx';
import { Icon } from '../components/Icon.tsx';

type Filters = { name: string; type: string; category: string; priority: string; bpMin: string; accMin: string; ppMin: string; flags: string[] };
const NO_FILTERS: Filters = { name: '', type: '', category: '', priority: '', bpMin: '', accMin: '', ppMin: '', flags: [] };
type BattleTarget = { teamId: string; index: number; slot: number };

const catClass = (c?: string) => (c === 'Physical' ? 'cat-physical' : c === 'Special' ? 'cat-special' : 'cat-status');

function AnyCategory({ value, onPick }: { value: string; onPick: (c: string) => void }) {
    const [open, setOpen] = useState(false);
    const ref = useClickAway(open, () => setOpen(false));
    const pick = (c: string) => { setOpen(false); onPick(c); };
    return (
        <div className={`cat-dropdown${open ? ' open' : ''}`} ref={ref} style={{ width: 150 }}>
            <button className="cat-dropdown-trigger" type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}>
                <span className="cat-dropdown-value">{value ? <span className={`cat-pill ${catClass(value)}`}>{value}</span> : 'Any Category'}</span>
                <span className="type-dropdown-arrow"><Icon name="chevron-down" size={12} /></span>
            </button>
            <div className="cat-dropdown-menu">
                <div className="cat-dropdown-option" onClick={() => pick('')}><span>Any Category</span></div>
                {['Physical', 'Special', 'Status'].map(c => <div key={c} className="cat-dropdown-option" onClick={() => pick(c)}><span className={`cat-pill ${catClass(c)}`}>{c}</span></div>)}
            </div>
        </div>
    );
}

function MoveCard({ m, locked, onPick, addedLabel }: { m: any; locked?: boolean; onPick?: () => void; addedLabel: string }) {
    const acc = m.accuracy === true || m.accuracy === undefined || m.accuracy === false ? '-' : `${m.accuracy}%`;
    const title = locked ? `${m.name} is not in this Pokémon's learnset` : m.added ? `Already ${addedLabel.toLowerCase()}` : 'Click to add';
    return (
        <div className={`move-browser-card${m.added ? ' added' : ''}${locked ? ' is-locked' : ''}`} title={title} onClick={locked ? undefined : onPick}>
            <div className="move-browser-card-top">
                <span className={`type-pill type-${String(m.type || 'normal').toLowerCase()}`}>{m.type || '?'}</span>
                <span className={`cat-pill ${catClass(m.category)}`}><CategoryIcon category={m.category || 'Status'} size={12} /> {m.category || 'Status'}</span>
                {m.added && <span className="move-browser-added-badge">{addedLabel}</span>}
                {locked && <span className="move-browser-locked-badge">Not learnable</span>}
            </div>
            <div className="move-browser-card-name">{m.name}</div>
            <div className="move-browser-card-stats">
                BP {m.basePower || '-'} · Acc {acc} · PP {m.pp || '-'}{m.priority ? ` · Prio ${m.priority > 0 ? '+' : ''}${m.priority}` : ''}
            </div>
        </div>
    );
}

function MoveBrowserDialog({ mode, target, close }: DialogProps<{ mode: 'editor' | 'battle'; target?: BattleTarget }>) {
    const [f, setF] = useState<Filters>(NO_FILTERS);
    // the whole move list redraws behind the typing, not in its way
    const deferred = useDeferredValue(f);
    const [, bump] = useState(0);
    const set = (patch: Partial<Filters>) => setF(prev => ({ ...prev, ...patch }));
    const battle = mode === 'battle';
    const { learnable, locked } = battle
        ? api.battleMoveChoices(target, deferred)
        : { learnable: api.moveBrowserResults(deferred), locked: [] };
    const count = battle
        ? `${learnable.length} move${learnable.length === 1 ? '' : 's'} in learnset${locked.length ? ` · ${locked.length} not learnable` : ''}`
        : `${learnable.length} move${learnable.length === 1 ? '' : 's'}`;
    const pick = (m: any) => {
        if (battle) { if (api.pickBattleMove(target, m.key)) close(); }
        else { api.addMoveFromBrowser(m.key); bump(x => x + 1); }
    };
    const all = [...learnable.map((m: any) => ({ m, locked: false })), ...locked.map((m: any) => ({ m, locked: true }))];
    const toggleFlag = (flag: string) => set({ flags: f.flags.includes(flag) ? f.flags.filter(x => x !== flag) : [...f.flags, flag] });
    const num = (key: 'bpMin' | 'accMin' | 'ppMin', label: string, max?: number) => (
        <label className="mb-range-label">{label} <input type="number" min={0} max={max} value={f[key]} onChange={e => set({ [key]: e.target.value })} /></label>
    );
    return (
        <Modal onClose={close} title="Browse Moves" className="move-browser-modal" labelledBy="move-browser-title">
            <div className="move-browser-filters">
                <input type="text" className="mb-filter-name" placeholder="Search by name..." autoFocus value={f.name} onChange={e => set({ name: e.target.value })} aria-label="Search by name" />
                <div style={{ width: 130 }}><TypeDropdown id="mb-filter-type" value={f.type} placeholder="Any Type" onPick={type => set({ type })} /></div>
                <AnyCategory value={f.category} onPick={category => set({ category })} />
                <select className="mb-filter-select" value={f.priority} onChange={e => set({ priority: e.target.value })} aria-label="Priority">
                    <option value="">Any Priority</option>
                    <option value="positive">Priority &gt; 0</option>
                    <option value="zero">Priority = 0</option>
                    <option value="negative">Priority &lt; 0</option>
                </select>
            </div>
            <div className="move-browser-filters">
                {num('bpMin', 'Min BP')}
                {num('accMin', 'Min Acc%', 100)}
                {num('ppMin', 'Min PP')}
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => set(NO_FILTERS)} title="Reset all filters">Clear Filters</button>
            </div>
            <div className="move-browser-flags">
                {(api.MOVE_BROWSER_FLAGS as string[]).map(flag => (
                    <span key={flag} className={`mb-flag-chip${f.flags.includes(flag) ? ' active' : ''}`} role="button" tabIndex={0} onClick={() => toggleFlag(flag)}>
                        {flag.charAt(0).toUpperCase() + flag.slice(1)}
                    </span>
                ))}
            </div>
            <div className="move-browser-count">{count}</div>
            <div className="move-browser-results">
                {all.length
                    ? all.map(({ m, locked: isLocked }) => <MoveCard key={`${isLocked ? 'l' : 'm'}:${m.key}`} m={m} locked={isLocked} onPick={() => pick(m)} addedLabel={battle ? 'Chosen' : 'Added'} />)
                    : <div className="move-browser-empty">No moves match those filters.</div>}
            </div>
        </Modal>
    );
}

function AbilityBrowserDialog({ close }: DialogProps) {
    const [query, setQuery] = useState('');
    const [group, setGroup] = useState('');
    const [sort, setSort] = useState('default');
    const [, bump] = useState(0);
    const res = api.abilityBrowserResults({ query, group, sort });
    return (
        <Modal onClose={close} title="Browse Abilities" className="ability-browser-modal" labelledBy="ability-browser-title">
            <div className="move-browser-filters">
                <input type="text" className="ab-filter-input" placeholder="Search names and effects..." autoFocus value={query} onChange={e => setQuery(e.target.value)} aria-label="Search" />
                <select className="ab-filter-select" value={group} onChange={e => setGroup(e.target.value)} aria-label="Group">
                    <option value="">All groups</option>
                    <option value="good">Good</option>
                    <option value="normal">Normal</option>
                    <option value="situational">Situational</option>
                    <option value="unviable">Unviable</option>
                </select>
                <select className="ab-filter-select" value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort">
                    <option value="default">Sort: Default</option>
                    <option value="az">Sort: A to Z</option>
                    <option value="za">Sort: Z to A</option>
                </select>
            </div>
            <div className="ab-count">{res.count} abilit{res.count === 1 ? 'y' : 'ies'}</div>
            <div className="ability-browser-results">
                {!res.count ? <div className="move-browser-empty">No abilities match those filters.</div> : res.groups.map((g: any) => (
                    <div key={g.id} style={{ display: 'contents' }}>
                        {g.label && <div className="ab-group-header">{g.label}<span>{g.rows.length}</span></div>}
                        {g.rows.map((a: any) => (
                            <button key={a.id} type="button" className={`ability-browser-row${a.added ? ' added' : ''}`}
                                title={a.added ? 'Already added' : res.full ? 'This Fakemon already has 4 abilities' : 'Click to add'}
                                onClick={() => { api.addAbilityFromBrowser(a.id); bump(x => x + 1); }}>
                                <span className="ab-row-head">
                                    <span className="ab-row-name">{a.name}</span>
                                    <span className={`ab-group-tag ab-group-${a.group.id}`}>{a.group.label.replace(' Abilities', '')}</span>
                                    {a.added && <span className="ab-row-added">Added</span>}
                                </span>
                                <span className="ab-row-desc">{a.desc}</span>
                            </button>
                        ))}
                    </div>
                ))}
            </div>
        </Modal>
    );
}

registerDialog('move-browser', MoveBrowserDialog);
registerDialog('ability-browser', AbilityBrowserDialog);
