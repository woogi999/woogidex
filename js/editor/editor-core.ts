import { log } from '../core/log.ts';
import { state, api } from '../core/app.ts';

import { POKEMON_TYPES, TYPE_EFFECTIVENESS } from '../core/data.ts';
import { getAbilityRole, hydrateLearnsetEntry, isCustomMove, openCustomMoveModal, renderAbilities, renderCustomAbilities, renderCustomMoves, renderLearnset, showMoveDetail, sortLearnset, resetEditingCustomAbilityIndex } from './editor.ts';
import { calcStat, generateShowdownExport, renderSampleSets, sampleMoveIsActuallyUseful } from './sample-sets.ts';
import { cachedFetch } from '../core/net-cache.ts';
import type { StatBlock } from '../app/types.ts';
import { blankForm, clampBaseStat, eggGroupsText, form, formFromFakemon, genderRatioText, heightDisplay, setForm, STAT_KEYS, weightDisplay } from './draft.ts';
import { notify, notifySync } from '../app/store.ts';
import { flushSync } from 'react-dom';
// PokeAPI never rewrites a species entry, so a month is conservative.
const POKEAPI_CACHE = { cacheName: 'woogidex-pokeapi-v1', maxAgeMs: 30 * 86400000 };
// ==================== editor logic ====================
        function getNextPokedexNumber() {
    const used = new Set();
    (state.fakemonDB || []).forEach(f => {
        const raw = String(f?.number || '').trim().replace(/^#/, '');
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) used.add(n);
    });
    let next = 1;
    while (used.has(next)) next++;
    return `#${String(next).padStart(3, '0')}`;
}

function resetEditor() {
            setForm({ ...blankForm(), number: getNextPokedexNumber(), regionIds: [api.defaultRegionForNewFakemon?.()].filter(Boolean) });
            state.abilities = [];
            resetEditingCustomAbilityIndex();
            state.learnset = [];
            state.sampleSets = [];
            state.artworkData = null;
            state.shinyArtworkData = null;
            state.cryData = null;
            state.artCredit = null;
            state.artworkMode = 'normal';
            state.previewArtworkMode = 'normal';
            state.evolutionGraph = null;
            renderAbilities();
            renderLearnset();
            renderCustomMoves();
            renderSampleSets();
            updateStats();
            api.initializeEvolutionGraph?.(null);
            // a blank editor owns no saved record until the first save creates one
            state.editorLoadedId = null;
        }

        function loadFakemonIntoEditor(fakemon) {
            log.info('EDITOR', 'Loading Fakemon into editor', { id: fakemon?.id, name: fakemon?.name, moves: fakemon?.learnset?.length || 0 });
            // Released now and re-claimed at the very end, so a load that throws
            // part way through leaves the editor owning nothing rather than owning
            // a record it only half filled in. autoSave() checks this before it
            // overwrites anything.
            state.editorLoadedId = null;
            setForm(formFromFakemon(fakemon));
            resetEditingCustomAbilityIndex();
            const legacyAbilities = Array.isArray(fakemon.abilities) ? fakemon.abilities : [];
            // `customAbilities` means two things depending on record age: a legacy
            // import's separate list of abilities not in `abilities`, or a published
            // record's embedded block programs for abilities already in `abilities`.
            // Appending unconditionally treated the latter as the former, duplicating
            // every custom ability on save. Only entries not already named are legacy.
            const named = new Set(legacyAbilities
                .map(a => String((typeof a === 'string' ? a : a?.name) || '').trim().toLowerCase())
                .filter(Boolean));
            const legacyCustomAbilities = (Array.isArray(fakemon.customAbilities) ? fakemon.customAbilities : [])
                .filter(a => a?.name && !named.has(String(a.name).trim().toLowerCase()));
            state.abilities = [
                // customId links to the block program in state.customAbilities; losing
                // it would silently strip the link on autosave and mint a duplicate
                // programless entry on next load.
                ...legacyAbilities.map(a => typeof a === 'string' ? { name: a, source: 'sd', desc: '' } : {
                    name: a.name || '', source: a.source || (a.custom ? 'custom' : 'sd'), desc: a.desc || a.description || '',
                    ...(a.customId ? { customId: a.customId, custom: true } : {})
                }),
                ...legacyCustomAbilities.map(a => ({
                    name: a.name || '', source: 'custom', desc: a.desc || a.description || '',
                    ...(a.id ? { customId: a.id, custom: true } : {})
                }))
            ].filter(a => a.name || a.source === 'custom').slice(0, 4);
            // build the unified learnset. explicitly marked custom moves are never sent
            // through Showdown hydration, even if their name happens to match a vanilla move.
            state.learnset = (fakemon.learnset || []).map(m => {
                if (m && (m.source === 'custom' || m.custom === true)) {
                    return {
                        ...m,
                        source: 'custom',
                        custom: true,
                        learnMethod: m.learnMethod || 'none',
                        level: m.learnMethod === 'level' ? (m.level || null) : null,
                        flags: m.flags || {}
                    };
                }
                return hydrateLearnsetEntry(m);
            });
            // migrate legacy standalone custom moves into the unified learnset.
            const legacyCustomMoves = Array.isArray(fakemon.customMoves) ? fakemon.customMoves : [];
            legacyCustomMoves.forEach(m => {
                if (!m || !m.name) return;
                const exists = state.learnset.some(x => x.name === m.name && isCustomMove(x));
                if (!exists) state.learnset.push({
                    ...m,
                    source: 'custom',
                    custom: true,
                    learnMethod: m.learnMethod || 'none',
                    level: m.learnMethod === 'level' ? (m.level || null) : null,
                    flags: m.flags || {}
                });
            });
            sortLearnset();
            state.sampleSets = fakemon.sampleSets || [];
            state.artworkData = fakemon.artwork || null;
            state.shinyArtworkData = fakemon.shinyArtwork || null;
            state.cryData = fakemon.cry || null;
            state.artCredit = fakemon.artCredit || null;
            state.artworkMode = 'normal';
            state.previewArtworkMode = 'normal';
            renderAbilities();
            renderCustomAbilities();
            renderLearnset();
            renderCustomMoves();
            renderSampleSets();
            api.initializeEvolutionGraph?.(fakemon.evolutionGraph || null);
            updateStats();
            // fully populated: the editor now owns this record and may save over it
            state.editorLoadedId = fakemon.id ?? null;
        }

        
// ==================== stat input validation ====================
        // kept under its old name for the modules that import it
        const clampBaseStatValue = clampBaseStat;

// ==================== stat templates ====================
        // Quick-start stat spreads for common competitive/thematic archetypes.
        // Base stat total is left up to the user afterward - these are just
        // starting shapes, not a "correct" BST for any particular tier.
        const STAT_TEMPLATES = [
            { id: 'balanced',      label: 'Balanced',        stats: { hp: 80, atk: 80,  def: 80,  spa: 80,  spd: 80,  spe: 80  } },
            { id: 'glass-cannon',  label: 'Glass Cannon',    stats: { hp: 55, atk: 130, def: 55,  spa: 60,  spd: 60,  spe: 110 } },
            { id: 'special-glass', label: 'Special Attacker', stats: { hp: 60, atk: 55,  def: 60,  spa: 130, spd: 65,  spe: 100 } },
            { id: 'physical-wall', label: 'Physical Wall',   stats: { hp: 110,atk: 60,  def: 140, spa: 55,  spd: 80,  spe: 45  } },
            { id: 'special-wall',  label: 'Special Wall',    stats: { hp: 110,atk: 60,  def: 80,  spa: 55,  spd: 140, spe: 45  } },
            { id: 'mixed-tank',    label: 'Mixed Tank',      stats: { hp: 100,atk: 85,  def: 90,  spa: 85,  spd: 90,  spe: 60  } },
            { id: 'speedster',     label: 'Speedster',       stats: { hp: 60, atk: 90,  def: 55,  spa: 60,  spd: 65,  spe: 130 } },
            { id: 'trick-room',    label: 'Trick Room',      stats: { hp: 110,atk: 120, def: 90,  spa: 70,  spd: 90,  spe: 25  } },
            { id: 'support',       label: 'Bulky Support',   stats: { hp: 95, atk: 55,  def: 95,  spa: 65,  spd: 105, spe: 55  } },
            { id: 'pivot',         label: 'Fast Pivot',      stats: { hp: 70, atk: 75,  def: 70,  spa: 75,  spd: 70,  spe: 115 } },
            { id: 'legendary',     label: 'Legendary (High BST)', stats: { hp: 106,atk: 130, def: 90,  spa: 110, spd: 90,  spe: 104 } },
            { id: 'starter-final', label: 'Starter (Fully Evolved)', stats: { hp: 78, atk: 84,  def: 78,  spa: 109, spd: 85,  spe: 100 } },
            { id: 'little-cup',    label: 'Little Cup (Low BST)', stats: { hp: 40, atk: 50,  def: 40,  spa: 45,  spd: 40,  spe: 55  } }
        ];

        /**
         * Sets the stats to a template's shape, scaled to a target BST (the
         * template's own when none is given).
         * @returns whether it was applied
         */
        function applyStatTemplate(templateId, targetText = ''): boolean {
            if (!templateId) {
                api.showToast?.('Pick a stat template first.', 'info');
                return false;
            }
            const template = STAT_TEMPLATES.find(t => t.id === templateId);
            if (!template) return false;
            const defaultBst = STAT_KEYS.reduce((sum, k) => sum + template.stats[k], 0);
            const raw = String(targetText || '').trim();
            const targetBst = raw ? clampTemplateBstValue(raw) : defaultBst;
            const scaled = scaleStatsToBst(template.stats, STAT_KEYS, targetBst);
            setForm({ stats: scaled as StatBlock });
            updateEditorStats();
            const actualBst = STAT_KEYS.reduce((sum, k) => sum + scaled[k], 0);
            api.showToast?.(`Applied "${template.label}" (BST ${actualBst}).`, 'success');
            return true;
        }

        // clamps a user-typed target BST to a sane range: at least 6 (1 per
        // stat, the minimum a base stat can be) and at most 1530 (255 per stat).
        function clampTemplateBstValue(value) {
            const parsed = Number.parseInt(String(value).replace(/[^0-9-]/g, ''), 10);
            if (!Number.isFinite(parsed)) return 6 * 100;
            return Math.max(6, Math.min(1530, parsed));
        }

        // scales a template's stats to targetBst while keeping proportions and
        // the 1-255 bounds; uses largest-remainder rounding so the sum is exact
        // whenever that's achievable within the per-stat bounds.
        function scaleStatsToBst(templateStats, statKeys, targetBst) {
            const sourceTotal = statKeys.reduce((sum, k) => sum + templateStats[k], 0) || 1;
            const scale = targetBst / sourceTotal;

            const raw: Record<string, any> = {};
            const floor: Record<string, any> = {};
            const remainder: any[] = [];
            statKeys.forEach(stat => {
                const scaled = Math.max(1, Math.min(255, templateStats[stat] * scale));
                raw[stat] = scaled;
                floor[stat] = Math.max(1, Math.min(255, Math.floor(scaled)));
                remainder.push({ stat, frac: scaled - Math.floor(scaled) });
            });

            let currentTotal = statKeys.reduce((sum, k) => sum + floor[k], 0);
            let deficit = targetBst - currentTotal;

            // distribute the remaining +1s to the stats with the largest
            // fractional remainder first (largest-remainder rounding).
            remainder.sort((a, b) => b.frac - a.frac);
            for (const { stat } of remainder) {
                if (deficit <= 0) break;
                if (floor[stat] < 255) { floor[stat] += 1; deficit -= 1; }
            }
            // if we overshot the achievable range (e.g. target too high/low
            // for the bounds), spread the remaining difference wherever there's
            // still room, in original stat order.
            if (deficit > 0) {
                for (const stat of statKeys) {
                    while (deficit > 0 && floor[stat] < 255) { floor[stat] += 1; deficit -= 1; }
                    if (deficit <= 0) break;
                }
            } else if (deficit < 0) {
                for (const stat of statKeys) {
                    while (deficit < 0 && floor[stat] > 1) { floor[stat] -= 1; deficit += 1; }
                    if (deficit >= 0) break;
                }
            }

            return floor;
        }

// ==================== stats ====================
        // the numbers themselves are drawn by the editor page; a change to them
        // updates the board, saves, and refreshes the bulk comparison
        function updateEditorStats() {
            notify();
            updatePreview();
            api.autoSave();
            updateBulkComparison();
        }
        // legacy alias
        function updateStats() { updateEditorStats(); }

        /** A stat at the editor's level: neutral nature, 0 EVs, 31 IVs. */
        function statAtLevel(stat) {
            return calcStat(clampBaseStat(form.stats[stat]), 0, 31, 'Hardy', stat, Number(form.level) || 100);
        }

// ==================== sprite fallbacks ====================
        const pokeApiArtworkCache = new Map();
        const pokeApiArtworkPending = new Map();

        function normalizePokeApiPokemonName(value) {
            return String(value || '').trim().toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        }

        async function getPokeApiOfficialArtwork(pokemonName, fallbackName) {
            const candidates = [...new Set([pokemonName, fallbackName].map(normalizePokeApiPokemonName).filter(Boolean))];
            for (const name of candidates) {
                if (pokeApiArtworkCache.has(name)) return pokeApiArtworkCache.get(name);
                if (!pokeApiArtworkPending.has(name)) {
                    pokeApiArtworkPending.set(name, cachedFetch(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(name)}`, POKEAPI_CACHE)
                        .then(res => res.ok ? res.json() : null)
                        .then(data => {
                            const url = data?.sprites?.other?.['official-artwork']?.front_default || null;
                            if (url) pokeApiArtworkCache.set(name, url);
                            return url;
                        }).catch(() => null));
                }
                const url = await pokeApiArtworkPending.get(name);
                pokeApiArtworkPending.delete(name);
                if (url) return url;
            }
            return null;
        }

        async function fallbackPokemonImage(img, pokemonName, fallbackName) {
            if (!img || img.dataset.pokeapiFallbackAttempted === 'true') return;
            img.dataset.pokeapiFallbackAttempted = 'true';
            const url = await getPokeApiOfficialArtwork(pokemonName, fallbackName);
            if (url) {
                img.src = url;
                img.style.visibility = 'visible';
                img.style.display = '';
            } else {
                img.style.visibility = 'hidden';
            }
        }
        window.fallbackPokemonImage = fallbackPokemonImage;

        // ==================== bulk comparison ====================
        function getSpriteUrl(dexId, dexRecord) {
            const raw = String(dexId || dexRecord?.id || dexRecord?.name || '').trim().toLowerCase();
            const slug = value => String(value || '')
                .toLowerCase()
                .replace(/[’']/g, '')
                .replace(/\./g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            const base = slug(dexRecord?.baseSpecies || '');
            const forme = slug(dexRecord?.forme || '');
            let name;
            if (base && forme) {
                let suffix = forme;
                suffix = suffix.replace(/^mega-([xy])$/, 'mega$1');
                suffix = suffix.replace(/^alola-totem$/, 'alolatotem');
                suffix = suffix.replace(/^galar-totem$/, 'galartotem');
                suffix = suffix.replace(/^hisui-totem$/, 'hisuitotem');
                suffix = suffix.replace(/^paldea-totem$/, 'paldeatotem');
                name = `${base}-${suffix}`;
            } else {
                name = raw.replace(/[-_\s]+/g, '-');
            }
            const spriteDir = typeof api.getUse2DSprites === 'function' && api.getUse2DSprites() ? 'gen5ani' : 'ani';
            return 'https://play.pokemonshowdown.com/sprites/' + spriteDir + '/' + (name || 'missingno') + '.gif';
        }

        // the Stats tab draws it (js/app/components/editor/BulkComparison.tsx)
        function updateBulkComparison() { notify(); }

        /**
         * The Fakemon's maximum physical and special bulk, and the Pokemon closest to each.
         */
        function bulkComparison(): null | { hpStat: number, defStat: number, spdStat: number, physBulk: number, specBulk: number, phys: any, spec: any, bulkOf: (m: any, kind: string) => number } {
            if (!state.sdLoaded || Object.keys(state.sdPokedex).length === 0) return null;
            // models maximum physical/special bulk: level-100 stat formula with max
            // IVs/EVs and a beneficial nature on the defensive stat (HP has none).
            const toBulkStat = (base, statKey) => {
                const nature = statKey === 'def' ? 'Impish' : statKey === 'spd' ? 'Careful' : 'Hardy';
                return calcStat(clampBaseStat(base), 252, 31, nature, statKey, 100);
            };
            const hpStat = toBulkStat(form.stats.hp, 'hp');
            const defStat = toBulkStat(form.stats.def, 'def');
            const spdStat = toBulkStat(form.stats.spd, 'spd');
            const physBulk = hpStat * defStat;
            const specBulk = hpStat * spdStat;

            const candidates = Object.values<any>(state.sdPokedex)
                .filter(dex => dex && dex.stats)
                .map(dex => ({ ...dex, isOwnFakemon: false }));
            if (api.getIncludeOwnFakemonsInBulkComparison?.()) {
                (state.fakemonDB || []).forEach(fakemon => {
                    // exclude the Fakemon currently open in the editor.
                    if (state.editingId && String(fakemon?.id) === String(state.editingId)) return;
                    if (!fakemon || !fakemon.name || !fakemon.stats) return;
                    candidates.push({
                        id: `woogidex-${fakemon.id || fakemon.name}`,
                        name: fakemon.name,
                        stats: { hp: clampBaseStat(fakemon.stats.hp ?? 60), def: clampBaseStat(fakemon.stats.def ?? 60), spd: clampBaseStat(fakemon.stats.spd ?? 60) },
                        isOwnFakemon: true,
                        artwork: fakemon.artwork || null
                    });
                });
            }
            let phys: any = null, physDiff = Infinity, spec: any = null, specDiff = Infinity;
            for (const dex of candidates) {
                const dHp = toBulkStat(dex.stats.hp || 0, 'hp');
                const pd = Math.abs(dHp * toBulkStat(dex.stats.def || 0, 'def') - physBulk);
                const sd = Math.abs(dHp * toBulkStat(dex.stats.spd || 0, 'spd') - specBulk);
                if (pd < physDiff) { physDiff = pd; phys = dex; }
                if (sd < specDiff) { specDiff = sd; spec = dex; }
            }
            const bulkOf = (m, kind) => toBulkStat(m.stats.hp, 'hp') * (kind === 'physical' ? toBulkStat(m.stats.def, 'def') : toBulkStat(m.stats.spd, 'spd'));
            return { hpStat, defStat, spdStat, physBulk, specBulk, phys, spec, bulkOf };
        }

        function setArtworkMode(mode) {
            state.artworkMode = mode === 'shiny' ? 'shiny' : 'normal';
            notify();
        }

        function removeCurrentArtwork(event) {
            event?.stopPropagation?.();
            if ((state.artworkMode || 'normal') === 'shiny') state.shinyArtworkData = null;
            else state.artworkData = null;
            notify();
            updatePreview();
            api.autoSave();
        }

        function processArtworkFile(file) {
            if (!file) return;
            if (!file.type || !file.type.startsWith('image/')) {
                api.showToast('Please use an image file for artwork.', 'error');
                return;
            }
            const MAX_ARTWORK_SIZE = 2 * 1024 * 1024;
            if (file.size > MAX_ARTWORK_SIZE) {
                api.showToast('Artwork image must be 2 MB or smaller.', 'error');
                return;
            }
            const reader = new FileReader();
            reader.onload = (e) => {
                if ((state.artworkMode || 'normal') === 'shiny') state.shinyArtworkData = reader.result as string;
                else state.artworkData = reader.result as string;
                notify();
                updatePreview();
                api.autoSave();
            };
            reader.readAsDataURL(file);
        }

        function removePokemonCry(event) {
            event?.stopPropagation();
            state.cryData = null;
            notify();
            updatePreview();
            api.autoSave(true);
        }

        function processPokemonCryFile(file) {
            if (!file) return;
            if (!file.type || !file.type.startsWith('audio/')) {
                api.showToast('Please use an audio file for the Pokemon cry.', 'error');
                return;
            }
            const MAX_CRY_SIZE = 2 * 1024 * 1024;
            if (file.size > MAX_CRY_SIZE) {
                api.showToast('Pokemon cry must be 2 MB or smaller.', 'error');
                return;
            }
            const reader = new FileReader();
            reader.onload = (e) => {
                state.cryData = reader.result as string;
                notify();
                updatePreview();
                api.autoSave(true);
            };
            reader.onerror = () => api.showToast('Could not read that Pokemon cry file.', 'error');
            reader.readAsDataURL(file);
        }

        function playPokemonCry(event) {
            event?.preventDefault();
            event?.stopPropagation();
            if (!state.cryData) return;
            try {
                const audio = new Audio(state.cryData);
                audio.play().catch(() => api.showToast('Could not play this Pokemon cry in your browser.', 'warning'));
            } catch (err: any) {
                api.showToast('Could not play this Pokemon cry.', 'warning');
            }
        }

        window.playPokemonCry = playPokemonCry;

// ==================== art credit ====================
        function setArtCredit(text) {
            state.artCredit = String(text || '').trim() || null;
            notify();
            updatePreview();
            api.autoSave(true);
        }

// ==================== egg groups, gender, height and weight ====================
        // the form holds them (js/editor/draft.ts); these names are what the rest of the app calls
        const getEggGroupValue = eggGroupsText;
        const getGenderRatioValue = genderRatioText;
        const getHeightDisplay = heightDisplay;
        const getWeightDisplay = weightDisplay;

// ==================== preview ====================
                
// ==================== flag helpers ====================
        function getFlagLabels(flags, category) {
            if (!flags) return [];
            const labels: any[] = [];
            const isStatus = category === 'Status';
            if (flags.contact) labels.push('Contact');
            if (flags.punch) labels.push('Punch');
            if (flags.slicing) labels.push('Slicing');
            if (flags.sound) labels.push('Sound');
            if (flags.bite) labels.push('Bite');
            if (flags.bullet) labels.push('Bullet');
            if (flags.pulse) labels.push('Pulse');
            if (flags.wind) labels.push('Wind');
            if (flags.dance) labels.push('Dance');
            if (flags.powder) labels.push('Powder');
            if (flags.heal || flags.recovery) labels.push('Heal');
            if (flags.thawing) labels.push('Thaws User');
            if (flags.charge) labels.push('Charge');
            if (flags.recharge) labels.push('Recharge');
            if (flags.highcrit) labels.push('High Crit');
            if (flags.ohko) labels.push('OHKO');
            if (flags.priority) labels.push('Priority');
            if (flags.multihit) labels.push('Multi-hit');
            if (flags.pivot) labels.push('Pivot');
            if (flags.protect) labels.push('Bypass Protect');
            if (flags.bypasssub) labels.push('Bypass Substitute');
            if (isStatus && flags.reflectable) labels.push('Cannot be Bounced');
            if (isStatus && flags.snatch) labels.push('Unsnatchable');
            return labels;
        }

        // a learnset move as the board's tag shows it
        function moveTag(m) {
            let lowValue = false;
            try { lowValue = !sampleMoveIsActuallyUseful(m); } catch (e: any) { lowValue = false; }
            const fade = (typeof api.getFadeUselessMoves === 'function' ? api.getFadeUselessMoves() : true) && lowValue;
            // a custom move's optional image (js/editor/entity-art.ts)
            const art = m.customId ? (state.customMoves || []).find(x => x.id === m.customId)?.artwork || m.artwork : m.artwork;
            return { name: m.name, category: m.category, faded: !!fade, art: art || '' };
        }

// ==================== type weakness / resistance ====================
function getTypeDamageMultiplier(attackType, defendingTypes) {
    return defendingTypes.reduce((multiplier, defendingType) => {
        return multiplier * (TYPE_EFFECTIVENESS[attackType]?.[defendingType] ?? 1);
    }, 1);
}

/** What the current typing is weak to, resists and is immune to. */
function typeEffectiveness(types = [form.type1, form.type2].filter(Boolean)) {
    const groups = { weak: [] as any[], resist: [] as any[], immune: [] as any[] };
    if (!types.length) return groups;
    POKEMON_TYPES.forEach(attackType => {
        const multiplier = getTypeDamageMultiplier(attackType, types);
        if (multiplier >= 2) groups.weak.push({ type: attackType, multiplier });
        else if (multiplier === 0) groups.immune.push({ type: attackType, multiplier });
        else if (multiplier > 0 && multiplier < 1) groups.resist.push({ type: attackType, multiplier });
    });
    return groups;
}

function getCollectionShinyPreview() {
    return !!state.collectionShinyPreview;
}

// the toggle is drawn by js/app/pages/CollectionPage.tsx from state.collectionShinyPreview
function updateCollectionShinyPreviewUI() {
    api.renderBreadcrumb?.();
}

function setCollectionShinyPreview(enabled) {
    state.collectionShinyPreview = !!enabled;
    localStorage.setItem('woogidex-collection-shiny-preview', state.collectionShinyPreview ? 'true' : 'false');
    updateCollectionShinyPreviewUI();
    api.renderCollection?.();
}

function toggleCollectionShinyPreview() {
    setCollectionShinyPreview(!getCollectionShinyPreview());
}

window.setCollectionShinyPreview = setCollectionShinyPreview;
window.toggleCollectionShinyPreview = toggleCollectionShinyPreview;

function handlePreviewCustomMove(index) {
    if (state.isCommunityPreview) {
        const move = state.learnset?.[index];
        if (move?.name && typeof showMoveDetail === 'function') showMoveDetail(move.name);
        return;
    }
    if (typeof openCustomMoveModal === 'function') openCustomMoveModal(index);
}
window.handlePreviewCustomMove = handlePreviewCustomMove;

/** Normal or shiny artwork on the board (shiny only when there is some). */
function setPreviewArtworkMode(mode) {
    state.previewArtworkMode = mode === 'shiny' && state.shinyArtworkData ? 'shiny' : 'normal';
    notify();
}

function togglePreviewArtworkMode(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    setPreviewArtworkMode(state.previewArtworkMode === 'shiny' ? 'normal' : 'shiny');
}

/**
 * Everything the Pokédex board shows for what the editor holds: the preview
 * tab, the quick preview, the Community Hub page and the PNG export all draw
 * this (js/app/components/board/PokedexBoard.tsx).
 */
function boardModel() {
    const name = form.name || 'Unnamed Pokemon';
    const speciesRaw = form.species.trim();
    const { hp, atk, def, spa, spd, spe } = form.stats;
    const stats = { hp: Number(hp) || 0, atk: Number(atk) || 0, def: Number(def) || 0, spa: Number(spa) || 0, spd: Number(spd) || 0, spe: Number(spe) || 0 };
    const eggs = getEggGroupValue();
    const ratio = getGenderRatioValue();
    let gender;
    if (ratio === 'genderless') gender = { genderless: true, male: 0, female: 0, label: 'Genderless' };
    else {
        const [m, f] = ratio.split('-').map(Number);
        gender = { genderless: !(m > 0) && !(f > 0), male: m, female: f, label: (m > 0 && f > 0) ? `${m}% Male / ${f}% Female` : (m > 0 ? '100% Male' : '100% Female') };
    }
    const allMoves = state.learnset.filter(m => m && m.name);
    const byCategory = cat => allMoves.filter(m => m.category === cat).map(moveTag);
    const customMoves = allMoves.filter(isCustomMove).map(m => {
        const acc = (m.accuracy === true || m.accuracy === undefined || m.accuracy === false) ? '-' : m.accuracy + '%';
        const method = m.learnMethod === 'level' && m.level ? ' · Level ' + m.level : m.learnMethod === 'tm' ? ' · TM' : m.learnMethod === 'egg' ? ' · Egg' : '';
        return {
            index: state.learnset.indexOf(m), name: m.name, type: m.type || 'Normal', desc: m.desc || '',
            stats: `${m.category || 'Status'} · ${m.basePower || '-'} BP · ${acc} acc · ${m.pp || '-'} PP${method}${m.priority ? ' · Priority ' + m.priority : ''}`,
            flags: getFlagLabels(m.flags || {}, m.category)
        };
    });
    const abilities = state.abilities.filter(a => a.name).map((a, i) => {
        const isCustom = a.source === 'custom' || a.custom === true;
        const sdEntry = Object.values<any>(state.sdAbilities).find(v => v.name === a.name);
        return {
            name: a.name, role: getAbilityRole(i) || '', isCustom,
            desc: isCustom ? (a.desc || a.description || '') : ((sdEntry && sdEntry.desc) || a.desc || ''),
            // a custom ability's optional image (js/editor/entity-art.ts)
            art: isCustom ? (state.customAbilities || []).find(x => x.id === a.customId)?.artwork || '' : ''
        };
    });
    return {
        name,
        species: speciesRaw ? (/^the\s/i.test(speciesRaw) ? speciesRaw : 'The ' + speciesRaw) : '',
        type1: form.type1, type2: form.type2, number: form.number,
        stats, bst: stats.hp + stats.atk + stats.def + stats.spa + stats.spd + stats.spe,
        facts: [['Height', getHeightDisplay()], ['Weight', getWeightDisplay()], ['Color', form.color], ['Egg Group', eggs && eggs !== 'None' ? eggs : '']].filter(([, v]) => v),
        gender,
        abilities,
        dexEntries: [form.dexEntry1, form.dexEntry2].filter(Boolean),
        moves: { physical: byCategory('Physical'), special: byCategory('Special'), status: byCategory('Status') },
        customMoves,
        sets: state.sampleSets.map((set, i) => ({ name: set.name || 'Set ' + (i + 1), text: generateShowdownExport(name, set) })),
        artwork: state.artworkData || '', shinyArtwork: state.shinyArtworkData || '', cry: state.cryData || '',
        artCredit: state.artCredit || '',
        artMode: state.previewArtworkMode === 'shiny' && state.shinyArtworkData ? 'shiny' : 'normal'
    };
}

// Every editor change asks for this. The board is a React component now, so
// "updating the preview" is a redraw; what's left here is what a redraw
// doesn't do: the tab title, and the autosave that follows every edit.
let previewQueued = false;
function updatePreview() {
    notify();
    if (previewQueued) return;
    previewQueued = true;
    queueMicrotask(() => { if (previewQueued) afterPreview(); });
}

/** Draws the board now, for code that reads or screenshots it straight after. */
function updatePreviewNow() {
    flushSync(() => notifySync());
    afterPreview();
}

function afterPreview() {
    previewQueued = false;
    log.debug('PREVIEW', 'Updating Fakemon preview', { name: form.name, moves: state.learnset.length });
    // only while editor is the visible view, so background preview renders
    // don't steal the tab title from wherever the user actually is
    if (document.getElementById('editor-view')?.style.display !== 'none') {
        api.setPageTitle?.(form.name || 'Unnamed Pokemon');
    }
    api.autoSave();
}

export {
    getNextPokedexNumber, resetEditor, loadFakemonIntoEditor, setPreviewArtworkMode, setCollectionShinyPreview, toggleCollectionShinyPreview,
    updateCollectionShinyPreviewUI, updateEditorStats, updateStats, statAtLevel, getSpriteUrl, updateBulkComparison, bulkComparison,
    STAT_TEMPLATES, applyStatTemplate, scaleStatsToBst, clampTemplateBstValue, clampBaseStatValue,
    setArtworkMode, removeCurrentArtwork, processArtworkFile, processPokemonCryFile, removePokemonCry, setArtCredit,
    getEggGroupValue, getGenderRatioValue, getHeightDisplay, getWeightDisplay,
    getFlagLabels, updatePreview, updatePreviewNow, getTypeDamageMultiplier, typeEffectiveness, boardModel, togglePreviewArtworkMode,
    handlePreviewCustomMove, playPokemonCry
};
