import { state, api } from './app.js';

const EVENTS_STATE = { events: [], expanded: new Set(), loaded: false, voting: null, picker: null };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = v => v ? new Date(v).toLocaleString([], { dateStyle:'medium', timeStyle:'short' }) : '—';
const phaseLabel = p => ({draft:'Draft',submission:'Submission',voting:'Voting',results:'Results',closed:'Closed'}[p] || p || 'Draft');
const phaseClass = p => `contest-phase-${p || 'draft'}`;
const PHASE_STEPS = ['submission', 'voting', 'results'];

function relTime(v) {
    if (!v) return '';
    const diff = new Date(v).getTime() - Date.now();
    const abs = Math.abs(diff);
    const mins = Math.round(abs / 60000);
    const unit = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins/60)}h` : `${Math.round(mins/1440)}d`;
    return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

function findContest(contestId) {
    return EVENTS_STATE.events.flatMap(e => e.contests || []).find(c => c.id === contestId);
}

// the displayed phase must never be "ahead of" or "behind" contests.phase in
// the database - the RLS policies gating submissions/votes check that column
// directly, so if this ever disagreed with it, actions the UI offers would
// get rejected server-side (see the contest_submissions RLS violation this
// was written to fix). dates are only used to auto-advance FORWARD out of
// whichever phase is currently set, once that phase's own deadline passes -
// never to fall back to an earlier phase the admin has already moved past
// (e.g. forcing "voting" early, before submission_deadline arrives).
function effectivePhase(c) {
    if (c.phase === 'draft' || c.phase === 'closed' || c.phase === 'results') return c.phase;
    const now = Date.now();
    if (c.phase === 'voting') {
        if (c.voting_deadline && now >= new Date(c.voting_deadline).getTime()) return 'results';
        return 'voting';
    }
    // c.phase === 'submission' (the normal starting phase)
    if (c.voting_start && now >= new Date(c.voting_start).getTime()) {
        if (c.voting_deadline && now >= new Date(c.voting_deadline).getTime()) return 'results';
        return 'voting';
    }
    if (c.submission_deadline && now >= new Date(c.submission_deadline).getTime()) return 'voting';
    return 'submission';
}

async function openEvents() {
    const view = api.activateTopLevelView?.('events-view') || document.getElementById('events-view');
    api.setRoute?.('events', 'Events & Contests');
    closeContestVoting();
    await loadEventsView();
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function loadEventsView() {
    const list = document.getElementById('events-list');
    const status = document.getElementById('events-status');
    if (!list) return;
    list.innerHTML = '<div class="community-loading">Loading events…</div>';
    try {
        const client = await api.getClient();
        const { data: events, error } = await client.from('contest_events').select('*').order('starts_at', { ascending:false });
        if (error) throw error;
        const { data: contests, error: ce } = await client.from('contests').select('*').order('created_at', { ascending:false });
        if (ce) throw ce;
        const { data: subs, error: se } = await client.from('contest_submissions').select('id, contest_id, user_id, source_fakemon_id, fakemon_data, submitted_at');
        if (se) throw se;
        EVENTS_STATE.events = (events || []).map(e => ({...e, contests:(contests||[]).filter(c => c.event_id===e.id).map(c => ({...c, submissions:(subs||[]).filter(s=>s.contest_id===c.id)}))}));
        status.textContent = EVENTS_STATE.events.length ? '' : 'No contests are available yet.';
        renderEvents();
    } catch (e) {
        status.textContent = 'Could not load events.';
        list.innerHTML = `<div class="community-empty">${esc(e.message || e)}</div>`;
    }
}

function renderEvents() {
    const list = document.getElementById('events-list');
    if (!list) return;
    if (!EVENTS_STATE.events.length) { list.innerHTML='<div class="community-empty">No events have been created yet.</div>'; return; }
    list.innerHTML = EVENTS_STATE.events.map(e => `
      <section class="event-group">
        <div class="event-card-head"><div><h3>${esc(e.title)}</h3>${e.description ? `<div class="event-card-description">${esc(e.description)}</div>` : ''}<div class="event-date">${fmt(e.starts_at)} → ${fmt(e.ends_at)}</div></div></div>
        <div class="contest-list">${e.contests?.length ? e.contests.map(renderContest).join('') : '<div class="community-empty">No contests in this event yet.</div>'}</div>
      </section>`).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function phaseProgress(phase) {
    if (phase === 'draft' || phase === 'closed') return '';
    const idx = PHASE_STEPS.indexOf(phase);
    return `<div class="contest-progress">${PHASE_STEPS.map((step, i) => `<span class="contest-progress-step ${i < idx ? 'is-done' : ''} ${i === idx ? 'is-current' : ''}">${phaseLabel(step)}</span>`).join('<span class="contest-progress-sep"></span>')}</div>`;
}

// mirrors the window check submit_contest_ballot / cast_contest_vote / the
// contest_votes RLS policy all enforce server-side: phase='voting' alone
// isn't enough to actually cast a vote if voting_start hasn't arrived yet
// (or voting_deadline has already passed).
function votingWindowOpen(c) {
    const now = Date.now();
    if (c.voting_start && now < new Date(c.voting_start).getTime()) return false;
    if (c.voting_deadline && now > new Date(c.voting_deadline).getTime()) return false;
    return true;
}

function renderContest(c) {
    const phase = effectivePhase(c);
    const open = EVENTS_STATE.expanded.has(c.id);
    const maxSubs = c.max_submissions_per_user || 1;
    const mySubs = state.user ? (c.submissions || []).filter(s => s.user_id === state.user.id) : [];
    const canSubmit = !!state.user && phase === 'submission' && mySubs.length < maxSubs;
    const votingOpen = phase === 'voting' && votingWindowOpen(c);
    const canVote = !!state.user && votingOpen && c.submissions?.some(s => s.user_id !== state.user.id);
    return `<div class="contest-card">
      <div class="contest-card-top"><div><h4>${esc(c.title)}</h4><div class="contest-description">${esc(c.description || '')}</div></div><span class="contest-phase ${phaseClass(phase)}">${phaseLabel(phase)}</span></div>
      ${phaseProgress(phase)}
      <div class="contest-meta">
        <span><i data-lucide="images"></i> ${c.submissions?.length||0} submission${c.submissions?.length===1?'':'s'}</span>
        <span><i data-lucide="send"></i> Submit by ${fmt(c.submission_deadline)}${phase==='submission' && c.submission_deadline ? ` <em>(${relTime(c.submission_deadline)})</em>` : ''}</span>
        <span><i data-lucide="star"></i> Vote ${fmt(c.voting_start)} → ${fmt(c.voting_deadline)}${phase==='voting' && c.voting_start && !votingOpen && Date.now() < new Date(c.voting_start).getTime() ? ` <em>(opens ${relTime(c.voting_start)})</em>` : phase==='voting' && c.voting_deadline ? ` <em>(${relTime(c.voting_deadline)})</em>` : ''}</span>
      </div>
      <div class="contest-card-actions">
        ${canSubmit ? `<button class="btn btn-primary btn-sm" type="button" onclick="openContestMonPicker('${c.id}')"><i data-lucide="send"></i> ${mySubs.length ? 'Submit another' : 'Join &amp; Submit'}</button>` : ''}
        ${!state.user && phase === 'submission' ? `<button class="btn btn-primary btn-sm" type="button" onclick="openContestSignIn('${c.id}')"><i data-lucide="log-in"></i> Sign in to join</button>` : ''}
        ${mySubs.length ? `<span class="contest-phase"><i data-lucide="check"></i> ${mySubs.length}${maxSubs>1?`/${maxSubs}`:''} entered</span>` : ''}
        ${canVote ? `<button class="btn btn-primary btn-sm" type="button" onclick="startContestVoting('${c.id}')"><i data-lucide="star"></i> Vote in this contest</button>` : ''}
        ${!state.user && votingOpen && c.submissions?.length ? `<button class="btn btn-primary btn-sm" type="button" onclick="openContestSignIn('${c.id}')"><i data-lucide="log-in"></i> Sign in to vote</button>` : ''}
        ${phase === 'results' ? `<button class="btn btn-secondary btn-sm" type="button" onclick="toggleContestResults('${c.id}')"><i data-lucide="trophy"></i> Results</button>` : ''}
        <button class="btn btn-secondary btn-sm" type="button" onclick="toggleContestDetails('${c.id}')"><i data-lucide="${open ? 'chevron-up' : 'chevron-down'}"></i> ${open ? 'Hide details' : 'View details'}</button>
      </div>
      ${open ? contestPanel(c, phase) : ''}
    </div>`;
}

function rulesBlock(c) {
    if (!c.rules) return '';
    return `<div class="contest-rules"><h5><i data-lucide="scroll-text"></i> Rules</h5><p>${esc(c.rules)}</p></div>`;
}

function myEntriesBlock(c, mySubs) {
    if (!mySubs.length) return '';
    return `<div class="contest-my-entries"><h5>Your entries</h5>${mySubs.map(s => {
        const d = s.fakemon_data || {}; const img = getFakemonImage(d);
        return `<div class="contest-my-entry"><div class="contest-my-entry-thumb">${img ? `<img src="${esc(img)}" alt="">` : '<i data-lucide="image"></i>'}</div><span>${esc(d.name || 'Unnamed Fakemon')}</span><button class="btn btn-secondary btn-sm" type="button" onclick="withdrawContestEntry('${s.id}')"><i data-lucide="x"></i> Withdraw</button></div>`;
    }).join('')}</div>`;
}

function contestPanel(c, phase) {
    if (phase === 'submission') {
        const maxSubs = c.max_submissions_per_user || 1;
        const mySubs = state.user ? (c.submissions || []).filter(s => s.user_id === state.user.id) : [];
        const mine = myEntriesBlock(c, mySubs);
        if (mySubs.length >= maxSubs) return `<div class="contest-submit-panel">${rulesBlock(c)}${mine}<p class="contest-description">You've used all ${maxSubs} of your entries for this contest. Withdraw one above to submit something different.</p></div>`;
        return `<div class="contest-submit-panel">${rulesBlock(c)}${mine}${maxSubs>1?`<p class="contest-description">${mySubs.length}/${maxSubs} entries used.</p>`:''}<div class="contest-panel-actions"><button class="btn btn-primary btn-sm" type="button" onclick="openContestMonPicker('${c.id}')"><i data-lucide="images"></i> Choose a Fakemon to Submit</button></div></div>`;
    }
    if (phase === 'voting') {
        const open = votingWindowOpen(c);
        const status = open
            ? `${c.submissions?.length||0} Fakemon entered · voting closes ${fmt(c.voting_deadline)}. Vote on every eligible entry - your voting order is randomized for this session.`
            : (c.voting_start && Date.now() < new Date(c.voting_start).getTime()
                ? `Voting hasn't started yet - it opens ${fmt(c.voting_start)} (${relTime(c.voting_start)}).`
                : `Voting has closed.`);
        return `<div class="contest-submit-panel">${rulesBlock(c)}<h5>${open ? 'Voting is open' : 'Voting'}</h5><p class="contest-description">${status}</p></div>`;
    }
    if (phase === 'results') return rulesBlock(c) + renderResultsPanel(c);
    return rulesBlock(c);
}

function openContestMonPicker(contestId) {
    if (!state.user) return openContestSignIn(contestId);
    const c = findContest(contestId);
    if (!c) return;
    const maxSubs = c.max_submissions_per_user || 1;
    const mySubs = (c.submissions || []).filter(s => s.user_id === state.user.id);
    if (mySubs.length >= maxSubs) return api.showToast?.(`You've already used all ${maxSubs} of your entries for this contest.`, 'info');
    EVENTS_STATE.picker = { contestId, query: '' };
    const search = document.getElementById('contest-mon-picker-search');
    if (search) search.value = '';
    const title = document.getElementById('contest-mon-picker-title');
    if (title) title.textContent = `Choose a Fakemon — ${c.title}`;
    renderContestMonPickerGrid();
    document.getElementById('contest-mon-picker-modal')?.classList.add('active');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function contestMonPickerOptions() {
    const p = EVENTS_STATE.picker;
    if (!p) return [];
    const c = findContest(p.contestId);
    if (!c) return [];
    const mySubIds = new Set((c.submissions || []).filter(s => s.user_id === state.user?.id).map(s => s.source_fakemon_id));
    let options = (state.fakemonDB || []).filter(m => !mySubIds.has(String(m.id)));
    const q = (p.query || '').trim().toLowerCase();
    if (q) options = options.filter(m => (m.name || '').toLowerCase().includes(q) || (m.type1 || '').toLowerCase().includes(q) || (m.type2 || '').toLowerCase().includes(q));
    return options;
}

function renderContestMonPickerGrid() {
    const grid = document.getElementById('contest-mon-picker-grid');
    const empty = document.getElementById('contest-mon-picker-empty');
    if (!grid) return;
    const options = contestMonPickerOptions();
    if (!options.length) {
        grid.style.display = 'none';
        grid.innerHTML = '';
        if (empty) empty.style.display = 'block';
        return;
    }
    if (empty) empty.style.display = 'none';
    grid.style.display = 'grid';
    grid.innerHTML = options.map(m => {
        const type1Class = m.type1 ? `type-${m.type1.toLowerCase()}` : '';
        const type2Class = m.type2 ? `type-${m.type2.toLowerCase()}` : '';
        return `<div class="collection-card" onclick="chooseContestMon('${esc(m.id)}')">
          <div class="card-art">${m.artwork ? `<img src="${esc(m.artwork)}" alt="${esc(m.name)}" draggable="false">` : '<img class="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork" draggable="false">'}</div>
          <div class="card-number">${esc(m.number || '#???')}</div>
          <div class="card-name">${esc(m.name || 'Unnamed')}</div>
          <div class="card-types">${m.type1 ? `<span class="type-badge ${type1Class}">${esc(m.type1)}</span>` : ''}${m.type2 ? `<span class="type-badge ${type2Class}">${esc(m.type2)}</span>` : ''}</div>
        </div>`;
    }).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function filterContestMonPicker() {
    if (!EVENTS_STATE.picker) return;
    EVENTS_STATE.picker.query = document.getElementById('contest-mon-picker-search')?.value || '';
    renderContestMonPickerGrid();
}

function closeContestMonPicker() {
    document.getElementById('contest-mon-picker-modal')?.classList.remove('active');
    EVENTS_STATE.picker = null;
}

async function chooseContestMon(monId) {
    const p = EVENTS_STATE.picker;
    if (!p) return;
    const mon = (state.fakemonDB || []).find(m => String(m.id) === String(monId));
    if (!mon) return;
    const contestId = p.contestId;
    closeContestMonPicker();
    await submitContestEntry(contestId, mon);
}

function describeWinnerCriteria(wc) {
    wc = wc || {};
    const parts = [];
    if (wc.top_n) parts.push(`top ${wc.top_n}`);
    if (wc.top_percent) parts.push(`top ${wc.top_percent}%`);
    if (wc.min_score_percent) parts.push(`≥${wc.min_score_percent}% of possible points`);
    return parts.length ? parts.join(', or ') : 'top 3';
}

// a submission's points are every voter's (competitive + design) score added
// together; the max possible is every voter casting a perfect 10/10 on both
// (totalVoters * 20). basing the denominator on the CONTEST's total voter
// count (not just this submission's own vote_count) means an entry that only
// some voters got to rate scores lower than one rated by everyone, even at
// the same average.
function submissionPointsPercent(r, totalVoters) {
    const maxPossible = (totalVoters || 0) * 20;
    if (!maxPossible) return 0;
    const totalPoints = (Number(r.avg_competitive) + Number(r.avg_design)) * Number(r.vote_count);
    return totalPoints / maxPossible * 100;
}

function computeWinners(rows, wc, totalVoters) {
    wc = wc || {};
    const winners = new Set();
    if (wc.top_n) rows.slice(0, wc.top_n).forEach(r => winners.add(r.submission_id));
    if (wc.top_percent) {
        const count = Math.max(1, Math.ceil(rows.length * wc.top_percent / 100));
        rows.slice(0, count).forEach(r => winners.add(r.submission_id));
    }
    if (wc.min_score_percent) {
        rows.forEach(r => { if (submissionPointsPercent(r, totalVoters) >= wc.min_score_percent) winners.add(r.submission_id); });
    }
    if (!wc.top_n && !wc.top_percent && !wc.min_score_percent) rows.slice(0, 3).forEach(r => winners.add(r.submission_id));
    return winners;
}

function renderResultsPanel(c) {
    const header = `<h5><i data-lucide="trophy"></i> Final Results</h5>`;
    if (c.results === undefined) {
        loadContestResults(c);
        return `<div class="contest-submit-panel contest-results-panel">${header}<div class="community-loading">Loading results…</div></div>`;
    }
    if (c.results === 'loading') {
        return `<div class="contest-submit-panel contest-results-panel">${header}<div class="community-loading">Loading results…</div></div>`;
    }
    if (c.results === 'error') {
        return `<div class="contest-submit-panel contest-results-panel">${header}<div class="community-empty">Could not load results. <button class="btn btn-secondary btn-sm" type="button" onclick="retryContestResults('${c.id}')">Retry</button></div></div>`;
    }
    const rows = c.results;
    if (!rows.length) return `<div class="contest-submit-panel contest-results-panel">${header}<div class="community-empty">No votes were cast in this contest.</div></div>`;
    const totalVoters = c.totalVoters || 0;
    const maxPossible = totalVoters * 20;
    const winners = computeWinners(rows, c.winner_criteria, totalVoters);
    return `<div class="contest-submit-panel contest-results-panel">
      ${header}
      <p class="contest-results-criteria">Winners: ${esc(describeWinnerCriteria(c.winner_criteria))} · ${totalVoters} voter${totalVoters===1?'':'s'} total</p>
      <div class="contest-results-list">${rows.map((r, i) => {
        const sub = (c.submissions || []).find(s => s.id === r.submission_id);
        const d = sub?.fakemon_data || {};
        const img = getFakemonImage(d);
        const total = (Number(r.avg_competitive) + Number(r.avg_design)).toFixed(2);
        const points = Math.round((Number(r.avg_competitive) + Number(r.avg_design)) * Number(r.vote_count));
        const pct = Math.round(submissionPointsPercent(r, totalVoters));
        const won = winners.has(r.submission_id);
        return `<div class="contest-result-row ${won ? 'contest-result-winner' : ''}">
          <div class="contest-result-rank">${won ? `<i data-lucide="trophy"></i>` : `#${i+1}`}</div>
          <div class="contest-result-avatar">${img ? `<img src="${esc(img)}" alt="${esc(d.name||'Fakemon')}">` : '<i data-lucide="image"></i>'}</div>
          <div class="contest-result-info"><strong>${esc(d.name || 'Unnamed Fakemon')}${won ? ' <span class="contest-result-winner-chip">Winner</span>' : ''}</strong><span>${r.vote_count} vote${Number(r.vote_count)===1?'':'s'} · ${points}/${maxPossible} pts (${pct}%)</span></div>
          <div class="contest-result-scores"><span>Competitive <b>${r.avg_competitive}</b></span><span>Design <b>${r.avg_design}</b></span><span class="contest-result-total">Total <b>${total}</b></span></div>
        </div>`;
      }).join('')}</div>
    </div>`;
}

async function loadContestResults(c) {
    c.results = 'loading';
    try {
        const client = await api.getClient();
        const { data, error } = await client.rpc('get_contest_results', { p_contest_id: c.id });
        if (error) throw error;
        c.totalVoters = data?.[0] ? Number(data[0].total_voters) : 0;
        c.results = (data || []).slice().sort((a, b) => (Number(b.avg_competitive) + Number(b.avg_design)) - (Number(a.avg_competitive) + Number(a.avg_design)));
    } catch (e) {
        c.results = 'error';
    }
    renderEvents();
}

function retryContestResults(contestId) {
    const c = findContest(contestId);
    if (!c) return;
    c.results = undefined;
    renderEvents();
}

// `artwork` is a plain base64 data-URI string on a Fakemon record (see
// editor-core.js's FileReader assignment / community.js's usage) - not an
// object with .normal/.url. those never matched anything on real data, so
// every contest entry's art silently fell through to the placeholder icon.
function getFakemonImage(data){ return data?.artwork || data?.image || data?.sprite || ''; }
function shuffle(items){ const a=[...items]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

async function startContestVoting(contestId){
    if(!state.user) return openContestSignIn(contestId);
    const contest = findContest(contestId);
    if(!contest) return;
    if(!votingWindowOpen(contest)) return api.showToast?.(contest.voting_start && Date.now() < new Date(contest.voting_start).getTime() ? 'Voting hasn\'t opened yet.' : 'Voting has closed.', 'info');
    const eligible=(contest.submissions||[]).filter(s=>s.user_id!==state.user.id);
    if(!eligible.length) return api.showToast?.('There are no eligible entries to vote on.', 'info');
    try {
        const client=await api.getClient();
        const {data:session}=await client.from('contest_vote_sessions').select('id,submitted_at').eq('contest_id',contestId).eq('voter_id',state.user.id).maybeSingle();
        if(session?.submitted_at) return api.showToast?.('You have already submitted your votes for this contest.', 'info');
        const {data:existing,error}=await client.from('contest_votes').select('submission_id,competitive_score,design_score,remarks').eq('contest_id',contestId).eq('voter_id',state.user.id);
        if(error) throw error;
        const byId=Object.fromEntries((existing||[]).map(v=>[v.submission_id,v]));
        const stored=JSON.parse(sessionStorage.getItem(`contest-vote-order-${contestId}`)||'null');
        const ids=eligible.map(s=>s.id);
        const order=stored && stored.length===ids.length && stored.every(id=>ids.includes(id)) ? stored : shuffle(ids);
        sessionStorage.setItem(`contest-vote-order-${contestId}`,JSON.stringify(order));
        EVENTS_STATE.voting={contestId,order,index:0,scores:Object.fromEntries((existing||[]).flatMap(v=>[[`${v.submission_id}:competitive`,v.competitive_score],[`${v.submission_id}:design`,v.design_score]])),remarks:Object.fromEntries((existing||[]).map(v=>[v.submission_id,v.remarks||''])),byId};
        document.getElementById('events-list').style.display='none';
        const vv=document.getElementById('contest-voting-view'); if(vv) vv.style.display='block';
        renderVotingView();
    } catch(e){ api.showToast?.(e.message||String(e),'error'); }
}

function renderVotingView(){
    const v=EVENTS_STATE.voting; if(!v)return;
    const contest=findContest(v.contestId); if(!contest)return;
    const eligible=(contest.submissions||[]).filter(s=>s.user_id!==state.user.id); const current=eligible.find(s=>s.id===v.order[v.index]);
    const completed=id=>!!v.scores[`${id}:competitive`] && !!v.scores[`${id}:design`];
    const doneCount=v.order.filter(completed).length;
    const allDone=doneCount===v.order.length;
    const queue=v.order.map((id,i)=>{const s=eligible.find(x=>x.id===id);return `<button type="button" class="contest-vote-queue-item ${completed(id)?'is-done':''} ${i===v.index?'is-current':''}" onclick="jumpContestVote(${i})"><span>${i+1}</span><strong>${esc(s?.fakemon_data?.name||'Unnamed')}</strong>${completed(id)?'<i data-lucide="check"></i>':''}</button>`}).join('');
    const d=current?.fakemon_data||{}; const img=getFakemonImage(d);
    const comp=v.scores[`${current?.id}:competitive`]||0, design=v.scores[`${current?.id}:design`]||0;
    const starSet=(kind,val)=>Array.from({length:10},(_,i)=>`<button type="button" class="contest-star ${i<val?'active':''}" onclick="setContestVoteScore('${kind}',${i+1})" aria-label="${i+1} out of 10"><i data-lucide="star"></i></button>`).join('');
    const remarks=esc(v.remarks[current?.id]||'');
    const card=current?`<div class="contest-vote-current-card"><div class="contest-vote-mon-preview">${img?`<img src="${esc(img)}" alt="${esc(d.name||'Fakemon')}">`:'<div class="contest-vote-mon-placeholder"><i data-lucide="image"></i></div>'}<div><div class="events-kicker">ENTRY ${v.index+1} OF ${v.order.length}</div><h3>${esc(d.name||'Unnamed Fakemon')}</h3><p>${esc(d.description||'')}</p></div></div><div class="contest-rating-grid"><div class="contest-rating-box"><div class="contest-rating-label">Competitive Score</div><div class="contest-stars">${starSet('competitive',comp)}</div><strong>${comp || '—'} / 10</strong></div><div class="contest-rating-box"><div class="contest-rating-label">Design Score</div><div class="contest-stars">${starSet('design',design)}</div><strong>${design || '—'} / 10</strong></div></div><textarea class="contest-remarks" oninput="setContestVoteRemarks(this.value)" placeholder="Remarks (optional)">${remarks}</textarea><div class="contest-vote-navigation"><button class="btn btn-secondary btn-sm" onclick="jumpContestVote(${Math.max(0,v.index-1)})" ${v.index===0?'disabled':''}>Previous</button><button class="btn btn-primary" onclick="saveAndNextContestVote()">${v.index===v.order.length-1?'Finish this entry':'Save & Next'}</button></div></div>`:'<div class="community-empty">No entry selected.</div>';
    const root=document.getElementById('contest-voting-view');
    root.innerHTML=`<div class="events-hero"><div><div class="events-kicker">VOTING</div><h2>${esc(contest.title)}</h2><p>${doneCount} of ${v.order.length} entries completed. Finish every entry, then submit your ballot.</p></div><button class="btn btn-secondary btn-sm" onclick="closeContestVoting()">Back to events</button></div><div class="contest-voting-layout"><aside class="contest-vote-queue panel"><h4>Entries</h4>${queue}</aside><main>${card}<div class="contest-final-submit panel"><div><strong>${allDone?'All entries rated!':'Keep going'}</strong><p>${allDone?'Your ratings are ready to be submitted to the contest.':'Each entry needs both scores before you can submit.'}</p></div><button class="btn btn-primary" onclick="submitContestBallot()" ${allDone?'':'disabled'}><i data-lucide="send"></i> Submit all votes</button></div></main></div>`;
    if(typeof lucide!=='undefined')lucide.createIcons();
}
function setContestVoteScore(kind,val){const v=EVENTS_STATE.voting;if(!v)return;const id=v.order[v.index];v.scores[`${id}:${kind}`]=val;renderVotingView();}
function setContestVoteRemarks(value){const v=EVENTS_STATE.voting;if(v)v.remarks[v.order[v.index]]=value;}
function jumpContestVote(index){const v=EVENTS_STATE.voting;if(!v)return;v.index=Math.max(0,Math.min(index,v.order.length-1));renderVotingView();}
function saveAndNextContestVote(){const v=EVENTS_STATE.voting;if(!v)return;const id=v.order[v.index];if(!v.scores[`${id}:competitive`]||!v.scores[`${id}:design`])return api.showToast?.('Give both scores from 1 to 10 before continuing.','warning');if(v.index<v.order.length-1){v.index++;renderVotingView();}else{renderVotingView();api.showToast?.('This entry is complete. Submit your ballot when all entries are green.','success');}}

async function submitContestBallot(){
    const v=EVENTS_STATE.voting;if(!v||!state.user)return;
    const contest=findContest(v.contestId);const eligible=(contest?.submissions||[]).filter(s=>s.user_id!==state.user.id);
    const votes=eligible.map(s=>({submission_id:s.id,competitive_score:v.scores[`${s.id}:competitive`],design_score:v.scores[`${s.id}:design`],remarks:v.remarks[s.id]||''}));
    if(votes.some(x=>!x.competitive_score||!x.design_score))return api.showToast?.('Complete every entry before submitting.','warning');
    try{const client=await api.getClient();const {error}=await client.rpc('submit_contest_ballot',{p_contest_id:v.contestId,p_votes:votes});if(error)throw error;api.showToast?.('Your completed ballot has been submitted.','success');closeContestVoting();await loadEventsView();}catch(e){api.showToast?.(e.message||String(e),'error');}
}
function closeContestVoting(){EVENTS_STATE.voting=null;const vv=document.getElementById('contest-voting-view');if(vv)vv.style.display='none';const list=document.getElementById('events-list');if(list)list.style.display='block';}

async function submitContestEntry(contestId,mon){if(!state.user)return api.showToast?.('Sign in first.','warning');if(!mon)return api.showToast?.('Choose a Fakemon first.','warning');const client=await api.getClient();const {error}=await client.from('contest_submissions').insert({contest_id:contestId,user_id:state.user.id,source_fakemon_id:String(mon.id),fakemon_data:mon});if(error)return api.showToast?.(error.message,'error');api.showToast?.('Contest entry submitted!','success');await loadEventsView();}
async function withdrawContestEntry(submissionId){
    if(!confirm('Withdraw this entry from the contest? You can submit a different Fakemon in its place while submissions are still open.')) return;
    try{
        const client=await api.getClient();
        const {error}=await client.from('contest_submissions').delete().eq('id',submissionId);
        if(error) throw error;
        api.showToast?.('Entry withdrawn.','success');
        await loadEventsView();
    }catch(e){ api.showToast?.(e.message||String(e),'error'); }
}
function openContestSignIn(){api.showToast?.('Sign in to join this contest.','info');if(typeof window.openAuthModal==='function')window.openAuthModal('signin');}
function toggleContestDetails(id){EVENTS_STATE.expanded.has(id)?EVENTS_STATE.expanded.delete(id):EVENTS_STATE.expanded.add(id);renderEvents();}
function toggleContestResults(id){EVENTS_STATE.expanded.add(id);renderEvents();}

window.openEvents=openEvents;window.loadEventsView=loadEventsView;window.toggleContestDetails=toggleContestDetails;window.toggleContestResults=toggleContestResults;window.retryContestResults=retryContestResults;window.submitContestEntry=submitContestEntry;window.withdrawContestEntry=withdrawContestEntry;window.openContestMonPicker=openContestMonPicker;window.filterContestMonPicker=filterContestMonPicker;window.chooseContestMon=chooseContestMon;window.openContestSignIn=openContestSignIn;window.startContestVoting=startContestVoting;window.jumpContestVote=jumpContestVote;window.setContestVoteScore=setContestVoteScore;window.setContestVoteRemarks=setContestVoteRemarks;window.saveAndNextContestVote=saveAndNextContestVote;window.submitContestBallot=submitContestBallot;window.closeContestVoting=closeContestVoting;

// also export through the module system, not just window.* above - every
// other feature module gets merged into the shared `api` object (see
// Object.assign(api, ..., events, ...) in app.js), and app.js's own hash
// router calls api.openEvents?.() for the #events route. without these
// exports that call was always a silent no-op since api.openEvents didn't
// exist.
export {
    openEvents, loadEventsView, toggleContestDetails, toggleContestResults, retryContestResults,
    submitContestEntry, withdrawContestEntry, openContestMonPicker, filterContestMonPicker, chooseContestMon,
    openContestSignIn, startContestVoting, jumpContestVote, setContestVoteScore,
    setContestVoteRemarks, saveAndNextContestVote, submitContestBallot, closeContestVoting,
};
