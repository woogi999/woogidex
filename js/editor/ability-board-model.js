// ==================== the shape of the block board ====================
// Board layout/container logic, split out from the render functions so it's
// testable without building markup. Container registry is now built by
// walking the AST up front rather than as a side effect of rendering, since
// a render can run twice (or not at all) under React.

/**
 * Maps every container id to the live array it stands for (not copies —
 * dropping a block splices into what this returns).
 *
 * Container ids are derived, not stored:
 *   'root-events'      the top-level event stack
 *   'loose'            blocks sitting on the board outside any event
 *   '<id>:body'        an event's body
 *   '<id>:then'        an if block's true branch
 *   '<id>:else'        an if block's false branch
 *
 * @param {Record<string, Array>} roots the named top-level containers
 * @returns {Record<string, Array>}
 */
export function buildContainerRegistry(roots) {
    const registry = {};

    const walk = (list, id) => {
        if (!Array.isArray(list)) return;
        registry[id] = list;
        for (const block of list) {
            if (!block) continue;
            if (block.kind === 'event') {
                if (!Array.isArray(block.body)) block.body = [];
                walk(block.body, block.id + ':body');
            } else if (block.kind === 'if') {
                if (!Array.isArray(block.then)) block.then = [];
                // else branch normalized to [] rather than null so it can still grow one
                if (!Array.isArray(block.else)) block.else = [];
                walk(block.then, block.id + ':then');
                walk(block.else, block.id + ':else');
            }
        }
    };

    for (const [id, list] of Object.entries(roots || {})) walk(list, id);
    return registry;
}

/** Whether a container positions blocks freely (vs. nested ones, which snap into a socket). */
export function isFreeContainer(containerId) {
    return containerId === 'root' || containerId === 'loose' || containerId === 'root-events';
}

/** Gives a block a position if missing (else all unpositioned blocks stack at 0,0), coercing malformed ones to numbers. */
export function ensureBlockPosition(block, index = 0, depth = 0) {
    if (!block.pos || !Number.isFinite(Number(block.pos.x)) || !Number.isFinite(Number(block.pos.y))) {
        const col = index % 3;
        const row = Math.floor(index / 3);
        block.pos = {
            x: depth ? 12 : 28 + col * 230,
            y: depth ? 12 + row * 96 : 28 + row * 118
        };
    }
    block.pos.x = Number(block.pos.x) || 0;
    block.pos.y = Number(block.pos.y) || 0;
    return block.pos;
}

/** Which palette group a block belongs to (drives its colour); falls back to category rather than undefined. */
export function blockCategory(action, { BLOCK_GROUPS = [], ACTIONS = {} } = {}) {
    for (const group of BLOCK_GROUPS) {
        if ((group.items || []).includes(action)) return group.label;
    }
    return ACTIONS?.[action]?.category || 'Battle Actions';
}

/** CSS class css/ability-blocks.css keys a category's colour off. */
export function categoryClass(label) {
    return 'ab-category-' + String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * Splits an action's label template ("raise __ by __") into text chunks and
 * the parameter slots between them. Final chunk never carries a slot.
 * @returns {{text: string, param: object|null}[]}
 */
export function splitParamTemplate(template, paramDefs = []) {
    const parts = String(template ?? '').split('__');
    let next = 0;
    return parts.map((text, idx) => {
        if (idx === parts.length - 1) return { text, param: null };
        return { text, param: paramDefs[next++] || null };
    });
}

/**
 * Curves drawn between consecutive event blocks, showing execution order.
 * @param {{x:number,y:number,width:number,height:number}[]} boxes
 * @returns {string[]} SVG path `d` attributes
 */
export function buildConnectorPaths(boxes) {
    const paths = [];
    for (let i = 0; i < boxes.length - 1; i++) {
        const a = boxes[i], b = boxes[i + 1];
        if (!a || !b) continue;
        const x1 = a.x + a.width / 2;
        const y1 = a.y + a.height;
        const x2 = b.x + b.width / 2;
        const y2 = b.y;
        // bow out by at least 18px so near-level blocks still get a visible arc
        const mid = y1 + Math.max(18, (y2 - y1) / 2);
        paths.push(`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`);
    }
    return paths;
}
