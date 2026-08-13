import { state, api } from './app.js';

// Evolution / forme whiteboard. The graph is persisted with each participating
// Fakemon so opening any member of a connected chain restores the same board.
// Node size scales down on narrow/mobile viewports so boards stay usable
// and draggable without nodes overflowing the visible board width.
function getNodeSize() {
    const mobile = window.innerWidth <= 640;
    return mobile ? { w: 148, h: 90 } : { w: 196, h: 104 };
}
const DEFAULT_GRAPH = () => ({
    version: 1,
    nodes: [],
    edges: []
});

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function esc(v) { return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function ensureGraph() {
    if (!state.evolutionGraph || typeof state.evolutionGraph !== 'object') state.evolutionGraph = DEFAULT_GRAPH();
    if (!Array.isArray(state.evolutionGraph.nodes)) state.evolutionGraph.nodes = [];
    if (!Array.isArray(state.evolutionGraph.edges)) state.evolutionGraph.edges = [];
    return state.evolutionGraph;
}

function currentNodeId() { return state.editingId ? `fakemon:${state.editingId}` : 'current:fakemon'; }
function isSpecialNode(node) { return !!(node && (node.isMega || node.isFormeChange)); }

function getFakemon(id) { return (state.fakemonDB || []).find(f => String(f.id) === String(id)); }
function getVanilla(id) { return state.sdPokedex?.[id] || Object.values(state.sdPokedex || {}).find(p => p.id === id); }

function getNodeInfo(node) {
    if (!node) return { name:'Unknown', species:'', types:[], spriteId:'', isMega:false, isFormeChange:false };
    if (node.kind === 'fakemon') {
        const f = getFakemon(node.refId) || (state.editingId === node.refId ? api.buildFakemonObject?.() : null) || {};
        return {
            name: f.name || node.name || 'Fakemon', refId: node.refId, species: f.species || '', types: [f.type1,f.type2].filter(Boolean),
            spriteId: node.refId, record: { id: node.refId, name: f.name || node.name }, isMega: !!f.isMega, isFormeChange: !!f.isFormeChange,
            number: f.number || '', kindLabel: 'Fakemon', artwork: f.artwork || null
        };
    }
    const p = getVanilla(node.refId) || {};
    return {
        name: p.name || node.name || node.refId || 'Pokémon', refId: node.refId, species: p.species || '', types: p.types || [],
        spriteId: node.refId, record: p, isMega: /mega/i.test(p.forme || ''), isFormeChange: !!p.forme && !/mega/i.test(p.forme || ''),
        number: p.num ? `#${String(p.num).padStart(3,'0')}` : '', kindLabel: 'Vanilla', artwork: null
    };
}

function addCurrentNode() {
    const g = ensureGraph();
    const id = currentNodeId();
    let n = g.nodes.find(x => x.id === id);
    if (!n) {
        n = { id, kind:'fakemon', refId: state.editingId || null, name:'Current Fakemon', x: 50, y: 190, isMega:false, isFormeChange:false };
        g.nodes.push(n);
    }
    n.refId = state.editingId || n.refId;
    const f = state.editingId ? getFakemon(state.editingId) : null;
    n.name = f?.name || document.getElementById('fakemon-name')?.value || n.name;
    n.isMega = !!document.getElementById('fakemon-is-mega')?.checked;
    n.isFormeChange = !!document.getElementById('fakemon-is-forme')?.checked;
    return n;
}

function renderEvolutionBoard() {
    const board = document.getElementById('evolution-board');
    if (!board) return;
    const g = ensureGraph();
    const me = addCurrentNode();
    const stageMap = calculateStages(g);
    const { w: NODE_W, h: NODE_H } = getNodeSize();
    const W = Math.max(board.clientWidth || 900, NODE_W + 40);
    const H = Math.max(board.clientHeight || 520, NODE_H + 40);
    board.querySelectorAll('.evo-node').forEach(x => x.remove());
    const svg = board.querySelector('.evo-wires');
    if (svg) svg.innerHTML = '';

    g.nodes.forEach(n => {
        const info = getNodeInfo(n);
        const el = document.createElement('div');
        el.className = `evo-node${n.id === me.id ? ' current' : ''}`;
        el.dataset.nodeId = n.id;
        el.style.width = `${NODE_W}px`;
        el.style.minHeight = `${NODE_H}px`;
        el.style.left = `${Math.max(4, Math.min(W - NODE_W - 4, n.x || 20))}px`;
        el.style.top = `${Math.max(4, Math.min(H - NODE_H - 4, n.y || 20))}px`;
        const stage = stageMap[n.id] || 1;
        const stageLabel = n.isMega ? 'Mega Evolution' : n.isFormeChange ? 'Forme Change' : `Stage ${stage}`;
        const tags = [n.isMega?'Mega Evolution':'', n.isFormeChange?'Forme Change':''].filter(Boolean);
        const spriteUrl = info.artwork || (api.getSpriteUrl ? api.getSpriteUrl(info.spriteId, info.record || {id: info.spriteId, name: info.name}) : '');
        const fallbackName = info.record?.baseSpecies || info.refId || info.name;
        const safeOnErrorName = String(info.name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const safeOnErrorFallback = String(fallbackName || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        el.innerHTML = `
          <button class="evo-handle evo-handle-left" type="button" title="Drag from this side to connect"></button>
          <div class="evo-node-head"><span class="evo-stage">${esc(stageLabel)}</span><span style="display:flex;align-items:center;gap:5px;"><span class="evo-kind">${esc(info.kindLabel)}</span>${n.id !== me.id ? `<button class="evo-remove" type="button" title="Remove">×</button>` : ''}</span></div>
          <div class="evo-node-body">
            <div class="evo-sprite-wrap"><img src="${esc(spriteUrl)}" alt="${esc(info.name)}" onerror="window.fallbackPokemonImage && window.fallbackPokemonImage(this, '${safeOnErrorName}', '${safeOnErrorFallback}')"></div>
            <div class="evo-node-name"><strong>${esc(info.name)}</strong><small>${esc(info.species || (info.types||[]).join(' / '))}</small>${tags.length ? `<em>${esc(tags.join(' · '))}</em>` : ''}</div>
          </div>
          ${n.isMega ? '' : '<button class="evo-handle evo-handle-right" type="button" title="Drag from this side to connect"></button>'}
        `;
        el.addEventListener('pointerdown', e => startNodeDrag(e, n.id));
        el.querySelectorAll('.evo-handle').forEach(h => {
            h.addEventListener('pointerdown', e => startHandleDrag(e, n.id, h.classList.contains('evo-handle-left') ? 'left' : 'right'));
        });
        el.querySelector('.evo-remove')?.addEventListener('click', e => { e.stopPropagation(); removeEvolutionNode(n.id); });
        board.appendChild(el);
    });
    drawEvolutionEdges();
    updateEvolutionStatus();
}

function calculateStages(g) {
    const incoming = new Map(g.nodes.map(n => [n.id, []]));
    const effective = effectiveEdges(g);
    effective.forEach(e => { if (incoming.has(e.to)) incoming.get(e.to).push(e.from); });
    const memo = new Map(), visiting = new Set();
    const dfs = id => {
        if (memo.has(id)) return memo.get(id);
        if (visiting.has(id)) return 1;
        visiting.add(id);
        const parents = incoming.get(id) || [];
        const val = parents.length ? Math.max(...parents.map(dfs)) + 1 : 1;
        visiting.delete(id); memo.set(id, Math.min(val, 99)); return memo.get(id);
    };
    g.nodes.forEach(n => dfs(n.id));
    return Object.fromEntries(memo);
}

function effectiveEdges(g) {
    return g.edges.map(e => {
        const fromNode = g.nodes.find(n => n.id === e.from);
        const toNode = g.nodes.find(n => n.id === e.to);
        // For Mega/forme nodes, a node connected to its LEFT side is explicitly
        // treated as its child. The visual edge can therefore run child -> special
        // while the evolution hierarchy runs special -> child.
        if (toNode && isSpecialNode(toNode) && e.toSide === 'left') return { from:e.to, to:e.from };
        return { from:e.from, to:e.to };
    });
}

function drawEvolutionEdges() {
    const board = document.getElementById('evolution-board');
    const svg = board?.querySelector('.evo-wires');
    if (!board || !svg) return;
    const g = ensureGraph();
    const { w: NODE_W, h: NODE_H } = getNodeSize();
    const br = board.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${Math.max(br.width, NODE_W + 40)} ${Math.max(br.height, NODE_H + 40)}`);
    const defs = `<defs><marker id="evo-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>`;
    svg.innerHTML = defs;
    if (handleDrag) {
        const sourceNode = g.nodes.find(n => n.id === handleDrag.nodeId);
        if (sourceNode) {
            const sx = handleDrag.side === 'right' ? (sourceNode.x || 0) + NODE_W : (sourceNode.x || 0);
            const sy = (sourceNode.y || 0) + NODE_H / 2;
            const ex = handleDrag.snapTarget?.x ?? handleDrag.x;
            const ey = handleDrag.snapTarget?.y ?? handleDrag.y;
            const dx = Math.max(30, Math.abs(ex - sx) * .45);
            const preview = document.createElementNS('http://www.w3.org/2000/svg','path');
            preview.setAttribute('d', `M ${sx} ${sy} C ${sx+dx} ${sy}, ${ex-dx} ${ey}, ${ex} ${ey}`);
            preview.setAttribute('class', 'evo-wire evo-wire-preview');
            svg.appendChild(preview);
        }
    }

    g.edges.forEach(edge => {
        const e = edge;
        const a = g.nodes.find(n => n.id === e.from), b = g.nodes.find(n => n.id === e.to);
        if (!a || !b) return;
        const ax = (a.x || 0) + NODE_W, ay = (a.y || 0) + NODE_H/2;
        const bx = b.x || 0, by = (b.y || 0) + NODE_H/2;
        const dx = Math.max(30, Math.abs(bx - ax) * .45);
        const d = `M ${ax} ${ay} C ${ax+dx} ${ay}, ${bx-dx} ${by}, ${bx} ${by}`;
        const group = document.createElementNS('http://www.w3.org/2000/svg','g');
        group.setAttribute('class','evo-wire-group');

        const visible = document.createElementNS('http://www.w3.org/2000/svg','path');
        visible.setAttribute('d', d);
        visible.setAttribute('class', 'evo-wire');
        visible.setAttribute('marker-end','url(#evo-arrow)');
        visible.setAttribute('pointer-events','none');

        // A transparent, much wider stroke is used as the click/hover hitbox.
        // This keeps the visual wire thin while making removal easy on touchscreens.
        const hit = document.createElementNS('http://www.w3.org/2000/svg','path');
        hit.setAttribute('d', d);
        hit.setAttribute('class','evo-wire-hit');
        hit.setAttribute('pointer-events','stroke');

        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const scissors = document.createElementNS('http://www.w3.org/2000/svg','text');
        scissors.setAttribute('x', mx);
        scissors.setAttribute('y', my);
        scissors.setAttribute('class','evo-wire-scissors');
        scissors.setAttribute('text-anchor','middle');
        scissors.setAttribute('dominant-baseline','central');
        scissors.textContent = '✂';
        scissors.setAttribute('pointer-events','none');

        hit.addEventListener('pointerenter', () => group.classList.add('hover'));
        hit.addEventListener('pointerleave', () => group.classList.remove('hover'));
        hit.addEventListener('pointerdown', ev => {
            ev.stopPropagation();
            const idx = g.edges.indexOf(edge);
            if (idx >= 0) { g.edges.splice(idx, 1); persistEvolutionGraph(); renderEvolutionBoard(); }
        });
        group.appendChild(visible);
        group.appendChild(hit);
        group.appendChild(scissors);
        svg.appendChild(group);
    });
}

let drag = null;
function startNodeDrag(e, id) {
    if (e.target.closest('.evo-handle, .evo-remove, button')) return;
    const board = document.getElementById('evolution-board');
    const n = ensureGraph().nodes.find(x => x.id === id);
    if (!board || !n) return;
    const r = board.getBoundingClientRect();
    drag = { id, ox:e.clientX-r.left-(n.x||0), oy:e.clientY-r.top-(n.y||0) };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
}
document.addEventListener('pointermove', e => {
    if (!drag) return;
    const board = document.getElementById('evolution-board');
    const n = ensureGraph().nodes.find(x => x.id === drag.id);
    if (!board || !n) return;
    const { w: NODE_W, h: NODE_H } = getNodeSize();
    const r = board.getBoundingClientRect();
    n.x = Math.max(4, Math.min(r.width-NODE_W-4, e.clientX-r.left-drag.ox));
    n.y = Math.max(4, Math.min(r.height-NODE_H-4, e.clientY-r.top-drag.oy));
    const el = board.querySelector(`.evo-node[data-node-id=\"${CSS.escape(drag.id)}\"]`);
    if (el) { el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; }
    drawEvolutionEdges();
});
document.addEventListener('pointerup', () => { if (drag) { drag=null; persistEvolutionGraph(); } });

let handleDrag = null;
const HANDLE_SNAP_RADIUS = 42;

function clearHandleSnap() {
    document.querySelectorAll('#evolution-board .evo-handle.evo-snap-target').forEach(el => el.classList.remove('evo-snap-target'));
}

function findNearestCompatibleHandle(e, sourceNodeId, sourceSide) {
    const board = document.getElementById('evolution-board');
    if (!board) return null;
    const br = board.getBoundingClientRect();
    const px = e.clientX - br.left;
    const py = e.clientY - br.top;
    let best = null;
    board.querySelectorAll('.evo-handle').forEach(handle => {
        const nodeEl = handle.closest('.evo-node');
        if (!nodeEl || nodeEl.dataset.nodeId === sourceNodeId) return;
        const side = handle.classList.contains('evo-handle-left') ? 'left' : 'right';
        // A connection must ultimately be right -> left. Either handle can be the
        // starting handle, so only reject a target that cannot form a valid pair.
        if (sourceSide === side) return;
        const r = handle.getBoundingClientRect();
        const hx = r.left - br.left + r.width / 2;
        const hy = r.top - br.top + r.height / 2;
        const dist = Math.hypot(hx - px, hy - py);
        if (dist <= HANDLE_SNAP_RADIUS && (!best || dist < best.distance)) {
            best = { element: handle, nodeId: nodeEl.dataset.nodeId, side, x: hx, y: hy, distance: dist };
        }
    });
    return best;
}
function getBoardPoint(e) {
    const board = document.getElementById('evolution-board');
    if (!board) return null;
    const r = board.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function startHandleDrag(e, nodeId, side) {
    e.stopPropagation();
    e.preventDefault();
    const point = getBoardPoint(e);
    if (!point) return;
    const handle = e.currentTarget;
    handleDrag = { nodeId, side, x: point.x, y: point.y, pointerId: e.pointerId, sourceHandle: handle };
    try { handle.setPointerCapture?.(e.pointerId); } catch (_) {}
    handle.classList.add('dragging');
    drawEvolutionEdges();
}

function finishHandleDrag(e) {
    if (!handleDrag) return;
    const dragState = handleDrag;
    handleDrag = null;
    dragState.sourceHandle?.classList.remove('dragging');
    const target = dragState.snapTarget?.element || document.elementFromPoint(e.clientX, e.clientY)?.closest('.evo-handle');
    clearHandleSnap();
    if (target) {
        const nodeEl = target.closest('.evo-node');
        const targetId = nodeEl?.dataset.nodeId;
        const targetSide = target.classList.contains('evo-handle-left') ? 'left' : 'right';
        if (targetId && targetId !== dragState.nodeId) {
            connectHandles(dragState.nodeId, dragState.side, targetId, targetSide);
        }
    }
    drawEvolutionEdges();
}
document.addEventListener('pointermove', e => {
    if (!handleDrag) return;
    const point = getBoardPoint(e);
    if (!point) return;
    handleDrag.x = point.x; handleDrag.y = point.y;
    clearHandleSnap();
    const snap = findNearestCompatibleHandle(e, handleDrag.nodeId, handleDrag.side);
    handleDrag.snapTarget = snap;
    if (snap?.element) snap.element.classList.add('evo-snap-target');
    drawEvolutionEdges();
});
document.addEventListener('pointerup', finishHandleDrag);
document.addEventListener('pointercancel', finishHandleDrag);
function effectiveDirectionOf(g, from, to) {
    const toNode = g.nodes.find(n => n.id === to);
    if (toNode && isSpecialNode(toNode)) return { from: to, to: from };
    return { from, to };
}
function canReach(g, startId, targetId) {
    const effective = effectiveEdges(g);
    const adj = new Map();
    effective.forEach(e => { if (!adj.has(e.from)) adj.set(e.from, []); adj.get(e.from).push(e.to); });
    const seen = new Set();
    const stack = [startId];
    while (stack.length) {
        const cur = stack.pop();
        if (cur === targetId) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        (adj.get(cur) || []).forEach(n => stack.push(n));
    }
    return false;
}
function wouldCreateCycle(g, from, to) {
    const { from: ef, to: et } = effectiveDirectionOf(g, from, to);
    if (ef === et) return true;
    return canReach(g, et, ef);
}

function connectHandles(aId, aSide, bId, bSide) {
    let from = {nodeId:aId, side:aSide}, to = {nodeId:bId, side:bSide};
    if (from.side !== 'right' || to.side !== 'left') {
        if (to.side === 'right' && from.side === 'left') { const tmp = from; from = to; to = tmp; }
        else { api.showToast('Connect a right handle to a left handle.', 'info'); return; }
    }
    const g = ensureGraph();
    if (g.edges.some(e => e.from===from.nodeId && e.to===to.nodeId)) return;
    if (wouldCreateCycle(g, from.nodeId, to.nodeId)) { api.showToast('That connection would create a loop in the evolution chain.', 'error'); return; }
    g.edges.push({from:from.nodeId,to:to.nodeId,fromSide:'right',toSide:'left'});
    persistEvolutionGraph();
    renderEvolutionBoard();
}
let pendingHandle = null;
function selectConnectionHandle(nodeId, side) {
    if (!pendingHandle) { pendingHandle = { nodeId, side }; updateEvolutionStatus('Select the other side to connect.'); return; }
    if (pendingHandle.nodeId === nodeId) { pendingHandle=null; updateEvolutionStatus(); return; }
    let from = pendingHandle, to = {nodeId, side};
    if (from.side !== 'right' || to.side !== 'left') {
        if (to.side === 'right' && from.side === 'left') { const tmp=from; from=to; to=tmp; }
        else { pendingHandle=null; updateEvolutionStatus('Connect a right handle to a left handle.'); return; }
    }
    const g = ensureGraph();
    if (g.edges.some(e => e.from===from.nodeId && e.to===to.nodeId)) { pendingHandle=null; updateEvolutionStatus(); return; }
    if (wouldCreateCycle(g, from.nodeId, to.nodeId)) { pendingHandle=null; api.showToast('That connection would create a loop in the evolution chain.', 'error'); updateEvolutionStatus(); return; }
    g.edges.push({from:from.nodeId,to:to.nodeId,fromSide:'right',toSide:'left'});
    pendingHandle=null;
    persistEvolutionGraph(); renderEvolutionBoard();
}

function removeSelectedEdge() {}
function updateEvolutionStatus(message='') {
    const el = document.getElementById('evolution-status');
    if (el) el.textContent = message || `${ensureGraph().nodes.length} Pokémon · ${ensureGraph().edges.length} connection${ensureGraph().edges.length===1?'':'s'}`;
}

function openEvolutionNodeChooser(kind) {
    const modal = document.getElementById('evolution-node-modal');
    if (!modal) return;
    modal.dataset.kind = kind;
    const title = document.getElementById('evolution-node-modal-title');
    if (title) title.textContent = kind === 'fakemon' ? 'Add Fakemon' : 'Add Vanilla Pokémon';
    const input = document.getElementById('evolution-node-search');
    if (input) input.value='';
    renderEvolutionNodeChooser();
    modal.classList.add('active');
    setTimeout(()=>input?.focus(),50);
}
function renderEvolutionNodeChooser() {
    const modal = document.getElementById('evolution-node-modal');
    const list = document.getElementById('evolution-node-list');
    if (!modal || !list) return;
    const kind = modal.dataset.kind || 'fakemon';
    const q = document.getElementById('evolution-node-search')?.value.trim().toLowerCase() || '';
    const items = kind === 'fakemon' ? (state.fakemonDB||[]).filter(f=>f.id!==state.editingId) : Object.values(state.sdPokedex||{}).filter(p=>p && p.num>0);
    const filtered = items.filter(x => `${x.name||''} ${x.species||''} ${x.id||''}`.toLowerCase().includes(q)).slice(0,100);
    list.className = 'pokemon-template-list evolution-node-list';
    list.innerHTML = filtered.map(x => {
        const id = x.id || x.key || x.name;
        const name = x.name || 'Pokémon';
        const record = kind === 'fakemon' ? x : x;
        const sprite = kind === 'fakemon'
            ? (x.artwork || '')
            : (api.getSpriteUrl ? api.getSpriteUrl(x.id, x) : '');
        const fallbackName = x.baseSpecies || x.name || id;
        const safeName = String(name).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        const safeFallback = String(fallbackName).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        const types=(x.types||[]).map(t=>`<span class="type-pill type-${String(t).toLowerCase()}">${esc(t)}</span>`).join('');
        return `<button type="button" class="pokemon-template-card" onclick="addEvolutionNode('${kind}','${esc(id)}')">
            <img class="pokemon-template-sprite" src="${esc(sprite)}" alt="${esc(name)}" loading="lazy" onerror="window.fallbackPokemonImage && window.fallbackPokemonImage(this, '${safeName}', '${safeFallback}')">
            <span class="pokemon-template-info">
                <span class="pokemon-template-number">${kind==='fakemon' ? 'FAKEMON' : (x.num ? '#'+String(x.num).padStart(3,'0') : 'VANILLA')}</span>
                <span class="pokemon-template-name">${esc(name)}</span>
                <span class="pokemon-template-meta">${types}<span class="pokemon-template-bst">${esc(x.species || '')}</span></span>
            </span>
            <span class="pokemon-template-arrow">›</span>
        </button>`;
    }).join('') || '<div class="pokemon-template-empty">No Pokémon match that search.</div>';
}
function addEvolutionNode(kind, refId) {
    const g=ensureGraph();
    const id=`${kind}:${refId}`;
    if (g.nodes.some(n=>n.id===id)) { api.showToast('That Pokémon is already on the board.','info'); return; }
    const idx=g.nodes.length;
    const { w: NODE_W, h: NODE_H } = getNodeSize();
    const mobile = window.innerWidth <= 640;
    const cols = mobile ? 2 : 3;
    const colGap = NODE_W + 9, rowGap = NODE_H + 21;
    g.nodes.push({id,kind,refId,name: kind==='fakemon' ? (getFakemon(refId)?.name||'Fakemon') : (getVanilla(refId)?.name||refId),x:30+(idx%cols)*colGap,y:30+Math.floor(idx/cols)*rowGap,isMega:false,isFormeChange:false});
    api.closeModal?.('evolution-node-modal'); persistEvolutionGraph(); renderEvolutionBoard();
}
function removeEvolutionNode(id) {
    const g=ensureGraph();
    if (id===currentNodeId()) return api.showToast('The current Fakemon cannot be removed from its own evolution board.','info');
    const removedNode = g.nodes.find(n => n.id === id);
    g.nodes=g.nodes.filter(n=>n.id!==id); g.edges=g.edges.filter(e=>e.from!==id&&e.to!==id);
    // The removed Pokémon's own saved record still points at the old shared
    // graph (which still includes itself and its old connections). Reset it
    // to a solo graph so it doesn't keep reappearing/reconnecting the next
    // time someone opens its editor.
    if (removedNode && removedNode.kind === 'fakemon' && removedNode.refId) {
        const removedFakemon = getFakemon(removedNode.refId);
        if (removedFakemon) {
            const soloGraph = DEFAULT_GRAPH();
            soloGraph.nodes.push({
                id: `fakemon:${removedFakemon.id}`, kind:'fakemon', refId: removedFakemon.id,
                name: removedFakemon.name, x: 50, y: 190,
                isMega: !!removedFakemon.isMega, isFormeChange: !!removedFakemon.isFormeChange
            });
            removedFakemon.evolutionGraph = soloGraph;
            removedFakemon.evolutionStage = 1;
        }
    }
    persistEvolutionGraph(); renderEvolutionBoard();
}

function persistEvolutionGraph() {
    const g=clone(ensureGraph());
    // Keep the graph on every saved Fakemon represented by it. This makes the tab
    // state follow the chain when any participating Fakemon is opened later.
    const stages = calculateStages(g);
    const fakemonIds = g.nodes.filter(n=>n.kind==='fakemon'&&n.refId).map(n=>n.refId);
    fakemonIds.forEach(id => {
        const f=getFakemon(id);
        const node=g.nodes.find(n=>n.kind==='fakemon'&&String(n.refId)===String(id));
        if (f) { f.evolutionGraph=clone(g); f.evolutionStage=stages[node?.id] || 1; }
    });
    if (state.editingId) {
        const current=getFakemon(state.editingId);
        const node=g.nodes.find(n=>n.id===`fakemon:${state.editingId}` || n.id==='current:fakemon');
        if (current) { current.evolutionGraph=clone(g); current.evolutionStage=stages[node?.id] || 1; }
    }
    api.saveToStorage?.();
}



function onFakemonSaved(id) {
    const g=ensureGraph();
    const old=g.nodes.find(n=>n.id==='current:fakemon');
    if (old) { old.id=`fakemon:${id}`; old.refId=id; old.kind='fakemon'; }
    const me=g.nodes.find(n=>n.id===`fakemon:${id}`);
    if (me) { me.refId=id; me.name=getFakemon(id)?.name || me.name; }
    persistEvolutionGraph();
    renderEvolutionBoard();
}

function initializeEvolutionGraph(graph) {
    state.evolutionGraph = graph ? clone(graph) : DEFAULT_GRAPH();
    addCurrentNode();
    renderEvolutionBoard();
}

function toggleEvolutionMode(which, checked) {
    const mega=document.getElementById('fakemon-is-mega'), forme=document.getElementById('fakemon-is-forme'), species=document.getElementById('fakemon-species');
    if (which==='mega' && checked && forme) forme.checked=false;
    if (which==='forme' && checked && mega) mega.checked=false;
    if (species) species.disabled=!!((mega?.checked)||(forme?.checked));
    const me=addCurrentNode(); me.isMega=!!mega?.checked; me.isFormeChange=!!forme?.checked;
    persistEvolutionGraph(); renderEvolutionBoard(); api.updatePreview?.();
}
function syncEvolutionOnBasicLoad(fakemon) {
    const mega=document.getElementById('fakemon-is-mega'), forme=document.getElementById('fakemon-is-forme'), species=document.getElementById('fakemon-species');
    if (mega) mega.checked=!!fakemon.isMega;
    if (forme) forme.checked=!!fakemon.isFormeChange;
    if (species) species.disabled=!!(fakemon.isMega||fakemon.isFormeChange);
}

function shareSpecialPropertiesWithChild() {
    const g=ensureGraph(); const me=addCurrentNode();
    if (!isSpecialNode(me)) return;
    const incoming=g.edges.filter(e=>e.to===me.id && e.toSide==='left');
    incoming.forEach(e=>{
        const child=g.nodes.find(n=>n.id===e.from); if (!child || child.kind!=='fakemon' || !child.refId) return;
        const f=getFakemon(child.refId); if (!f) return;
        // A forme/mega shares the common identity/evolution board with its child;
        // don't overwrite combat stats or custom content, only the graph linkage.
        f.evolutionGraph=clone(g);
    });
}

export { ensureGraph, calculateStages as calculateEvolutionStages, onFakemonSaved, renderEvolutionBoard, openEvolutionNodeChooser, renderEvolutionNodeChooser, addEvolutionNode, removeEvolutionNode, initializeEvolutionGraph, toggleEvolutionMode, syncEvolutionOnBasicLoad, persistEvolutionGraph, shareSpecialPropertiesWithChild };

// Re-layout the board when the viewport crosses the mobile breakpoint (e.g.
// on rotation), since node size and spacing depend on window width.
let resizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (document.getElementById('evolution-board')) renderEvolutionBoard();
    }, 150);
});