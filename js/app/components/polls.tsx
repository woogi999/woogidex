// A poll under a post or comment, and the box for writing one. Data and
// rules: js/features/polls.ts.

import { useState } from 'react';
import { state } from '../../core/app.ts';
import {
    MAX_OPTIONS, POLL_LENGTHS, deletePoll, myChoices, pollClosed, pollFor, votePoll,
    type Poll, type PollDraft, type PollParent
} from '../../features/polls.ts';
import { Icon } from './Icon.tsx';
import { EmojiInput, EmojiText } from './EmojiInput.tsx';
import { useStore } from '../store.ts';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function timeLeft(iso: string): string {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'Final results';
    const h = Math.round(ms / 3600_000);
    return h < 1 ? 'Closes within the hour' : h < 48 ? `${plural(h, 'hour')} left` : `${plural(Math.round(h / 24), 'day')} left`;
}

/** The poll on a post or comment, if it has one. */
export function PollView({ kind, parentId }: { kind: PollParent; parentId: string }) {
    useStore();
    const poll = pollFor(kind, parentId);
    if (!poll) return null;
    return <PollCard poll={poll} />;
}

function PollCard({ poll }: { poll: Poll }) {
    const picked = myChoices(poll);
    const closed = pollClosed(poll);
    const own = !!state.user && state.user.id === poll.user_id;
    const [peek, setPeek] = useState(false);
    const [draft, setDraft] = useState<number[]>([]);
    // results show once you've voted, when it's closed, to its author, or on request
    const results = closed || picked.length > 0 || own || peek || !state.user;
    const total = poll.multi ? Math.max(1, poll.voters) : Math.max(1, poll.counts.reduce((a, b) => a + b, 0));
    const top = Math.max(...poll.counts);
    const choose = (i: number) => {
        if (closed || !state.user) return;
        if (!poll.multi) { votePoll(poll, picked.includes(i) ? [] : [i]); return; }
        // several answers: once you've voted, each click changes it; before, you tick then vote
        if (picked.length) { votePoll(poll, picked.includes(i) ? picked.filter(x => x !== i) : [...picked, i]); return; }
        setDraft(d => d.includes(i) ? d.filter(x => x !== i) : [...d, i]);
    };
    return (
        <div className={`poll${results ? ' is-results' : ''}`} role="group" aria-label={poll.question || 'Poll'}>
            {poll.question && <p className="poll-question"><EmojiText text={poll.question} /></p>}
            {poll.multi && !results && <p className="poll-hint">Pick as many as you like.</p>}
            <ul className="poll-options">
                {poll.options.map((o, i) => {
                    const n = poll.counts[i] || 0;
                    const pct = Math.round((n / total) * 100);
                    const mineHere = picked.includes(i) || draft.includes(i);
                    return (
                        <li key={i}>
                            {results ? (
                                <button type="button" className={`poll-result${mineHere ? ' is-mine' : ''}${n === top && n > 0 ? ' is-top' : ''}`}
                                    disabled={closed || !state.user} onClick={() => choose(i)} aria-pressed={mineHere}
                                    title={closed ? undefined : mineHere ? 'Your vote. Click to take it back.' : 'Vote for this'}>
                                    <span className="poll-bar" style={{ transform: `scaleX(${pct / 100})` }} aria-hidden="true" />
                                    <span className="poll-label">{mineHere && <Icon name="check-circle" size={15} />}<EmojiText text={o} /></span>
                                    <span className="poll-pct">{pct}%</span>
                                </button>
                            ) : (
                                <button type="button" className={`poll-choice${mineHere ? ' is-picked' : ''}`} aria-pressed={mineHere} onClick={() => choose(i)}>
                                    <span className={`poll-mark${poll.multi ? ' is-box' : ''}`} aria-hidden="true">{mineHere && <Icon name="check" size={12} />}</span><EmojiText text={o} />
                                </button>
                            )}
                        </li>
                    );
                })}
            </ul>
            <div className="poll-meta">
                <span>{plural(poll.voters, 'vote')}</span>
                {poll.closes_at && <span>· {timeLeft(poll.closes_at)}</span>}
                {!results && <button type="button" className="link-btn" onClick={() => setPeek(true)}>See results</button>}
                {poll.multi && !closed && !picked.length && draft.length > 0 && <button type="button" className="btn btn-primary btn-sm" onClick={() => { votePoll(poll, draft); setDraft([]); }}>Vote</button>}
                {picked.length > 0 && !closed && <button type="button" className="link-btn" onClick={() => votePoll(poll, [])}>Take back my vote</button>}
                {own && <button type="button" className="link-btn poll-remove" onClick={() => deletePoll(poll)}>Remove poll</button>}
            </div>
        </div>
    );
}

/** Writing a poll: the question (optional), two to six options, how long it runs. */
export function PollEditor({ value, onChange, onRemove, compact = false }: { value: PollDraft; onChange: (d: PollDraft) => void; onRemove: () => void; compact?: boolean }) {
    const set = (patch: Partial<PollDraft>) => onChange({ ...value, ...patch });
    const setOption = (i: number, text: string) => set({ options: value.options.map((o, j) => j === i ? text : o) });
    return (
        <div className={`poll-editor${compact ? ' is-compact' : ''}`}>
            <div className="poll-editor-head">
                <span><Icon name="chart-bar" size={15} />Poll</span>
                <button type="button" className="link-btn" onClick={onRemove}>Remove poll</button>
            </div>
            {/* our emojis and Apple's, the :name autocomplete and the picker, as everywhere else */}
            <EmojiInput singleLine rows={1} mentions={false} maxLength={200} value={value.question} onChange={question => set({ question })} placeholder="Ask a question (optional)" ariaLabel="Poll question" className="poll-editor-input" />
            {value.options.map((o, i) => (
                <div className="poll-editor-option" key={i}>
                    <EmojiInput singleLine rows={1} mentions={false} maxLength={80} value={o} onChange={text => setOption(i, text)} placeholder={`Option ${i + 1}`} ariaLabel={`Option ${i + 1}`} className="poll-editor-input" />
                    {value.options.length > 2 && <button type="button" className="poll-editor-x" aria-label={`Remove option ${i + 1}`} onClick={() => set({ options: value.options.filter((_, j) => j !== i) })}><Icon name="x-mark" size={14} /></button>}
                </div>
            ))}
            <div className="poll-editor-foot">
                {value.options.length < MAX_OPTIONS && <button type="button" className="link-btn" onClick={() => set({ options: [...value.options, ''] })}><Icon name="plus" size={13} />Add option</button>}
                <label className="poll-editor-check"><input type="checkbox" checked={value.multi} onChange={e => set({ multi: e.target.checked })} />Allow several answers</label>
                <label className="poll-editor-len">Runs for
                    <select value={value.hours ?? ''} onChange={e => set({ hours: e.target.value ? Number(e.target.value) : null })}>
                        {POLL_LENGTHS.map(([h, label]) => <option key={label} value={h ?? ''}>{label}</option>)}
                    </select>
                </label>
            </div>
        </div>
    );
}
