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
    version: 2,
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

const EVO_METHOD_LABELS = {
    level: 'By Level',
    item: 'By Item',
    custom: 'Custom Method'
};
const EVO_STONE_NAMES = new Set([
    'Fire Stone','Water Stone','Thunder Stone','Leaf Stone','Moon Stone',
    'Sun Stone','Shiny Stone','Dusk Stone','Dawn Stone','Ice Stone','Oval Stone'
]);
function isMegaStoneName(value) { return /\bmega stone$/i.test(String(value || '').trim()); }
function getDetectedItemLabel(value) {
    const item = String(value || '').trim();
    if (!item) return 'By Item';
    if (isMegaStoneName(item)) return 'Mega Stone';
    if (EVO_STONE_NAMES.has(item)) return 'Evolution Stone';
    return 'By Item';
}

function isMethodNode(node) { return !!(node && node.kind === 'method'); }
function getMethodLabel(node) {
    if (node?.methodType === 'item') return getDetectedItemLabel(node.value);
    return EVO_METHOD_LABELS[node?.methodType] || 'Evolution Method';
}
function getMethodSummary(node) {
    if (!node) return '';
    const type = node.methodType || 'custom';
    if (type === 'level') return `Level ${Math.max(1, Number(node.value) || 1)}`;
    if (type === 'item') return node.value ? String(node.value) : 'Choose an item';
    return String(node.description || '').trim() || 'Describe the evolution condition';
}
function methodNodeId() { return `evo-method:${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }
function getMethodNodes(g) { return g.nodes.filter(isMethodNode); }

// Method nodes are visual/semantic connectors between two Pokemon nodes. For
// stage calculation and cycle checks, collapse any chain of method nodes so
// methods never count as extra evolution stages.
function collapseMethodEdges(g) {
    const methodIds = new Set(getMethodNodes(g).map(n => n.id));
    if (!methodIds.size) return g.edges.map(e => ({ from:e.from, to:e.to }));
    const collapsed = [];
    const seen = new Set();
    const outgoing = new Map();
    g.edges.forEach(e => {
        if (!outgoing.has(e.from)) outgoing.set(e.from, []);
        outgoing.get(e.from).push(e.to);
    });
    g.nodes.filter(n => !isMethodNode(n)).forEach(start => {
        const stack = [...(outgoing.get(start.id) || [])];
        const visited = new Set();
        while (stack.length) {
            const next = stack.pop();
            if (visited.has(next)) continue;
            visited.add(next);
            if (!methodIds.has(next)) {
                if (next !== start.id) {
                    const key = `${start.id}->${next}`;
                    if (!seen.has(key)) { seen.add(key); collapsed.push({from:start.id,to:next}); }
                }
                continue;
            }
            (outgoing.get(next) || []).forEach(n => stack.push(n));
        }
    });
    return collapsed;
}

function findMethodMergeTarget(g, node, radius = 105) {
    let best = null;
    g.nodes.filter(isMethodNode).forEach(other => {
        if (other.id === node.id) return;
        const d = Math.hypot((other.x || 0) - (node.x || 0), (other.y || 0) - (node.y || 0));
        if (d <= radius && (!best || d < best.distance)) best = {node:other, distance:d};
    });
    return best;
}
function normalizeMethodGroup(g, groupId) {
    if (!groupId) return;
    const members = g.nodes.filter(n => isMethodNode(n) && n.mergeGroup === groupId)
        .sort((a,b) => (a.y||0)-(b.y||0) || String(a.id).localeCompare(String(b.id)));
    if (members.length < 2) { members.forEach(n => n.mergeGroup = null); return; }
    const base = members[0];
    members.forEach((n,i) => { n.x = base.x; n.y = base.y + i * 76; });
}
function mergeMethodNodes(nodeId, targetId) {
    const g = ensureGraph();
    const node = g.nodes.find(n => n.id === nodeId), target = g.nodes.find(n => n.id === targetId);
    if (!node || !target || !isMethodNode(node) || !isMethodNode(target)) return;
    const targetGroup = target.mergeGroup;
    const nodeGroup = node.mergeGroup;
    const group = targetGroup || nodeGroup || `evo-method-group:${Date.now()}`;
    const targetMembers = g.nodes.filter(n => isMethodNode(n) && (targetGroup ? n.mergeGroup === targetGroup : n.id === target.id));
    const nodeMembers = g.nodes.filter(n => isMethodNode(n) && (nodeGroup ? n.mergeGroup === nodeGroup : n.id === node.id));
    const ordered = [...targetMembers, ...nodeMembers.filter(n => !targetMembers.includes(n))];
    ordered.forEach(n => n.mergeGroup = group);
    // The node being dragged is always appended to the bottom of the stack.
    const base = targetMembers[0] || target;
    const gap = getNodeSize().h;
    ordered.forEach((n, i) => { n.x = base.x; n.y = base.y + i * gap; });
}
function maybeMergeMethodNode(nodeId) {
    const g = ensureGraph(), node = g.nodes.find(n => n.id === nodeId);
    if (!node || !isMethodNode(node)) return;
    const target = findMethodMergeTarget(g,node);
    if (target) mergeMethodNodes(node.id,target.node.id);
    else if (node.mergeGroup) { const old=node.mergeGroup; node.mergeGroup=null; normalizeMethodGroup(g,old); }
    persistEvolutionGraph();
    renderEvolutionBoard();
}

function evolutionItemSlug(name) {
    return String(name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
}
function evolutionItemIcon(name) {
    const custom = (state.customItems || []).find(x => x?.name && x.name.toLowerCase() === String(name || '').toLowerCase());
    if (custom?.artwork) return custom.artwork;
    const slug = evolutionItemSlug(name);
    return slug ? `https://play.pokemonshowdown.com/sprites/itemicons/${slug}.png` : '';
}
function renderEvolutionMethodItemOptions(items) {
    const menu=document.getElementById('evolution-method-item-options');
    if(!menu) return;
    if(!items.length) {
        menu.innerHTML='<div class="autocomplete-item"><span>No matches</span></div>';
        return;
    }
    menu.innerHTML=items.map((item,i)=>{
        const icon=evolutionItemIcon(item.name);
        const desc=String(item.desc || '').trim();
        const isCustom = item.source === 'custom' || item.custom === true;
        return `<div class="autocomplete-item evo-method-item-option${isCustom?' evo-method-custom-item':''}" data-index="${i}">` +
            `<span class="evo-method-item-main">${icon?`<img src="${esc(icon)}" alt="" class="evo-method-item-icon" onerror="this.style.display='none'">`:''}<span>${esc(item.name)}</span></span>` +
            `${desc?`<span class="meta">${esc(desc.length>70?desc.slice(0,67)+'...':desc)}</span>`:''}` +
            `</div>`;
    }).join('');
    menu.querySelectorAll('.evo-method-item-option').forEach((el,i)=>{
        el.addEventListener('mousedown',e=>{
            e.preventDefault();
            const item=items[i];
            updateEvolutionMethodCombobox(item?.name || '');
            closeEvolutionMethodItemMenu();
        });
    });
}
function populateEvolutionMethodItems(query='') {
    const q=String(query||'').trim().toLowerCase();
    const vanilla = Object.values(state.sdItems||{})
        .filter(x=>x?.name)
        .map(x=>({...x, source:'vanilla'}));
    const custom = (state.customItems || [])
        .filter(x=>x?.name)
        .map(x=>({...x, source:'custom', custom:true}));
    const seen = new Set();
    const items = [...custom, ...vanilla]
        .filter(x=>!q || x.name.toLowerCase().includes(q))
        .filter(x=>{
            const key=x.name.toLowerCase();
            if(seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0,8);
    renderEvolutionMethodItemOptions(items);
}
function updateEvolutionMethodCombobox(value='') {
    const input=document.getElementById('evolution-method-value');
    const icon=document.getElementById('evolution-method-value-icon');
    if(input) input.value=value;
    if(icon) {
        const src=evolutionItemIcon(value);
        icon.src=src;
        icon.style.display=src ? '' : 'none';
    }
}
function filterEvolutionMethodItems() {
    const input=document.getElementById('evolution-method-value');
    if(!input) return;
    populateEvolutionMethodItems(input.value);
    document.getElementById('evolution-method-item-options')?.classList.add('open');
}
function closeEvolutionMethodItemMenu() { document.getElementById('evolution-method-item-options')?.classList.remove('open'); }
function toggleEvolutionMethodTypeDropdown() {
    document.getElementById('evolution-method-type-dropdown')?.classList.toggle('open');
}
function openEvolutionMethodItemMenu() { document.getElementById('evolution-method-item-options')?.classList.add('open'); }
function setEvolutionMethodType(type, label) {
    const input=document.getElementById('evolution-method-type');
    const value=document.getElementById('evolution-method-type-value');
    if(input) input.value=type;
    if(value) value.textContent=label;
    document.getElementById('evolution-method-type-dropdown')?.classList.remove('open');
    updateEvolutionMethodForm();
}
function updateEvolutionMethodForm() {
    const type=document.getElementById('evolution-method-type')?.value||'level';
    const level=document.getElementById('evolution-method-level-wrap'), value=document.getElementById('evolution-method-value-wrap'), desc=document.getElementById('evolution-method-description-wrap');
    if(level) level.style.display=type==='level'?'':'none';
    if(value) value.style.display=type==='item'?'':'none';
    if(desc) desc.style.display=type==='custom'?'':'none';
    const label=document.getElementById('evolution-method-value-label');
    if(label) label.textContent='Item';
}
function openEvolutionMethodEditor(nodeId=null) {
    const modal=document.getElementById('evolution-method-modal'); if(!modal) return;
    const node=nodeId?ensureGraph().nodes.find(n=>n.id===nodeId):null;
    modal.dataset.nodeId=node?.id||'';
    const initialType=node?.methodType||'level';
    const initialLabel=initialType==='item'?'By Item':initialType==='custom'?'Custom Method':'By Level';
    document.getElementById('evolution-method-type').value=initialType;
    document.getElementById('evolution-method-type-value').textContent=initialLabel;
    document.getElementById('evolution-method-level').value=node?.methodType==='level'?(node.value||16):16;
    document.getElementById('evolution-method-value').value=node?.value||'';
    document.getElementById('evolution-method-description').value=node?.description||'';
    updateEvolutionMethodCombobox(node?.value||'');
    document.getElementById('evolution-method-modal-title').textContent=node?'Edit Evo Method':'Add Evo Method';
    populateEvolutionMethodItems(''); updateEvolutionMethodForm(); modal.classList.add('active');
}
function saveEvolutionMethod() {
    const modal=document.getElementById('evolution-method-modal'), g=ensureGraph();
    const type=document.getElementById('evolution-method-type')?.value||'level';
    let node=g.nodes.find(n=>n.id===modal?.dataset.nodeId);
    if(!node) { const i=getMethodNodes(g).length; node={id:methodNodeId(),kind:'method',methodType:type,value:'',description:'',mergeGroup:null,x:280+(i%3)*205,y:190+Math.floor(i/3)*100}; g.nodes.push(node); }
    node.methodType=type;
    node.value=type==='level'?Math.max(1,Math.min(100,Number(document.getElementById('evolution-method-level')?.value)||1)):(type==='item'?String(document.getElementById('evolution-method-value')?.value||'').trim():'');
    node.description=type==='custom'?String(document.getElementById('evolution-method-description')?.value||'').trim():'';
    modal?.classList.remove('active'); persistEvolutionGraph(); renderEvolutionBoard();
}
function removeEvolutionMethod(id) {
    const g=ensureGraph(), node=g.nodes.find(n=>n.id===id); if(!node) return;
    const group=node.mergeGroup; g.nodes=g.nodes.filter(n=>n.id!==id); g.edges=g.edges.filter(e=>e.from!==id&&e.to!==id); normalizeMethodGroup(g,group); persistEvolutionGraph(); renderEvolutionBoard();
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
        if (isMethodNode(n)) {
            el.className = `evo-node evo-method-node${n.mergeGroup ? ' evo-method-merged' : ''}`;
            el.dataset.nodeId=n.id; el.style.width=`${NODE_W}px`; el.style.minHeight=`${NODE_H}px`;
            el.style.left=`${Math.max(4,Math.min(W-NODE_W-4,n.x||20))}px`; el.style.top=`${Math.max(4,Math.min(H-NODE_H-4,n.y||20))}px`;
            el.innerHTML=`<button class="evo-handle evo-handle-left" type="button" title="Connect from previous node"></button>
                <div class="evo-method-head"><span><span class="evo-method-kicker">EVO METHOD</span><strong>${esc(getMethodLabel(n))}</strong></span>
                <span style="display:flex;align-items:center;gap:4px;">${n.mergeGroup?'<span class="evo-method-stack-mark" title="Merged method group">◆</span>':''}<button class="evo-method-edit" type="button" title="Edit method">✎</button><button class="evo-remove" type="button" title="Remove">×</button></span></div>
                <div class="evo-method-summary">${esc(getMethodSummary(n))}</div>
                <button class="evo-handle evo-handle-right" type="button" title="Connect to next node"></button>`;
            el.addEventListener('pointerdown',e=>startNodeDrag(e,n.id));
            el.querySelectorAll('.evo-handle').forEach(h=>h.addEventListener('pointerdown',e=>startHandleDrag(e,n.id,h.classList.contains('evo-handle-left')?'left':'right')));
            el.querySelector('.evo-method-edit')?.addEventListener('click',e=>{e.stopPropagation();openEvolutionMethodEditor(n.id);});
            el.querySelector('.evo-remove')?.addEventListener('click',e=>{e.stopPropagation();removeEvolutionMethod(n.id);});
            board.appendChild(el); return;
        }
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
            <div class="evo-node-name">
              <strong>${esc(info.name)}</strong>
              <small>${esc(info.species || '')}</small>
              <span class="evo-node-types">${(info.types || []).map(t => `<span class="type-pill type-${String(t).toLowerCase()}">${esc(t)}</span>`).join('')}</span>
              ${tags.length ? `<em>${esc(tags.join(' · '))}</em>` : ''}
            </div>
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
    return collapseMethodEdges(g).map(e => {
        const toNode=g.nodes.find(n=>n.id===e.to);
        if(toNode && isSpecialNode(toNode)) return {from:e.to,to:e.from};
        return {from:e.from,to:e.to};
    });
}


function drawEvolutionEdges() {
    const board = document.getElementById('evolution-board');
    const svg = board?.querySelector('.evo-wires');
    if (!board || !svg) return;
    const g = ensureGraph();
    const { w: NODE_W, h: NODE_H } = getNodeSize();
    const br = board.getBoundingClientRect();
    // Use the actual rendered handle centers rather than assuming every node
    // has the same height. Method cards intentionally have a different visual
    // layout, and CSS can change their height at breakpoints. Reading the
    // handle geometry keeps every wire/arrow exactly centered on its node.
    const getHandlePoint = (node, side) => {
        const el = board.querySelector(`.evo-node[data-node-id=\"${CSS.escape(node.id)}\"] .evo-handle-${side}`);
        if (el) {
            const r = el.getBoundingClientRect();
            return { x: r.left - br.left + r.width / 2, y: r.top - br.top + r.height / 2 };
        }
        const x = (node.x || 0) + (side === 'right' ? NODE_W : 0);
        const y = (node.y || 0) + NODE_H / 2;
        return { x, y };
    };
    svg.setAttribute('viewBox', `0 0 ${Math.max(br.width, NODE_W + 40)} ${Math.max(br.height, NODE_H + 40)}`);
    const defs = `<defs><marker id="evo-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>`;
    svg.innerHTML = defs;
    if (handleDrag) {
        const sourceNode = g.nodes.find(n => n.id === handleDrag.nodeId);
        if (sourceNode) {
            const sourcePoint = getHandlePoint(sourceNode, handleDrag.side);
            const sx = sourcePoint.x;
            const sy = sourcePoint.y;
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
        const fromPoint = getHandlePoint(a, 'right');
        const toPoint = getHandlePoint(b, 'left');
        const ax = fromPoint.x, ay = fromPoint.y;
        const bx = toPoint.x, by = toPoint.y;
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
    const nodeH=NODE_H;
    n.y = Math.max(4, Math.min(r.height-nodeH-4, e.clientY-r.top-drag.oy));
    const el = board.querySelector(`.evo-node[data-node-id=\"${CSS.escape(drag.id)}\"]`);
    if (el) { el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; }
    drawEvolutionEdges();
});
function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx=x2-x1, dy=y2-y1, len2=dx*dx+dy*dy;
    if (!len2) return {distance:Math.hypot(px-x1,py-y1),t:0,x:x1,y:y1};
    const t=Math.max(0,Math.min(1,((px-x1)*dx+(py-y1)*dy)/len2));
    const x=x1+t*dx, y=y1+t*dy;
    return {distance:Math.hypot(px-x,py-y),t,x,y};
}
function cubicPoint(t,p0,p1,p2,p3){
    const mt=1-t;
    return {x:mt*mt*mt*p0.x+3*mt*mt*t*p1.x+3*mt*t*t*p2.x+t*t*t*p3.x,
            y:mt*mt*mt*p0.y+3*mt*mt*t*p1.y+3*mt*t*t*p2.y+t*t*t*p3.y};
}
function findNearestEvolutionWire(x,y,ignoreNodeId){
    const g=ensureGraph(), {w:NODE_W,h:NODE_H}=getNodeSize(); let best=null;
    g.edges.forEach(edge=>{
        if(edge.from===ignoreNodeId||edge.to===ignoreNodeId)return;
        const a=g.nodes.find(n=>n.id===edge.from),b=g.nodes.find(n=>n.id===edge.to); if(!a||!b)return;
        const ax=(a.x||0)+NODE_W,ay=(a.y||0)+NODE_H/2,bx=b.x||0,by=(b.y||0)+NODE_H/2,dx=Math.max(30,Math.abs(bx-ax)*.45);
        let prev={x:ax,y:ay},local=null,steps=28;
        for(let i=1;i<=steps;i++){
            const t=i/steps,cur=cubicPoint(t,{x:ax,y:ay},{x:ax+dx,y:ay},{x:bx-dx,y:by},{x:bx,y:by});
            const hit=pointToSegmentDistance(x,y,prev.x,prev.y,cur.x,cur.y);
            if(!local||hit.distance<local.distance)local={distance:hit.distance,t:(i-1+hit.t)/steps,x:hit.x,y:hit.y};
            prev=cur;
        }
        const threshold=Math.max(34,NODE_W*.22);
        if(local&&local.distance<=threshold&&(!best||local.distance<best.distance))best={edge,distance:local.distance,x:local.x,y:local.y};
    });
    return best;
}
function insertNodeIntoWire(nodeId,hit){
    const g=ensureGraph(),node=g.nodes.find(n=>n.id===nodeId),edge=hit?.edge;
    if(!node||!edge||edge.from===nodeId||edge.to===nodeId)return false;
    const idx=g.edges.indexOf(edge); if(idx<0)return false;
    const size=getNodeSize();
    const first={...edge,to:nodeId,fromSide:'right',toSide:'left'};
    const second={...edge,from:nodeId,to:edge.to,fromSide:'right',toSide:'left'};
    node.x=Math.max(4,hit.x-size.w/2); node.y=Math.max(4,hit.y-size.h/2);
    g.edges.splice(idx,1,first,second); return true;
}
document.addEventListener('pointerup', () => {
    if (!drag) return;
    const id=drag.id; drag=null;
    const g=ensureGraph(),node=g.nodes.find(n=>n.id===id);
    if(!node){persistEvolutionGraph();return;}
    const size=getNodeSize(),hit=findNearestEvolutionWire((node.x||0)+size.w/2,(node.y||0)+size.h/2,id);
    if(hit&&insertNodeIntoWire(id,hit)){persistEvolutionGraph();renderEvolutionBoard();return;}
    maybeMergeMethodNode(id);
});

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
    g.nodes=g.nodes.filter(n=>n.id!==id);
    g.edges=g.edges.filter(e=>e.from!==id&&e.to!==id);

    // Remove the node from every saved Fakemon graph as well. Otherwise an old
    // participant can later reopen its stale copy of the graph and resurrect the
    // removed Pokémon.
    (state.fakemonDB || []).forEach(f => {
        if (!f?.evolutionGraph?.nodes) return;
        const ng = clone(f.evolutionGraph);
        ng.nodes = (ng.nodes || []).filter(n => n.id !== id);
        ng.edges = (ng.edges || []).filter(e => e.from !== id && e.to !== id);
        f.evolutionGraph = ng;
    });

    persistEvolutionGraph();
    renderEvolutionBoard();
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

function sanitizeEvolutionGraphForCurrent(graph) {
    const g = graph ? clone(graph) : DEFAULT_GRAPH();
    if (!Array.isArray(g.nodes)) g.nodes = [];
    if (!Array.isArray(g.edges)) g.edges = [];
    const current = currentNodeId();
    // Keep only nodes that belong to the connected component containing the
    // currently edited Fakemon. This prevents stale graphs copied onto older
    // Fakemon records from resurrecting unrelated species in the editor.
    if (g.nodes.some(n => n.id === current)) {
        const adjacency = new Map();
        g.nodes.forEach(n => adjacency.set(n.id, []));
        g.edges.forEach(e => {
            if (!adjacency.has(e.from) || !adjacency.has(e.to)) return;
            adjacency.get(e.from).push(e.to);
            adjacency.get(e.to).push(e.from);
        });
        const keep = new Set([current]);
        const queue = [current];
        while (queue.length) {
            const id = queue.shift();
            for (const next of adjacency.get(id) || []) {
                if (!keep.has(next)) { keep.add(next); queue.push(next); }
            }
        }
        g.nodes = g.nodes.filter(n => keep.has(n.id));
        g.edges = g.edges.filter(e => keep.has(e.from) && keep.has(e.to));
    } else {
        g.nodes = [];
        g.edges = [];
    }
    return g;
}

function initializeEvolutionGraph(graph) {
    state.evolutionGraph = sanitizeEvolutionGraphForCurrent(graph);
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

document.addEventListener('click', e => {
    const typeOption=e.target.closest('#evolution-method-type-menu .type-dropdown-option');
    if(typeOption) { setEvolutionMethodType(typeOption.dataset.value || 'custom', typeOption.textContent.trim()); return; }
    const option=e.target.closest('.evo-method-item-option');
    if(option) { closeEvolutionMethodItemMenu(); }
});

document.addEventListener('click', e => {
    if(!e.target.closest('#evolution-method-type-dropdown')) document.getElementById('evolution-method-type-dropdown')?.classList.remove('open');
    if(!e.target.closest('.evo-combobox')) closeEvolutionMethodItemMenu();
});

document.addEventListener('click', e => {
    if (e.target.closest('#evolution-method-type-trigger')) {
        e.stopPropagation();
        toggleEvolutionMethodTypeDropdown();
    }
});

const evolutionMethodItemInput = document.getElementById('evolution-method-value');
if (evolutionMethodItemInput) {
    evolutionMethodItemInput.addEventListener('focus', () => {
        populateEvolutionMethodItems(evolutionMethodItemInput.value);
        openEvolutionMethodItemMenu();
    });
    evolutionMethodItemInput.addEventListener('input', () => filterEvolutionMethodItems());
    evolutionMethodItemInput.addEventListener('blur', () => setTimeout(closeEvolutionMethodItemMenu, 180));
}

export { ensureGraph, calculateStages as calculateEvolutionStages, onFakemonSaved, renderEvolutionBoard, openEvolutionNodeChooser, renderEvolutionNodeChooser, addEvolutionNode, removeEvolutionNode, initializeEvolutionGraph, toggleEvolutionMode, syncEvolutionOnBasicLoad, persistEvolutionGraph, shareSpecialPropertiesWithChild, openEvolutionMethodEditor, updateEvolutionMethodForm, saveEvolutionMethod, removeEvolutionMethod, populateEvolutionMethodItems };

// Re-layout the board when the viewport crosses the mobile breakpoint (e.g.
// on rotation), since node size and spacing depend on window width.
let resizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (document.getElementById('evolution-board')) renderEvolutionBoard();
    }, 150);
});