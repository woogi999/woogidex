import { state, api, FEATURE_EVENTS_ENABLED } from './app.js';

const EVENTS_STATE = { events: [], expanded: new Set(), loaded: false, voting: null };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = v => v ? new Date(v).toLocaleString([], { dateStyle:'medium', timeStyle:'short' }) : '—';
const phaseLabel = p => ({draft:'Draft',submission:'Submission',voting:'Voting',results:'Results',closed:'Closed'}[p] || p || 'Draft');
const phaseClass = p => `contest-phase-${p || 'draft'}`;

function effectivePhase(c) {
    if (c.phase === 'draft' || c.phase === 'closed') return c.phase;
    const now = Date.now();
    if (c.voting_start && now >= new Date(c.voting_start).getTime()) {
        if (c.voting_deadline && now >= new Date(c.voting_deadline).getTime()) return 'results';
        return 'voting';
    }
    if (c.submission_deadline && now >= new Date(c.submission_deadline).getTime()) return 'voting';
    return 'submission';
}

// TODO: remove this early-return guard (and feature_events_enabled in
// app.js) once the events/contests feature is finished and ready to ship.
async function openEvents() {
    if (!FEATURE_EVENTS_ENABLED) {
        api.showToast('ts still under construction gng mb', 'info');
        return;
    }
    document.querySelectorAll('#main-content > div').forEach(el => { if (el.id !== 'events-view') el.style.display='none'; });
    const view = document.getElementById('events-view');
    if (view) view.style.display = 'block';
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
        const { data: subs, error: se } = await client.from('contest_submissions').select('id, contest_id, user_id, fakemon_data, submitted_at');
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
      <section class="panel event-card">
        <div class="event-card-head"><div><div class="events-kicker">EVENT</div><h3>${esc(e.title)}</h3><div class="event-card-description">${esc(e.description || '')}</div><div class="event-date">${fmt(e.starts_at)} → ${fmt(e.ends_at)}</div></div></div>
        <div class="contest-list">${e.contests?.length ? e.contests.map(renderContest).join('') : '<div class="community-empty">No contests in this event yet.</div>'}</div>
      </section>`).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderContest(c) {
    const phase = effectivePhase(c);
    const open = EVENTS_STATE.expanded.has(c.id);
    const mine = c.submissions?.find(s => s.user_id === state.user?.id);
    const canSubmit = !!state.user && phase === 'submission' && !mine;
    const canVote = !!state.user && phase === 'voting' && c.submissions?.some(s => s.user_id !== state.user.id);
    return `<div class="contest-card">
      <div class="contest-card-top"><div><h4>${esc(c.title)}</h4><div class="contest-description">${esc(c.description || '')}</div></div><span class="contest-phase ${phaseClass(phase)}">${phaseLabel(phase)}</span></div>
      <div class="contest-meta"><span>${c.submissions?.length||0} submissions</span><span>Submit by ${fmt(c.submission_deadline)}</span><span>Vote ${fmt(c.voting_start)} → ${fmt(c.voting_deadline)}</span></div>
      <div class="contest-card-actions">
        ${canSubmit ? `<button class="btn btn-primary btn-sm" type="button" onclick="toggleContestSubmit('${c.id}')"><i data-lucide="send"></i> Join &amp; Submit</button>` : ''}
        ${!state.user && phase === 'submission' ? `<button class="btn btn-primary btn-sm" type="button" onclick="openContestSignIn('${c.id}')"><i data-lucide="log-in"></i> Sign in to join</button>` : ''}
        ${mine ? `<span class="contest-phase"><i data-lucide="check"></i> Your submission is in</span>` : ''}
        ${canVote ? `<button class="btn btn-primary btn-sm" type="button" onclick="startContestVoting('${c.id}')"><i data-lucide="star"></i> Vote in this contest</button>` : ''}
        ${phase === 'results' ? `<button class="btn btn-secondary btn-sm" type="button" onclick="toggleContestResults('${c.id}')"><i data-lucide="trophy"></i> Results</button>` : ''}
        <button class="btn btn-secondary btn-sm" type="button" onclick="toggleContestDetails('${c.id}')"><i data-lucide="${open ? 'chevron-up' : 'chevron-down'}"></i> ${open ? 'Hide details' : 'View details'}</button>
      </div>
      ${open ? contestPanel(c, phase) : ''}
    </div>`;
}

function contestPanel(c, phase) {
    if (phase === 'submission') return `<div class="contest-submit-panel" id="contest-submit-${c.id}"><h5>Choose a Fakemon from your collection</h5><select id="contest-mon-${c.id}" class="form-control"><option value="">Select a Fakemon…</option>${(state.fakemonDB||[]).map(m=>`<option value="${esc(m.id)}">${esc(m.name || 'Unnamed')}</option>`).join('')}</select><div class="contest-panel-actions"><button class="btn btn-primary btn-sm" onclick="submitContestEntry('${c.id}')">Submit Entry</button></div></div>`;
    if (phase === 'voting') return `<div class="contest-submit-panel"><h5>Voting is open</h5><p class="contest-description">Vote on every eligible entry. Your voting order is randomized for this session.</p><button class="btn btn-primary" type="button" onclick="startContestVoting('${c.id}')"><i data-lucide="star"></i> Start voting</button></div>`;
    if (phase === 'results') return `<div class="contest-submit-panel"><h5>Results</h5><button class="btn btn-secondary btn-sm" onclick="toggleContestResults('${c.id}')">View results</button></div>`;
    return '';
}

function getFakemonImage(data){ return data?.artwork?.normal || data?.artwork?.url || data?.image || data?.sprite || ''; }
function shuffle(items){ const a=[...items]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

async function startContestVoting(contestId){
    if(!state.user) return openContestSignIn(contestId);
    const contest = EVENTS_STATE.events.flatMap(e=>e.contests||[]).find(c=>c.id===contestId);
    if(!contest) return;
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
    const contest=EVENTS_STATE.events.flatMap(e=>e.contests||[]).find(c=>c.id===v.contestId); if(!contest)return;
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
    root.innerHTML=`<div class="events-hero panel"><div><div class="events-kicker">VOTING</div><h2>${esc(contest.title)}</h2><p>${doneCount} of ${v.order.length} entries completed. Finish every entry, then submit your ballot.</p></div><button class="btn btn-secondary btn-sm" onclick="closeContestVoting()">Back to events</button></div><div class="contest-voting-layout"><aside class="contest-vote-queue panel"><h4>Entries</h4>${queue}</aside><main>${card}<div class="contest-final-submit panel"><div><strong>${allDone?'All entries rated!':'Keep going'}</strong><p>${allDone?'Your ratings are ready to be submitted to the contest.':'Each entry needs both scores before you can submit.'}</p></div><button class="btn btn-primary" onclick="submitContestBallot()" ${allDone?'':'disabled'}><i data-lucide="send"></i> Submit all votes</button></div></main></div>`;
    if(typeof lucide!=='undefined')lucide.createIcons();
}
function setContestVoteScore(kind,val){const v=EVENTS_STATE.voting;if(!v)return;const id=v.order[v.index];v.scores[`${id}:${kind}`]=val;renderVotingView();}
function setContestVoteRemarks(value){const v=EVENTS_STATE.voting;if(v)v.remarks[v.order[v.index]]=value;}
function jumpContestVote(index){const v=EVENTS_STATE.voting;if(!v)return;v.index=Math.max(0,Math.min(index,v.order.length-1));renderVotingView();}
function saveAndNextContestVote(){const v=EVENTS_STATE.voting;if(!v)return;const id=v.order[v.index];if(!v.scores[`${id}:competitive`]||!v.scores[`${id}:design`])return api.showToast?.('Give both scores from 1 to 10 before continuing.','warning');if(v.index<v.order.length-1){v.index++;renderVotingView();}else{renderVotingView();api.showToast?.('This entry is complete. Submit your ballot when all entries are green.','success');}}

async function submitContestBallot(){
    const v=EVENTS_STATE.voting;if(!v||!state.user)return;
    const contest=EVENTS_STATE.events.flatMap(e=>e.contests||[]).find(c=>c.id===v.contestId);const eligible=(contest?.submissions||[]).filter(s=>s.user_id!==state.user.id);
    const votes=eligible.map(s=>({submission_id:s.id,competitive_score:v.scores[`${s.id}:competitive`],design_score:v.scores[`${s.id}:design`],remarks:v.remarks[s.id]||''}));
    if(votes.some(x=>!x.competitive_score||!x.design_score))return api.showToast?.('Complete every entry before submitting.','warning');
    try{const client=await api.getClient();const {error}=await client.rpc('submit_contest_ballot',{p_contest_id:v.contestId,p_votes:votes});if(error)throw error;api.showToast?.('Your completed ballot has been submitted.','success');closeContestVoting();await loadEventsView();}catch(e){api.showToast?.(e.message||String(e),'error');}
}
function closeContestVoting(){EVENTS_STATE.voting=null;const vv=document.getElementById('contest-voting-view');if(vv)vv.style.display='none';const list=document.getElementById('events-list');if(list)list.style.display='block';}

async function submitContestEntry(contestId){if(!state.user)return api.showToast?.('Sign in first.','warning');const monId=document.getElementById(`contest-mon-${contestId}`)?.value;const mon=(state.fakemonDB||[]).find(m=>String(m.id)===String(monId));if(!mon)return api.showToast?.('Choose a Fakemon first.','warning');const client=await api.getClient();const {error}=await client.from('contest_submissions').insert({contest_id:contestId,user_id:state.user.id,source_fakemon_id:String(mon.id),fakemon_data:mon});if(error)return api.showToast?.(error.message,'error');api.showToast?.('Contest entry submitted!','success');await loadEventsView();}
function openContestSignIn(){api.showToast?.('Sign in to join this contest.','info');if(typeof window.openAuthModal==='function')window.openAuthModal('signin');}
function toggleContestDetails(id){EVENTS_STATE.expanded.has(id)?EVENTS_STATE.expanded.delete(id):EVENTS_STATE.expanded.add(id);renderEvents();}
function toggleContestSubmit(id){EVENTS_STATE.expanded.add(id);renderEvents();setTimeout(()=>document.getElementById(`contest-submit-${id}`)?.scrollIntoView({behavior:'smooth',block:'center'}),50);}
function toggleContestResults(id){EVENTS_STATE.expanded.add(id);renderEvents();}

window.openEvents=openEvents;window.loadEventsView=loadEventsView;window.toggleContestDetails=toggleContestDetails;window.toggleContestSubmit=toggleContestSubmit;window.toggleContestResults=toggleContestResults;window.submitContestEntry=submitContestEntry;window.openContestSignIn=openContestSignIn;window.startContestVoting=startContestVoting;window.jumpContestVote=jumpContestVote;window.setContestVoteScore=setContestVoteScore;window.setContestVoteRemarks=setContestVoteRemarks;window.saveAndNextContestVote=saveAndNextContestVote;window.submitContestBallot=submitContestBallot;window.closeContestVoting=closeContestVoting;
