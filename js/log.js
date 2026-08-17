// ==================== Woogidex diagnostic log ====================
// single logging/diagnostics surface for the entire application.
// other modules should not call console.* directly; use log.* instead.
const STORAGE_KEY = 'woogidex-log-enabled';
const VERBOSE_KEY = 'woogidex-log-verbose';
const MAX_HISTORY = 500;

function readBool(key, fallback = true) {
    try {
        const value = localStorage.getItem(key);
        return value == null ? fallback : value === 'true';
    } catch (_) { return fallback; }
}

const bootTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
const config = { enabled: readBool(STORAGE_KEY, true), verbose: readBool(VERBOSE_KEY, true), minLevel: 'debug' };
const history = [];
let context = { state: null, api: null };
const timers = new Map();

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
function stamp() { return `+${(now() - bootTime).toFixed(1)}ms`; }
function safeClone(value) {
    if (value === undefined || value === null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}
function prefix(scope, level) { return [`%c[${scope}]`, 'font-weight:700', level.toUpperCase(), stamp()]; }
function pushHistory(level, scope, message, data) {
    history.push({ time: new Date().toISOString(), elapsed: stamp(), level, scope, message, data: safeClone(data) });
    if (history.length > MAX_HISTORY) history.shift();
}
function emit(level, scope, message, data) {
    if (!config.enabled || LEVELS[level] < LEVELS[config.minLevel]) return;
    if (level === 'debug' && !config.verbose) return;
    pushHistory(level, scope, message, data);
    const method = console[level] || console.log;
    const args = prefix(scope, level);
    args.push(message);
    if (data !== undefined) args.push(data);
    method(...args);
}

function commandHelp() {
    return {
        logging: 'enable | disable | verbose [on|off] | level [debug|info|warn|error]',
        inspection: 'state | status | fakemon | learnset | custommoves | move <name> | flags <name> | showdown | storage | db | modules',
        diagnostics: 'history [n] | errors | scopes | timers | perf | dom [selector] | settings | api | network | memory | events | dump',
        actions: 'refresh | render | autosave | clearhistory | snapshot | clear | reload | copy <text>',
        utilities: 'help [topic] | trace <scope> | untrace <scope> | find <text> | eval <javascript>',
        analysis: 'analysis | matchup | row <pokemon> | rows [n] | impact [n] | good | bad | analysisjson',
        samples: 'sample | sample profile | sample roles | sample sets | sample trace [on|off] | sample generate',
        aliases: 'log(...) is the console command interface; WoogidexLog.run(...) is the full form'
    };
}

function findMove(name) {
    const state = context.state;
    if (!state) return null;
    const needle = String(name || '').trim().toLowerCase();
    if (!needle) return null;
    const moves = state.sdMoves || {};
    const exact = Object.values(moves).find(m => String(m.name || '').toLowerCase() === needle);
    if (exact) return exact;
    const custom = (state.learnset || []).find(m => String(m.name || '').toLowerCase() === needle);
    if (custom) return custom;
    return Object.values(moves).find(m => String(m.name || '').toLowerCase().includes(needle)) || null;
}

function run(command, ...rest) {
    if (command && typeof command === 'object') return run(command.command, ...(command.args || []));
    const raw = String(command ?? '').trim();
    if (!raw) return commandHelp();
    const parts = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const cmd = String(parts.shift() || '').toLowerCase();
    const args = parts.concat(rest || []).map(v => String(v).replace(/^"|"$/g, ''));
    const arg = args.join(' ').trim();
    const state = context.state;
    const api = context.api;

    const out = (label, value) => { emit('info', 'COMMAND', label, value); return value; };
    try {
        switch (cmd) {
            case 'help': return out('Available log/debug commands', commandHelp());
            case 'enable': config.enabled = true; localStorage.setItem(STORAGE_KEY, 'true'); return out('Logging enabled');
            case 'disable': config.enabled = false; localStorage.setItem(STORAGE_KEY, 'false'); return out('Logging disabled');
            case 'verbose': config.verbose = args[0] ? /^(on|true|1)$/i.test(args[0]) : !config.verbose; localStorage.setItem(VERBOSE_KEY, String(config.verbose)); return out(`Verbose logging ${config.verbose ? 'enabled' : 'disabled'}`);
            case 'level': if (args[0] && LEVELS[args[0]]) config.minLevel = args[0]; return out('Log level', config.minLevel);
            case 'state': return out('Application state', state);
            case 'status': return out('Application status', { sdLoaded: !!state?.sdLoaded, fakemons: state?.fakemonDB?.length || 0, learnset: state?.learnset?.length || 0, editingId: state?.editingId, folder: state?.currentFolderId });
            case 'fakemon': return out('Current Fakemon', state?.fakemonDB?.find(f => f.id === state.editingId) || null);
            case 'learnset': return out('Current learnset', state?.learnset || []);
            case 'custommoves': return out('Custom moves', state?.customMoves || (state?.learnset || []).filter(m => m.custom));
            case 'move': { const m = findMove(arg); return out(m ? `Move: ${m.name}` : 'Move not found', m); }
            case 'flags': { const m = findMove(arg); if (!m) return out('Move not found'); const sd = Object.values(state?.sdMoves || {}).find(x => x.name === m.name); return out(`Flags: ${m.name}`, { stored: m.flags, showdownFlags: sd?.flags, multihit: sd?.multihit ?? m.multihit, pivot: m.pivot }); }
            case 'analysis': return out('Last analysis snapshot', window.__lastAnalysis || null);
            case 'analysisjson': return out('Last analysis JSON', safeClone(window.__lastAnalysis || null));
            case 'matchup': return out('Last matchup profile', window.__lastMatchup || null);
            case 'row': {
                const rows = window.__lastMatchup?.rows || [];
                const needle = arg.toLowerCase();
                const exact = rows.find(r => String(r?.p?.name || '').toLowerCase() === needle);
                const hit = exact || rows.find(r => String(r?.p?.name || '').toLowerCase().includes(needle));
                return out(hit ? `Matchup row: ${hit.p.name}` : `Matchup row not found: ${arg}`, hit || null);
            }
            case 'rows': return out('Matchup rows', (window.__lastMatchup?.rows || []).slice(0, Math.max(1, Math.min(500, Number(args[0]) || 50))));
            case 'impact': return out('Matchups sorted by impact', (window.__lastMatchup?.sortedByImpact || []).slice(0, Math.max(1, Math.min(100, Number(args[0]) || 25))));
            case 'good': return out('Favorable matchups', window.__lastMatchup?.good || []);
            case 'bad': return out('Unfavorable matchups', window.__lastMatchup?.bad || []);
            case 'sample': return out('Last sample-set generation', window.__lastSampleSetGeneration || null);
            case 'sample profile': return out('Sample-set profile', window.__lastSampleSetGeneration?.profile || window.__getSampleSetProfile?.() || null);
            case 'sample roles': return out('Sample-set role scoring', { roles: window.__lastSampleSetGeneration?.roles || null, roleScores: window.__lastSampleSetGeneration?.roleScores || window.__getSampleRoleScores?.() || null, rankedRoles: window.__lastSampleSetGeneration?.rankedRoles || null });
            case 'sample sets': return out('Generated sample sets', window.__lastSampleSetGeneration?.result || state?.sampleSets || []);
            case 'sample trace': {
                const mode = args[0] ? /^(on|true|1)$/i.test(args[0]) : !(window.__sampleSetDebug === true);
                window.__sampleSetDebug = mode;
                return out(`Sample-set debug tracing ${mode ? 'enabled for the next generation' : 'disabled'}`, { enabled: mode, oneShot: true, note: mode ? 'The trace automatically disables after one generation.' : '' });
            }
            case 'sample generate': {
                if (typeof window.__generateSuggestedSampleSets !== 'function') return out('Sample generator is not available');
                const result = window.__generateSuggestedSampleSets(true);
                return out('Sample sets regenerated', result);
            }
            case 'eval': {
                const expr = [arg, ...rest].filter(Boolean).join(' ').trim();
                if (!expr) return out('Usage', 'log("eval window.__lastMatchup.rows.find(r => r.p.name.includes(\"Gliscor\"))")');
                try {
                    let value;
                    try { value = Function('window','state','api','log', `"use strict"; return (${expr})`)(window, state, api, log); }
                    catch (_) { value = Function('window','state','api','log', `"use strict"; ${expr}`)(window, state, api, log); }
                    return out(`Eval: ${expr}`, value);
                } catch (error) {
                    emit('error', 'COMMAND', `Eval failed: ${expr}`, error);
                    return undefined;
                }
            }
            case 'showdown': return out('Showdown dataset status', { loaded: state?.sdLoaded, moves: Object.keys(state?.sdMoves || {}).length, abilities: Object.keys(state?.sdAbilities || {}).length, items: Object.keys(state?.sdItems || {}).length, species: Object.keys(state?.sdPokedex || {}).length, learnsets: Object.keys(state?.sdLearnsets || {}).length });
            case 'storage': return out('Storage state', { db: 'WoogidexDB', fakemons: state?.fakemonDB?.length || 0, folders: state?.folders?.length || 0, lastSavedId: state?.lastSavedId });
            case 'history': return out('Log history', history.slice(-Math.max(1, Math.min(500, Number(args[0]) || 50))));
            case 'errors': return out('Recent errors', history.filter(x => x.level === 'error').slice(-50));
            case 'scopes': return out('Known scopes', [...new Set(history.map(x => x.scope))].sort());
            case 'timers': return out('Active timers', [...timers.entries()].map(([k,v]) => ({ label: k, elapsedMs: now() - v }))); 
            case 'perf': return out('Performance', { navigation: performance?.getEntriesByType?.('navigation')?.[0], resources: performance?.getEntriesByType?.('resource')?.slice(-20) });
            case 'dom': return out(`DOM query: ${arg || 'body'}`, [...document.querySelectorAll(arg || 'body')]);
            case 'settings': return out('Debug settings', { enabled: config.enabled, verbose: config.verbose, minLevel: config.minLevel, localStorageKeys: Object.keys(localStorage).filter(k => k.startsWith('woogidex-')) });
            case 'api': return out('Public API', api);
            case 'refresh': api?.renderCollection?.(); api?.renderLearnset?.(); api?.updatePreview?.(); return out('Refresh requested');
            case 'render': api?.renderLearnset?.(); api?.renderCustomMoves?.(); api?.updatePreview?.(); return out('Editor rendering requested');
            case 'autosave': api?.autoSave?.(true); return out('Forced autosave requested');
            case 'clearhistory': history.length = 0; return out('Log history cleared');
            case 'snapshot': return out('Debug snapshot', { status: run('status'), learnset: state?.learnset, current: run('fakemon') });
            case 'trace': if (arg) config.traceScope = arg; return out('Trace scope', config.traceScope || 'none');
            case 'untrace': config.traceScope = null; return out('Trace disabled');
            case 'find': { const q = arg.toLowerCase(); return out(`Log search: ${arg}`, history.filter(x => `${x.scope} ${x.message} ${JSON.stringify(x.data || '')}`.toLowerCase().includes(q)).slice(-100)); }
            case 'copy': if (navigator.clipboard) navigator.clipboard.writeText(arg); return out('Copied command text', arg);
            case 'modules': return out('Loaded modules', [...document.querySelectorAll('script[type=module][src]')].map(s => s.src));
            case 'network': return out('Recent network resources', performance?.getEntriesByType?.('resource')?.slice(-50).map(r => ({name:r.name,duration:r.duration,size:r.transferSize||0}))); 
            case 'memory': return out('Memory usage', performance?.memory ? {usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit} : 'performance.memory unavailable');
            case 'db': return out('Database/storage snapshot', { fakemons: state?.fakemonDB?.length||0, folders: state?.folders?.length||0, currentFolder: state?.currentFolderId, editingId: state?.editingId, lastSavedId: state?.lastSavedId });
            case 'movejson': { const m=findMove(arg); return out(m ? `Move JSON: ${m.name}` : 'Move not found', m ? safeClone(m) : null); }
            case 'learnsetjson': return out('Learnset JSON', safeClone(state?.learnset || []));
            case 'events': return out('Event listener counts', { note: 'Browser does not expose a standard listener enumeration API.', readyState: document.readyState, visibility: document.visibilityState });
            case 'clear': try { console.clear(); } catch (_) {} return out('Console clear requested');
            case 'reload': location.reload(); return out('Reload requested');
            case 'dump': return out('Full diagnostic dump', { status: run('status'), fakemon: state?.fakemonDB?.find(f=>f.id===state?.editingId)||null, learnset: safeClone(state?.learnset||[]), showdown: run('showdown'), settings: run('settings'), errors: history.filter(x=>x.level==='error').slice(-50) });
            default: return out(`Unknown command: ${cmd}`, commandHelp());
        }
    } catch (error) {
        emit('error', 'COMMAND', `Command failed: ${raw}`, error);
        return undefined;
    }
}

export const log = {
    get enabled() { return config.enabled; }, get verbose() { return config.verbose; },
    setEnabled(value) { config.enabled = !!value; try { localStorage.setItem(STORAGE_KEY, String(config.enabled)); } catch (_) {} emit('info','LOGGER',`logging ${config.enabled ? 'enabled' : 'disabled'}`); },
    setVerbose(value) { config.verbose = !!value; try { localStorage.setItem(VERBOSE_KEY, String(config.verbose)); } catch (_) {} emit('info','LOGGER',`verbose logging ${config.verbose ? 'enabled' : 'disabled'}`); },
    setContext(value) { context = { ...context, ...(value || {}) }; },
    info(scope, message, data) { emit('info', scope, message, data); },
    debug(scope, message, data) { emit('debug', scope, message, data); },
    warn(scope, message, data) { emit('warn', scope, message, data); },
    error(scope, message, data) { emit('error', scope, message, data); },
    group(scope, message, data) { if (!config.enabled) return () => {}; console.groupCollapsed(...prefix(scope,'group'), message, data === undefined ? '' : data); return () => console.groupEnd(); },
    time(scope, label) { if (!config.verbose) return () => 0; const start = now(); timers.set(`${scope}:${label}`, start); return data => { const elapsed = now() - start; timers.delete(`${scope}:${label}`); emit('debug', scope, `${label} completed in ${elapsed.toFixed(2)}ms`, data); return elapsed; }; },
    snapshot(scope, label, value) { emit('debug', scope, label, safeClone(value)); },
    history() { return history.slice(); },
    run
};

if (typeof window !== 'undefined') {
    window.WoogidexLog = {
        enable: () => log.setEnabled(true), disable: () => log.setEnabled(false),
        verbose: value => log.setVerbose(value === undefined ? !log.verbose : value),
        state: () => ({ enabled: log.enabled, verbose: log.verbose, minLevel: config.minLevel, history: history.length }),
        run, cmd: run, command: run, help: () => run('help'), log
    };
    window.log = run;
    window.addEventListener('error', event => log.error('GLOBAL', 'Unhandled window error', { message: event.message, source: event.filename, line: event.lineno, column: event.colno, error: event.error }));
    window.addEventListener('unhandledrejection', event => log.error('GLOBAL', 'Unhandled promise rejection', event.reason));
}

log.info('BOOT', 'Central diagnostic log initialized', { enabled: config.enabled, verbose: config.verbose, commands: 'log("help")' });
