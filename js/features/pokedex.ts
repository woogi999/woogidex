import { log } from '../core/log.ts';
import { state, api } from '../core/app.ts';
import { confirmDialog } from '../core/confirm-dialog.ts';
import { notify } from '../app/store.ts';
import { closeDialog, isDialogOpen, openDialog } from '../app/dialogs.tsx';
import { esc } from '../core/html.ts';
import { closeCardMenus } from '../app/components/collection/menus.ts';
import { cachedFetch } from '../core/net-cache.ts';
import { eggGroupsFromText, genderFromText, setForm, STAT_KEYS, type StatKey } from '../editor/draft.ts';
import type { CollectionTab } from '../app/types.ts';
// PokeAPI never rewrites a species entry, so a month is conservative.
const POKEAPI_CACHE = { cacheName: 'woogidex-pokeapi-v1', maxAgeMs: 30 * 86400000 };

// ==================== navigation ====================
        async function showCollection() {
            // leaving a shared/community preview is navigation, not an edit - don't force-save it into the user's own collection.
            const wasCommunityPreview = !!state.isCommunityPreview;
            // the editor is a sheet over My Collection: closing it just uncovers the
            // page as it was (tab, folder, region, scroll) and updates what changed
            const editorOpen = document.getElementById('editor-view')?.style.display === 'block';
            if (editorOpen && !wasCommunityPreview && document.getElementById('collection-view')?.style.display === 'block') {
                await api.autoSave(true);
                api.activateTopLevelView?.('collection-view');
                renderCollection();
                api.setRoute?.('collection', null);
                return;
            }
            state.isCommunityPreview = false;
            api.exitCommunityRoute?.();
            api.exitProfileRoute?.();
            for (const id of ['community-detail-view', 'events-view', 'community-view']) {
                const view = document.getElementById(id);
                if (view) view.style.display = 'none';
            }
            if (!wasCommunityPreview && document.getElementById('editor-view')?.style.display !== 'none') {
                await api.autoSave(true);
            }
            api.activateTopLevelView?.('collection-view');
            setCollectionView(collectionView || 'fakemon');
            api.setRoute?.('collection', null);
        }
        // ==================== new Fakemon flow ====================
        // The dialogs are js/app/dialogs/newFakemon.tsx: a name, then either a
        // blank Fakemon or a main-game Pokemon to start from.
        async function createNewFakemon() {
            if (document.getElementById('editor-view')?.style.display !== 'none') {
                await api.autoSave(true);
            }
            openDialog('new-fakemon', {});
        }

        // options.pendingVanilla: a region's version of a main-game Pokemon,
        // which stays pending (unsaved, not "edited") until something changes.
        // options.asCopy: a Fakemon of your own that only starts from the species.
        // options.background: fill it in without opening the editor (for a preview).
        async function startNewFakemonEditor(name, template, options: Record<string, any> = {}) {
            api.autoSave(true);
            state.editingId = null;
            api.resetEditor();
            setForm({ name });
            if (!options.background) {
                api.activateTopLevelView?.('editor-view');
                switchTab(null, 'basic');
                api.setRoute?.('collection', name || 'New Fakemon');
            }
            closeDialog('new-fakemon');
            closeDialog('pokemon-template');

            // learnset hydrates immediately from the already-loaded Showdown dex; PokeAPI species/lore load async without blocking the editor.
            state.pendingVanillaId = template && !options.asCopy ? template.id : null;
            state.pendingVanillaDraft = !!(template && options.pendingVanilla);
            try {
                if (template) await applyPokemonTemplate(template, name);
                api.updatePreview();
                if (template) {
                    // a first save gives it an id, which its evolution board needs
                    await api.autoSave?.(true);
                    state.pendingVanillaId = null;
                    if (!options.asCopy) {
                        // a pending version only shows the line; linking the rest of
                        // the family to it waits until it's really the region's own
                        api.applyVanillaEvolutionLine?.(template.id, { persist: !state.pendingVanillaDraft });
                    }
                    if (state.pendingVanillaDraft) api.markFakemonPendingBaseline?.();
                }
            } finally {
                state.pendingVanillaDraft = false;
            }
        }

        /** The template picker, carrying over the name typed so far (it may be empty). */
        function openPokemonTemplateChooser(name = '') {
            if (!state.sdLoaded || !Object.keys(state.sdPokedex || {}).length) {
                api.showToast('Vanilla Pokemon data is still loading. Please try again in a moment.', 'info');
                return;
            }
            closeDialog('new-fakemon');
            openDialog('pokemon-template', { name });
        }

        function getPokemonTemplateEntries() {
            return Object.values<any>(state.sdPokedex || {})
                .filter(p => p && p.types && p.stats && p.num > 0)
                .sort((a,b) => (a.num||99999)-(b.num||99999) || String(a.name).localeCompare(String(b.name)));
        }


        function getShowdownSpriteId(pokemon) {
            const raw = String(pokemon?.id || pokemon?.name || '').trim().toLowerCase();
            const slug = value => String(value || '')
                .toLowerCase()
                .replace(/[’']/g, '')
                .replace(/\./g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            const base = slug(pokemon?.baseSpecies || '');
            const forme = slug(pokemon?.forme || '');
            if (base && forme) {
                // showdown's sprite dir uses compact form tokens: mega-x/y => megax/megay, alola-totem => alolatotem, etc.
                let suffix = forme;
                suffix = suffix.replace(/^mega-([xy])$/, 'mega$1');
                suffix = suffix.replace(/^alola-totem$/, 'alolatotem');
                suffix = suffix.replace(/^galar-totem$/, 'galartotem');
                suffix = suffix.replace(/^hisui-totem$/, 'hisuitotem');
                suffix = suffix.replace(/^paldea-totem$/, 'paldeatotem');
                return `${base}-${suffix}`;
            }
            return raw.replace(/[-_\s]+/g, '-');
        }

        function getPokemonTemplateSprite(pokemon) {
            const spriteId = getShowdownSpriteId(pokemon);
            // the animated Showdown directory has the canonical form filenames (e.g. charizard-megax).
            const spriteDir = typeof api.getUse2DSprites === 'function' && api.getUse2DSprites() ? 'gen5ani' : 'ani';
            return `https://play.pokemonshowdown.com/sprites/${spriteDir}/${spriteId || 'missingno'}.gif`;
        }

        /** Whether a main-game Pokemon matches the template picker's search. */
        function templateMatches(p, query) {
            const q = String(query || '').trim().toLowerCase();
            if (!q) return true;
            const nq = q.replace(/[^a-z0-9]/g, '');
            const name = String(p.name || '').toLowerCase();
            const id = String(p.id || '').toLowerCase();
            return name.includes(q) || id.includes(q) || name.replace(/[^a-z0-9]/g, '').includes(nq)
                || id.replace(/[^a-z0-9]/g, '').includes(nq) || String(p.num || '').includes(q);
        }

        function classifyTemplateLearnsetSource(sources) {
            const parsed=(Array.isArray(sources)?sources:[sources]).map(source=>{
                const text=String(source||'');
                const gen=Number(text.match(/^\d+/)?.[0]||0);
                const level=Number(text.match(/L(\d+)$/)?.[1]||0);
                if (level) return {gen,method:'level',level};
                if (/M$/.test(text)) return {gen,method:'tm',level:null as any};
                if (/E$/.test(text)) return {gen,method:'egg',level:null as any};
                if (/T$/.test(text)) return {gen,method:'tm',level:null as any};
                return null;
            }).filter(x => x !== null);
            parsed.sort((a,b)=>b.gen-a.gen || (a.method==='level'?0:1)-(b.method==='level'?0:1) || (a.level||999)-(b.level||999));
            return parsed[0]||{gen:0,method:'none',level:null as any};
        }

        function getPokemonTemplateLearnset(pokemon) {
            const raw=state.sdLearnsets?.[pokemon.id] || state.sdLearnsets?.[String(pokemon.id).replace(/-/g,'')] || state.sdLearnsets?.[String(pokemon.name || '').toLowerCase().replace(/[^a-z0-9]/g,'')] || {};
            const order={level:0,egg:1,tm:2,none:3};
            const unique=new Map();
            Object.entries<any>(raw).forEach(([moveId,sources])=>{
                const move=state.sdMoves?.[moveId];
                if(!move?.name) return;
                const source=classifyTemplateLearnsetSource(sources);
                const entry={name:move.name,learnMethod:source.method,level:source.method==='level'?source.level:null};
                const old=unique.get(entry.name);
                if(!old || order[entry.learnMethod]<order[old.learnMethod] || (entry.learnMethod==='level' && entry.level<old.level)) unique.set(entry.name,entry);
            });
            return [...unique.values()].sort((a,b)=>{
                const d=(order[a.learnMethod]??3)-(order[b.learnMethod]??3);
                return d || (a.learnMethod==='level' ? (a.level||999)-(b.level||999) : a.name.localeCompare(b.name));
            });
        }

        function getTemplateGenderRatio(pokemon) {
            if (pokemon.genderPct === -1) return 'genderless';
            const male=Math.max(0,Math.min(100,Number(pokemon.genderPct)));
            return `${male}-${100-male}`;
        }

        function getTemplateAbilities(pokemon) {
            const entries=Object.entries<any>(pokemon.abilities||{});
            const normal=entries.filter(([slot,name])=>name && !/^H$/i.test(String(slot)) && !/hidden/i.test(String(slot))).map(([,name])=>String(name));
            const hidden=entries.find(([slot,name])=>name && (/^H$/i.test(String(slot)) || /hidden/i.test(String(slot))));
            if(hidden) normal.push(String(hidden[1]));
            return [...new Set(normal)].slice(0,4).map(name=>{
                const normalized=name.toLowerCase().replace(/[^a-z0-9]/g,'');
                const entry=Object.entries<any>(state.sdAbilities||{}).find(([key,a]) => String(key).toLowerCase().replace(/[^a-z0-9]/g,'')===normalized || String(a?.name||'').toLowerCase().replace(/[^a-z0-9]/g,'')===normalized);
                return {name,source:'sd',desc:entry?.[1]?.desc||''};
            });
        }

        function clampTemplateBaseStatValue(value) {
            const parsed = Number.parseInt(String(value).replace(/[^0-9-]/g, ''), 10);
            if (!Number.isFinite(parsed)) return 1;
            return Math.max(1, Math.min(255, parsed));
        }

        async function fetchPokemonSpeciesTemplateData(template) {
            const cacheKey = String(template?.id || template?.name || '').trim().toLowerCase();
            if (!cacheKey) return null;
            if (state.pokeApiSpeciesCache?.[cacheKey]) return state.pokeApiSpeciesCache[cacheKey];

            const rawId = String(template.id || template.name || '').trim().toLowerCase();
            const formSuffixes = /-(?:alola|galar|hisui|paldea|normal|origin|therian|incarnate|standard|attack|defense|speed|plant|sandy|trash|heat|wash|frost|fan|mow|ordinary|resolute|aria|pirouette|school|solo|hero|crowned|eternamax|mega(?:-[a-z0-9]+)?|gmax|unbound|totem|zen|dusk|dawn|midnight|sunny|rainy|snowy|low-key|amped|gulping|gorging|10-percent|complete)$/i;
            const stripAllFormSuffixes = value => {
                let current = String(value || '').toLowerCase();
                for (let i = 0; i < 8; i++) {
                    const next = current.replace(formSuffixes, '');
                    if (next === current) break;
                    current = next;
                }
                return current;
            };
            const speciesCandidates = [
                String(template?.baseSpecies || '').toLowerCase(),
                String(template.name || rawId).toLowerCase(),
                rawId,
                stripAllFormSuffixes(String(template?.name || rawId).toLowerCase()),
                stripAllFormSuffixes(rawId)
            ]
                .map(value => value.replace(/[’']/g, '').replace(/\./g, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''))
                .filter(Boolean);

            let species: any = null;
            try {
                // regional/form IDs need the Pokemon endpoint since it points back to the canonical species resource.
                try {
                    const pokemonResponse = await cachedFetch(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(rawId)}`, POKEAPI_CACHE);
                    if (pokemonResponse.ok) {
                        const pokemon = await pokemonResponse.json();
                        const speciesUrl = pokemon?.species?.url;
                        if (speciesUrl) {
                            const speciesResponse = await cachedFetch(speciesUrl, POKEAPI_CACHE);
                            if (speciesResponse.ok) species = await speciesResponse.json();
                        }
                    }
                } catch (formErr: any) {
                    log.warn('POKEAPI', 'Pokemon lookup fallback', formErr);
                }

                if (!species) {
                    for (const candidate of [...new Set(speciesCandidates)]) {
                        const response = await cachedFetch(`https://pokeapi.co/api/v2/pokemon-species/${encodeURIComponent(candidate)}`, POKEAPI_CACHE);
                        if (response.ok) {
                            species = await response.json();
                            break;
                        }
                    }
                }
                if (!species) throw new Error('Species not found');

                const english = entry => entry?.language?.name === 'en';
                const genusEntry = (species.genera || []).find(english);
                const genus = genusEntry?.genus || '';
                const lore: any[] = [];
                for (const entry of (species.flavor_text_entries || [])) {
                    if (!english(entry)) continue;
                    const text = String(entry.flavor_text || '')
                        .replace(/[\n\f\r]+/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    if (text && !lore.includes(text)) lore.push(text);
                    if (lore.length >= 2) break;
                }

                const result = { genus, dexEntries: lore };
                state.pokeApiSpeciesCache[cacheKey] = result;
                return result;
            } catch (err: any) {
                log.warn('POKEAPI', 'Could not load species data for template', { template: template?.name, error: err });
                return null;
            }
        }

        async function applyPokemonTemplate(template,newName) {
            const stats=template.stats||{};
            setForm({
                name: newName,
                // species/genus and pokédex lore are supplied asynchronously by PokeAPI.
                species: '', dexEntry1: '', dexEntry2: '',
                type1: template.types?.[0] || '', type2: template.types?.[1] || '',
                stats: Object.fromEntries(STAT_KEYS.map(stat => [stat, clampTemplateBaseStatValue(stats[stat] ?? 60)])) as Record<StatKey, number>,
                height: template.heightm ? String(template.heightm) : '', heightUnit: 'm',
                weight: template.weightkg ? String(template.weightkg) : '', weightUnit: 'kg',
                color: template.color || '',
                ...eggGroupsFromText(template.eggGroups),
                ...genderFromText(getTemplateGenderRatio(template))
            });
            state.abilities=getTemplateAbilities(template);
            state.learnset=getPokemonTemplateLearnset(template);
            // learnset entries are minimal; rehydrate so move details are available on first render.
            if (state.sdLoaded && state.learnset.length && typeof api.rehydrateCurrentLearnsetFromShowdown === 'function') {
                api.rehydrateCurrentLearnsetFromShowdown();
            }
            state.sampleSets=[];
            state.artworkData=getPokemonTemplateSprite(template);
            api.renderAbilities();
            api.renderLearnset();
            api.renderCustomMoves();
            api.renderSampleSets();
            api.updateStats();
            api.updatePreview();

            // supplies the official genus (species/category field) and english flavor-text entries.
            const speciesData = await fetchPokemonSpeciesTemplateData(template);
            if (speciesData) {
                setForm({
                    ...(speciesData.genus ? { species: speciesData.genus } : {}),
                    ...(speciesData.dexEntries[0] ? { dexEntry1: speciesData.dexEntries[0] } : {}),
                    ...(speciesData.dexEntries[1] ? { dexEntry2: speciesData.dexEntries[1] } : {})
                });
                api.updatePreview();
            }
        }

        async function usePokemonTemplate(id, options: Record<string, any> = {}) {
            await api.ensureLearnsets?.(); // Learnsets load lazily
            const template=state.sdPokedex?.[id];
            if(!template) { api.showToast('That Pokemon could not be loaded. Please try another.', 'error'); return; }
            // options.name: what was typed in New Fakemon; otherwise the Pokemon's own name
            const name=String(options.name || '').trim() || template.name || 'Fakemon';
            const ready = startNewFakemonEditor(name,template,options);
            if (!options.pendingVanilla && !options.background) api.showToast(`Loading ${template.name} species data...`, 'info');
            await ready;
        }

        function editFakemon(id) {
            log.info('COLLECTION', 'Editing Fakemon', { id });
            api.autoSave(true);
            const fakemon = state.fakemonDB.find(f => f.id === id);
            if (!fakemon) return;
            state.editingId = id;
            api.loadFakemonIntoEditor(fakemon);
            api.exitCommunityRoute?.();
            api.exitProfileRoute?.();
            api.activateTopLevelView?.('editor-view');
            switchTab(null, 'basic');
            api.updatePreview();
            api.setRoute?.('collection', fakemon.name || 'Editor');
            maybeAutoplayCry(fakemon);
        }

        // Plays a Fakemon's cry on render if autoplay is on; shared by editFakemon/previewFakemon since both reuse the board-render pipeline.
        function maybeAutoplayCry(fakemon) {
            if (!fakemon?.cry) return;
            if (!api.getAutoplayCry?.()) return;
            try { new Audio(fakemon.cry).play().catch(() => {}); } catch {}
        }
        // which of the editor's tabs is showing (js/app/pages/EditorPage.tsx draws them)
        let editorTab = 'basic';
        function getEditorTab() { return editorTab; }

        function switchTab(_tabEl, tabName) {
            editorTab = ['basic', 'stats', 'moves', 'analysis', 'preview'].includes(tabName) ? tabName : 'basic';
            notify();
            if (editorTab === 'stats') {
                setTimeout(() => api.renderEvolutionBoard?.(), 10);
            }
            if (editorTab === 'analysis') {
                setTimeout(() => api.renderAnalysis?.(), 10);
            }
        }

// ==================== quick preview popup ====================
        function previewFakemon(id) {
            const fakemon = state.fakemonDB.find(f => f.id === id);
            if (!fakemon) return;
            // reuse the editor's render pipeline: load into the hidden form, render, then clone the board into the popup.
            state.editingId = id;
            api.loadFakemonIntoEditor(fakemon);
            openBoardPreview(() => editFakemon(id));
            maybeAutoplayCry(fakemon);
        }

        // Shows whatever the (hidden) editor form holds as the quick preview (js/app/dialogs/boardPreview.tsx).
        function openBoardPreview(onEdit) {
            openDialog('board-preview', { onEdit });
        }

// ==================== folders ====================
        /** The New Folder dialog; the folder goes in the tab (and region) you're looking at. */
        function createFolder() {
            openDialog('folder-name', {});
        }
        function renameFolder(id, event) {
            event?.stopPropagation?.();
            if (state.folders.some(f => f.id === id)) openDialog('folder-name', { folderId: id });
        }
        // Folders belong to the region they were made in, like everything else,
        // so a region shows its own folders and "All" shows every folder.
        function visibleFolders(kind) {
            return (state.folders || []).filter(f => (kind === 'fakemon' ? (f.type || 'fakemon') === 'fakemon' : f.type === kind)
                && api.entryInActiveRegion(f));
        }
        // one folder level: inside a folder, what's filed there; at the root,
        // whatever isn't filed in a folder you can see from here
        function atFolderLevel(items, kind) {
            if (state.currentFolderId) return items.filter(i => String(i.folderId || '') === String(state.currentFolderId));
            const shown = new Set(visibleFolders(kind).map(f => String(f.id)));
            return items.filter(i => !i.folderId || !shown.has(String(i.folderId)));
        }

        /**
         * Creates a folder (no id) or renames and recolours one.
         * @returns a problem to show, or '' once it's saved
         */
        function saveFolder({ id = null, name = '', color = null }: { id?: any; name?: any; color?: any }): string {
            const clean = String(name).trim();
            if (!clean) return 'Please enter a folder name!';
            if (id) {
                const folder = state.folders.find(f => f.id === id);
                if (folder) { folder.name = clean; folder.color = color || null; }
            } else {
                const region = api.getActiveRegion?.();
                state.folders.push({
                    id: 'folder_' + Date.now().toString(),
                    name: clean,
                    color: color || null,
                    pinned: false,
                    type: collectionView,
                    // made inside a region, it lives there
                    regionId: region?.id || null,
                    regionIds: region ? [region.id] : [],
                    createdAt: Date.now()
                });
            }
            api.saveToStorage();
            renderCollection();
            api.showToast(id ? 'Folder renamed!' : 'Folder created!', 'success');
            return '';
        }
        function openFolder(id) {
            state.currentFolderId = id;
            collectionSearch = '';
            renderCollection();
        }
        async function deleteFolder(id, event) {
            event?.stopPropagation?.();
            const folder = state.folders.find(f => f.id === id);
            if (!folder) return;
            const kind = folder.type || 'fakemon';
            const label = kind === 'moves' ? 'Moves' : kind === 'abilities' ? 'Abilities' : kind === 'items' ? 'Items' : 'Fakemon';
            if (!await confirmDialog({ title: `Delete the folder “${folder.name}”?`, message: `${label} inside aren’t deleted; they move back out of the folder.` })) return;
            if (kind === 'moves') (state.customMoves || []).forEach(m => { if (m.folderId === id) m.folderId = null; });
            else if (kind === 'abilities') (state.customAbilities || []).forEach(a => { if (a.folderId === id) a.folderId = null; });
            else if (kind === 'items') (state.customItems || []).forEach(i => { if (i.folderId === id) i.folderId = null; });
            else state.fakemonDB.forEach(f => { if (f.folderId === id) f.folderId = null; });
            state.folders = state.folders.filter(f => f.id !== id);
            if (state.currentFolderId === id) state.currentFolderId = null;
            api.saveToStorage();
            renderCollection();
            api.showToast('Folder deleted!', 'info');
        }
        function libraryList(kind) {
            return kind === 'moves' ? state.customMoves : kind === 'abilities' ? state.customAbilities : state.customItems;
        }
        function moveLibraryItemToFolder(kind, itemId, folderId) {
            const item = (libraryList(kind) || []).find(x => x.id === itemId);
            if (!item) return;
            item.folderId = folderId || null;
            api.saveToStorage();
            renderCollection();
            const folder = state.folders.find(f => f.id === folderId);
            api.showToast(folder ? `Moved to "${folder.name}"!` : 'Moved to My Collection!', 'success');
        }
        function moveLibraryItemOutOfFolder(kind, itemId, event) {
            event?.stopPropagation?.();
            moveLibraryItemToFolder(kind, itemId, null);
        }
        function toggleCustomLibraryPin(kind, id, event) {
            event?.stopPropagation?.();
            const item = (libraryList(kind) || []).find(x => x.id === id);
            if (!item) return;
            item.pinned = !item.pinned;
            api.saveToStorage();
            renderCollection();
            api.showToast(item.pinned ? `"${item.name}" pinned!` : `"${item.name}" unpinned!`, 'success');
        }

        function duplicateCustomLibraryItem(kind, id, event) {
            event?.stopPropagation?.();
            const arr = libraryList(kind);
            const item = (arr || []).find(x => x.id === id);
            if (!item) return;
            const copy = JSON.parse(JSON.stringify(item));
            copy.id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
            copy.name = `${item.name || 'Custom'} Copy`;
            copy.pinned = false;
            copy.folderId = item.folderId || null;
            arr.push(copy);
            api.saveToStorage();
            renderCollection();
            api.showToast(`${item.name || 'Custom entry'} duplicated!`, 'success');
        }

        async function deleteCustomLibraryItem(kind, id, event) {
            event?.stopPropagation?.();
            const item = (libraryList(kind) || []).find(x => x.id === id);
            if (!item) return;
            const noun = kind === 'moves' ? 'move' : kind === 'abilities' ? 'ability' : 'item';
            if (!await confirmDialog({ title: `Delete “${item.name}”?`, message: `It’s removed from your ${kind}. Fakémon that use it keep their copy.` })) return;
            if (kind === 'moves') state.customMoves = state.customMoves.filter(x => x.id !== id);
            else if (kind === 'abilities') state.customAbilities = state.customAbilities.filter(x => x.id !== id);
            else state.customItems = state.customItems.filter(x => x.id !== id);
            api.saveToStorage();
            renderCollection();
            api.showToast(`${noun.charAt(0).toUpperCase() + noun.slice(1)} deleted!`, 'info');
        }
        function toggleFolderPin(id, event) {
            event?.stopPropagation?.();
            const folder = state.folders.find(f => f.id === id);
            if (!folder) return;
            folder.pinned = !folder.pinned;
            api.saveToStorage();
            renderCollection();
        }
        function moveFakemonToFolder(fakemonId, folderId) {
            const fakemon = state.fakemonDB.find(f => f.id === fakemonId);
            if (!fakemon) return;
            fakemon.folderId = folderId || null;
            api.saveToStorage();
            renderCollection();
            const folder = state.folders.find(f => f.id === folderId);
            api.showToast(folder ? `Moved to "${folder.name}"!` : 'Moved to My Collection!', 'success');
        }
        function moveFakemonOutOfFolder(fakemonId, event) {
            event?.stopPropagation?.();
            moveFakemonToFolder(fakemonId, null);
        }
        function toggleFakemonPin(id, event) {
            event?.stopPropagation?.();
            const fakemon = state.fakemonDB.find(f => f.id === id);
            if (!fakemon) return;
            fakemon.pinned = !fakemon.pinned;
            api.saveToStorage();
            renderCollection();
            api.showToast(fakemon.pinned ? `"${fakemon.name}" pinned!` : `"${fakemon.name}" unpinned!`, 'success');
        }

        // ---- drag & drop ----
        // a card being dragged, until it's dropped on a folder or a region
        let draggedFakemonId: any = null;
        let draggedLibraryItem: any = null; // { kind, id }
        function handleCardDragStart(id, event) {
            draggedFakemonId = id;
            draggedLibraryItem = null;
            event.dataTransfer.effectAllowed = 'move';
            try { event.dataTransfer.setData('text/plain', id); } catch (e: any) {}
        }
        function handleLibraryCardDragStart(kind, id, event) {
            draggedFakemonId = null;
            draggedLibraryItem = { kind, id };
            event.dataTransfer.effectAllowed = 'move';
            try { event.dataTransfer.setData('text/plain', id); } catch (e: any) {}
        }
        // regions.ts accepts cards dropped on the sidebar
        function getDraggedFakemonId() { return draggedFakemonId; }
        function getDraggedLibraryItem() { return draggedLibraryItem; }
        function handleCardDragEnd() {
            draggedFakemonId = null;
            draggedLibraryItem = null;
        }
        /** A card let go over a folder card. */
        function dropOnFolder(folderId, event) {
            event.preventDefault();
            if (draggedLibraryItem) {
                moveLibraryItemToFolder(draggedLibraryItem.kind, draggedLibraryItem.id, folderId);
            } else {
                const id = draggedFakemonId || event.dataTransfer?.getData('text/plain');
                if (id) moveFakemonToFolder(id, folderId);
            }
            handleCardDragEnd();
        }

// ==================== collection ====================
        // which tab, layout and search My Collection shows; the page itself is
        // js/app/pages/CollectionPage.tsx, which reads these through collectionUI()
        let collectionView: CollectionTab = 'fakemon';
        let collectionSearch = '';
        // false until storage has loaded and the first render ran: the page shows skeleton cards
        let collectionReady = false;

        // Grid or list is remembered per tab: Fakémon read best as art, the
        // libraries as rows, so those start as lists.
        const COLLECTION_LAYOUT_KEY = 'woogidex.collection.layout.v2';
        const DEFAULT_LAYOUTS = { fakemon: 'grid', moves: 'list', abilities: 'list', items: 'list', types: 'list' };
        function readLayouts() {
            try { return { ...DEFAULT_LAYOUTS, ...(JSON.parse(localStorage.getItem(COLLECTION_LAYOUT_KEY) || '{}') || {}) }; }
            catch { return { ...DEFAULT_LAYOUTS }; }
        }
        function layoutFor(view) { return readLayouts()[view] === 'list' ? 'list' : 'grid'; }
        let collectionLayout = layoutFor('fakemon');

        function toggleCollectionLayout() {
            collectionLayout = collectionLayout === 'list' ? 'grid' : 'list';
            try { localStorage.setItem(COLLECTION_LAYOUT_KEY, JSON.stringify({ ...readLayouts(), [collectionView]: collectionLayout })); } catch {}
            renderCollection();
        }

        const COLLECTION_SORT_KEY = 'woogidex.collection.sort.v2';
        // the Fakémon tab sorts by more than the libraries can
        const SORT_OPTIONS = {
            fakemon: [['created', 'Date Added'], ['name', 'Name'], ['number', 'Pokédex Number'], ['bst', 'BST'], ['updated', 'Last Updated']],
            library: [['name', 'Name'], ['created', 'Date Added'], ['updated', 'Last Updated']]
        };

        function getCollectionSortPrefs() {
            const fallback = { by: 'created', order: 'desc' };
            try {
                const saved = JSON.parse(localStorage.getItem(COLLECTION_SORT_KEY) || 'null');
                if (!saved) return fallback;
                return {
                    by: ['created','name','number','bst','updated'].includes(saved.by) ? saved.by : fallback.by,
                    order: saved.order === 'asc' ? 'asc' : 'desc'
                };
            } catch { return fallback; }
        }

        /** The sort a tab uses: the saved one, or its first option when the tab has no such sort. */
        function collectionSortFor(view) {
            const prefs = getCollectionSortPrefs();
            const options = SORT_OPTIONS[view === 'fakemon' ? 'fakemon' : 'library'];
            return { by: options.some(([v]) => v === prefs.by) ? prefs.by : options[0][0], order: prefs.order, options };
        }

        function changeCollectionSort(by, order) {
            const current = collectionSortFor(collectionView);
            try { localStorage.setItem(COLLECTION_SORT_KEY, JSON.stringify({ by: by || current.by, order: order === 'asc' ? 'asc' : order === 'desc' ? 'desc' : current.order })); } catch {}
            renderCollection();
        }

        function sortFakemonList(list, sortBy = 'created', sortOrder = 'desc') {
            // accept the old single-string mode too, so older callers/imports remain safe.
            const legacy = {
                newest: ['created','desc'], oldest: ['created','asc'],
                'name-asc': ['name','asc'], 'name-desc': ['name','desc'],
                'number-asc': ['number','asc'], 'bst-desc': ['bst','desc'],
                'bst-asc': ['bst','asc'], updated: ['updated','desc']
            };
            if (legacy[sortBy]) [sortBy, sortOrder] = legacy[sortBy];
            const sorted = [...list];
            const dir = sortOrder === 'asc' ? 1 : -1;
            const number = f => {
                const n = parseInt(String(f.number || '').replace(/^#/, ''), 10);
                return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
            };
            sorted.sort((a, b) => {
                let result = 0;
                if (sortBy === 'name') result = String(a.name || '').localeCompare(String(b.name || ''));
                else if (sortBy === 'number') result = number(a) - number(b);
                else if (sortBy === 'bst') result = getFakemonBST(a) - getFakemonBST(b);
                else if (sortBy === 'updated') result = (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0);
                else result = (a.createdAt || 0) - (b.createdAt || 0);
                if (result === 0) result = String(a.name || '').localeCompare(String(b.name || ''));
                return result * dir;
            });
            const pinned = sorted.filter(f => f.pinned);
            const unpinned = sorted.filter(f => !f.pinned);
            return [...pinned, ...unpinned];
        }
        function getFakemonBST(f) {
            if (!f.stats) return 0;
            return (f.stats.hp || 0) + (f.stats.atk || 0) + (f.stats.def || 0) + (f.stats.spa || 0) + (f.stats.spd || 0) + (f.stats.spe || 0);
        }

        function sortLibraryList(list, sortMode) {
            const sorted = [...list];
            if (sortMode === 'name-desc') sorted.sort((a, b) => String(b.name || '').localeCompare(String(a.name || '')));
            else if (sortMode === 'newest') sorted.sort((a, b) => String(b.id || '').localeCompare(String(a.id || '')));
            else if (sortMode === 'oldest') sorted.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
            else sorted.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            const pinned = sorted.filter(item => item.pinned);
            const unpinned = sorted.filter(item => !item.pinned);
            return [...pinned, ...unpinned];
        }

        function setCollectionView(view) {
            const newView = ['fakemon', 'moves', 'abilities', 'items', 'types'].includes(view) ? view : 'fakemon';
            // choosing a tab leaves a region's details page
            if (api.isRegionDetailsOpen?.()) api.closeRegionDetails?.();
            if (newView !== collectionView) {
                state.currentFolderId = null;
                collectionSearch = '';
            }
            collectionView = newView;
            collectionLayout = layoutFor(collectionView);
            renderCollection();
        }

        function setCollectionSearch(text) {
            collectionSearch = String(text ?? '');
            renderCollection();
        }

        /** What the page's header, tabs and toolbar show. */
        function collectionUI() {
            return {
                view: collectionView,
                layout: collectionLayout,
                search: collectionSearch,
                sort: collectionSortFor(collectionView),
                ready: collectionReady
            };
        }

        /**
         * The Fakémon or library tab's grid: the folders at this level (only at
         * the root, and not while searching), then the entries, sorted.
         */
        function collectionListing() {
            const kind = collectionView;
            const search = collectionSearch.trim().toLowerCase();
            const sort = collectionSortFor(kind);
            const folders = (!search && !state.currentFolderId) ? visibleFolders(kind) : [];
            folders.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
            const source = kind === 'fakemon' ? state.fakemonDB : (libraryList(kind) || []);
            // a region's copy of a main-game entry that was only opened, never changed
            const own = source.filter(x => !x.pendingVanilla);
            const count = folder => own.filter(x => x.folderId === folder.id && api.entryInActiveRegion(x)).length;

            let entries;
            if (kind === 'fakemon') {
                entries = search
                    ? own.filter(f => [f.name, f.species, f.type1, f.type2].some(v => v && String(v).toLowerCase().includes(search)))
                    : atFolderLevel(own, 'fakemon');
                if (api.getActiveRegionId?.()) entries = entries.filter(f => api.fakemonInActiveRegion(f));
                entries = sortFakemonList(entries, sort.by, sort.order);
            } else {
                entries = own.filter(item => {
                    if (!search) return true;
                    const text = kind === 'moves'
                        ? `${item.name || ''} ${item.type || ''} ${item.category || ''} ${item.desc || ''}`
                        : `${item.name || ''} ${item.desc || ''}`;
                    return text.toLowerCase().includes(search);
                });
                if (api.getActiveRegionId?.()) entries = entries.filter(item => api.entryInActiveRegion(item));
                if (!search) entries = atFolderLevel(entries, kind);
                entries = sortLibraryList(entries, sort.by === 'name' ? (sort.order === 'asc' ? 'name-asc' : 'name-desc') : sort.order === 'asc' ? 'oldest' : 'newest');
            }
            return { kind, search, folders: folders.map(folder => ({ folder, count: count(folder) })), entries };
        }

        // The custom move / ability / item / type editors, opened from My
        // Collection: the same editors as everywhere else, but as a panel sliding
        // in from the right (css/modals.css .as-sheet) to match the Fakemon editor.
        function openLibraryEditorSheet(kind, id = '') {
            if (kind === 'moves') { if (id) api.editCustomMoveLibrary?.(id, { sheet: true }); else api.openCustomMoveModal?.(undefined, { sheet: true }); }
            else if (kind === 'abilities') api.openCustomAbilityLibraryModal?.(id, { sheet: true });
            else if (kind === 'items') api.openCustomItemModal?.(id, null, { sheet: true });
            else if (kind === 'types') api.openCustomTypeEditor?.(id);
        }

        // Several independent things ask for a redraw in the same tick on boot and
        // after a save (the route, the auth refresh, the cloud manifest); they
        // collapse into one before the next frame.
        let collectionRenderQueued = false;
        function renderCollection() {
            if (collectionRenderQueued) return;
            collectionRenderQueued = true;
            queueMicrotask(() => {
                collectionRenderQueued = false;
                refreshCollection();
            });
        }

        // the upkeep a redraw brings with it, then the redraw itself
        function refreshCollection() {
            log.debug('COLLECTION', 'Rendering collection', { count: state.fakemonDB.length, folders: state.folders.length });
            // region copies of main-game moves/abilities/items that were opened and
            // closed without a change go away once nothing has them open
            const libraryEditorOpen = ['custom-move', 'custom-ability', 'custom-item'].some(isDialogOpen)
                || document.getElementById('ability-block-editor-view')?.style.display === 'block';
            if (!libraryEditorOpen) api.discardPendingVanillaCopies?.();
            api.discardPendingFakemon?.();
            api.syncCustomTypes?.();
            api.renderRegionSidebar?.();
            collectionReady = true;
            notify();
        }

        /** Boot, before storage has loaded: skeleton cards in the page's shape. */
        function renderCollectionSkeleton() {
            collectionReady = false;
            notify();
        }

        // the heading follows the region and folder; kept for callers that changed one
        function renderBreadcrumb() { notify(); }

        function closeCollectionFakemonExportMenus() { closeCardMenus(); }

        

export {
    openBoardPreview, closeCollectionFakemonExportMenus, showCollection, createNewFakemon, editFakemon, previewFakemon, switchTab, getEditorTab,
    setCollectionView, setCollectionSearch, collectionUI, collectionListing, renderCollection, renderCollectionSkeleton, renderBreadcrumb,
    createFolder, saveFolder, openFolder, renameFolder, deleteFolder, toggleFolderPin, toggleFakemonPin,
    moveFakemonToFolder, moveFakemonOutOfFolder, moveLibraryItemToFolder, moveLibraryItemOutOfFolder,
    deleteCustomLibraryItem, toggleCustomLibraryPin, duplicateCustomLibraryItem,
    handleCardDragStart, handleCardDragEnd, handleLibraryCardDragStart, dropOnFolder, getDraggedFakemonId, getDraggedLibraryItem,
    sortFakemonList, getFakemonBST, changeCollectionSort, toggleCollectionLayout, openLibraryEditorSheet,
    startNewFakemonEditor, openPokemonTemplateChooser, getPokemonTemplateEntries, templateMatches, usePokemonTemplate, getPokemonTemplateSprite
};
