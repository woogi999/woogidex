import { esc as escapeLibraryHtml } from '../core/html.js';
import { log } from '../core/log.js';
import { state, api } from '../core/app.js';
import { POKEMON_COLORS } from '../core/data.js';
import { cachedFetch } from '../core/net-cache.js';
// PokeAPI never rewrites a species entry, so a month is conservative.
const POKEAPI_CACHE = { cacheName: 'woogidex-pokeapi-v1', maxAgeMs: 30 * 86400000 };

// ==================== navigation ====================
        async function showCollection() {
            // leaving a shared/community preview is navigation, not an edit - don't force-save it into the user's own collection.
            const wasCommunityPreview = !!state.isCommunityPreview;
            state.isCommunityPreview = false;
            api.exitCommunityRoute?.();
            api.exitProfileRoute?.();
            document.getElementById('community-detail-view') && (document.getElementById('community-detail-view').style.display = 'none');
            document.getElementById('events-view') && (document.getElementById('events-view').style.display = 'none');
            document.getElementById('community-view') && (document.getElementById('community-view').style.display = 'none');
            if (!wasCommunityPreview && document.getElementById('editor-view')?.style.display !== 'none') {
                await api.autoSave(true);
            }
            api.activateTopLevelView?.('collection-view');
            setCollectionView(collectionView || 'fakemon');
            api.setRoute?.('collection', null);
        }
        // ==================== new Fakemon flow ====================
        async function createNewFakemon() {
            if (document.getElementById('editor-view')?.style.display !== 'none') {
                await api.autoSave(true);
            }
            const input = document.getElementById('new-fakemon-name');
            if (input) input.value = '';
            document.getElementById('new-fakemon-modal')?.classList.add('active');
            setTimeout(() => input?.focus(), 50);
        }

        function getNewFakemonName() {
            const input = document.getElementById('new-fakemon-name');
            const name = input?.value.trim() || '';
            if (!name) {
                api.showToast('Please enter a Pokemon name first!', 'error');
                input?.focus();
                return '';
            }
            return name;
        }

        async function startNewFakemonEditor(name, template) {
            api.autoSave(true);
            state.editingId = null;
            api.resetEditor();
            document.getElementById('fakemon-name').value = name;
            api.activateTopLevelView?.('editor-view');
            switchTab(null, 'basic');
            document.getElementById('new-fakemon-modal')?.classList.remove('active');
            document.getElementById('pokemon-template-modal')?.classList.remove('active');
            api.setRoute?.('editor', name || 'New Fakemon');

            // learnset hydrates immediately from the already-loaded Showdown dex; PokeAPI species/lore load async without blocking the editor.
            state.pendingVanillaId = template?.id || null;
            if (template) await applyPokemonTemplate(template, name);
            api.updatePreview();
            if (template) {
                // a first save gives it an id, which its evolution board needs
                await api.autoSave?.(true);
                state.pendingVanillaId = null;
                api.applyVanillaEvolutionLine?.(template.id);
            }
        }

        function createBlankFakemonFromModal() {
            const name = getNewFakemonName();
            if (name) startNewFakemonEditor(name, null);
        }

        function openPokemonTemplateChooser() {
            // name is optional for a vanilla template; falls back to the selected pokemon's name.
            if (!state.sdLoaded || !Object.keys(state.sdPokedex || {}).length) {
                api.showToast('Vanilla Pokemon data is still loading. Please try again in a moment.', 'info');
                return;
            }
            document.getElementById('new-fakemon-modal')?.classList.remove('active');
            const search = document.getElementById('pokemon-template-search');
            if (search) search.value = '';
            document.getElementById('pokemon-template-modal')?.classList.add('active');
            renderPokemonTemplateChooser();
            setTimeout(() => search?.focus(), 50);
        }

        function getPokemonTemplateEntries() {
            return Object.values(state.sdPokedex || {})
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

import { esc as escapeTemplateHtml } from '../core/html.js';

        function renderPokemonTemplateChooser() {
            const listEl = document.getElementById('pokemon-template-list');
            const statusEl = document.getElementById('pokemon-template-status');
            const query = (document.getElementById('pokemon-template-search')?.value || '').trim().toLowerCase();
            if (!listEl) return;
            const normalizedQuery = query.replace(/[^a-z0-9]/g, '');
            const entries = getPokemonTemplateEntries().filter(p => {
                if (!query) return true;
                const name = String(p.name || '').toLowerCase();
                const id = String(p.id || '').toLowerCase();
                const normalizedName = name.replace(/[^a-z0-9]/g, '');
                const normalizedId = id.replace(/[^a-z0-9]/g, '');
                return name.includes(query) || id.includes(query) || normalizedName.includes(normalizedQuery) || normalizedId.includes(normalizedQuery) || String(p.num||'').includes(query);
            });
            if (statusEl) statusEl.textContent = query ? `${entries.length} matching Pokemon` : `${entries.length} vanilla Pokemon available`;
            if (!entries.length) {
                listEl.innerHTML = '<div class="pokemon-template-empty">No Pokemon match that search.</div>';
                return;
            }
            listEl.innerHTML = entries.map(p => {
                const s=p.stats||{};
                const bst=['hp','atk','def','spa','spd','spe'].reduce((sum,k)=>sum+(Number(s[k])||0),0);
                const types=(p.types||[]).map(t=>`<span class="type-pill type-${String(t).toLowerCase()}">${escapeTemplateHtml(t)}</span>`).join('');
                return `<button class="pokemon-template-card" type="button" onclick="usePokemonTemplate('${escapeTemplateHtml(p.id)}')">
                    <img class="pokemon-template-sprite" src="${escapeTemplateHtml(getPokemonTemplateSprite(p))}" alt="${escapeTemplateHtml(p.name)}" loading="lazy" onerror="window.fallbackPokemonImage(this, '${String(p.name || '').replace(/'/g, "\\'")}', '${String(p.baseSpecies || '').replace(/'/g, "\\'")}')">
                    <span class="pokemon-template-info">
                        <span class="pokemon-template-number">#${String(p.num).padStart(3,'0')}</span>
                        <span class="pokemon-template-name">${escapeTemplateHtml(p.name)}</span>
                        <span class="pokemon-template-meta">${types}<span class="pokemon-template-bst">BST ${bst}</span></span>
                    </span>
                    <span class="pokemon-template-arrow">›</span>
                </button>`;
            }).join('');
        }

        function classifyTemplateLearnsetSource(sources) {
            const parsed=(Array.isArray(sources)?sources:[sources]).map(source=>{
                const text=String(source||'');
                const gen=Number(text.match(/^\d+/)?.[0]||0);
                const level=Number(text.match(/L(\d+)$/)?.[1]||0);
                if (level) return {gen,method:'level',level};
                if (/M$/.test(text)) return {gen,method:'tm',level:null};
                if (/E$/.test(text)) return {gen,method:'egg',level:null};
                if (/T$/.test(text)) return {gen,method:'tm',level:null};
                return null;
            }).filter(Boolean);
            parsed.sort((a,b)=>b.gen-a.gen || (a.method==='level'?0:1)-(b.method==='level'?0:1) || (a.level||999)-(b.level||999));
            return parsed[0]||{gen:0,method:'none',level:null};
        }

        function getPokemonTemplateLearnset(pokemon) {
            const raw=state.sdLearnsets?.[pokemon.id] || state.sdLearnsets?.[String(pokemon.id).replace(/-/g,'')] || state.sdLearnsets?.[String(pokemon.name || '').toLowerCase().replace(/[^a-z0-9]/g,'')] || {};
            const order={level:0,egg:1,tm:2,none:3};
            const unique=new Map();
            Object.entries(raw).forEach(([moveId,sources])=>{
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
            const entries=Object.entries(pokemon.abilities||{});
            const normal=entries.filter(([slot,name])=>name && !/^H$/i.test(String(slot)) && !/hidden/i.test(String(slot))).map(([,name])=>String(name));
            const hidden=entries.find(([slot,name])=>name && (/^H$/i.test(String(slot)) || /hidden/i.test(String(slot))));
            if(hidden) normal.push(String(hidden[1]));
            return [...new Set(normal)].slice(0,4).map(name=>{
                const normalized=name.toLowerCase().replace(/[^a-z0-9]/g,'');
                const entry=Object.entries(state.sdAbilities||{}).find(([key,a]) => String(key).toLowerCase().replace(/[^a-z0-9]/g,'')===normalized || String(a?.name||'').toLowerCase().replace(/[^a-z0-9]/g,'')===normalized);
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

            let species = null;
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
                } catch (formErr) {
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
                const lore = [];
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
            } catch (err) {
                log.warn('POKEAPI', 'Could not load species data for template', { template: template?.name, error: err });
                return null;
            }
        }

        async function applyPokemonTemplate(template,newName) {
            const stats=template.stats||{};
            document.getElementById('fakemon-name').value=newName;
            // species/genus and pokédex lore are supplied asynchronously by PokeAPI.
            document.getElementById('fakemon-species').value='';
            document.getElementById('dex-entry1').value='';
            document.getElementById('dex-entry2').value='';
            selectType('type1',template.types?.[0]||'');
            selectType('type2',template.types?.[1]||'');
            ['hp','atk','def','spa','spd','spe'].forEach(stat=>{
                const input=document.getElementById('stat-'+stat);
                if(input) input.value=clampTemplateBaseStatValue(stats[stat]??60);
            });
            document.getElementById('fakemon-height').value=template.heightm||'';
            document.getElementById('height-unit').value='m';
            document.getElementById('fakemon-height').dataset.lastUnit='m';
            document.getElementById('fakemon-weight').value=template.weightkg||'';
            document.getElementById('weight-unit').value='kg';
            document.getElementById('fakemon-weight').dataset.lastUnit='kg';
            document.getElementById('fakemon-color').value=template.color||'';
            document.querySelectorAll('.color-option').forEach(el=>el.classList.remove('selected'));
            const colorOption=[...document.querySelectorAll('.color-option')].find(el=>el.title===template.color);
            if(colorOption) colorOption.classList.add('selected');
            setEggGroupValue((template.eggGroups||[]).join(', ')||'None');
            setGenderRatioValue(getTemplateGenderRatio(template));
            state.abilities=getTemplateAbilities(template);
            state.learnset=getPokemonTemplateLearnset(template);
            // learnset entries are minimal; rehydrate so move details are available on first render.
            if (state.sdLoaded && state.learnset.length && typeof api.rehydrateCurrentLearnsetFromShowdown === 'function') {
                api.rehydrateCurrentLearnsetFromShowdown();
            }
            state.sampleSets=[];
            state.artworkData=getPokemonTemplateSprite(template);
            const preview=document.getElementById('artwork-preview');
            if(preview) preview.innerHTML=`<img src="${escapeTemplateHtml(state.artworkData)}" alt="Template artwork">`;
            renderAbilities();
            renderLearnset();
            renderCustomMoves();
            renderSampleSets();
            updateStats();
            updateGenderBar();
            api.updatePreview();

            // supplies the official genus (species/category field) and english flavor-text entries.
            const speciesData = await fetchPokemonSpeciesTemplateData(template);
            if (speciesData) {
                if (speciesData.genus) document.getElementById('fakemon-species').value = speciesData.genus;
                if (speciesData.dexEntries[0]) document.getElementById('dex-entry1').value = speciesData.dexEntries[0];
                if (speciesData.dexEntries[1]) document.getElementById('dex-entry2').value = speciesData.dexEntries[1];
                api.updatePreview();
            }
        }

        async function usePokemonTemplate(id) {
            await api.ensureLearnsets?.(); // Learnsets load lazily
            const template=state.sdPokedex?.[id];
            if(!template) { api.showToast('That Pokemon could not be loaded. Please try another.', 'error'); return; }
            const enteredName=(document.getElementById('new-fakemon-name')?.value || '').trim();
            const name=enteredName || template.name || 'Fakemon';
            startNewFakemonEditor(name,template);
            api.showToast(`Loading ${template.name} species data...`, 'info');
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
            api.setRoute?.(`editor/${encodeURIComponent(id)}`, fakemon.name || 'Editor');
            maybeAutoplayCry(fakemon);
        }

        // Plays a Fakemon's cry on render if autoplay is on; shared by editFakemon/previewFakemon since both reuse the board-render pipeline.
        function maybeAutoplayCry(fakemon) {
            if (!fakemon?.cry) return;
            if (!api.getAutoplayCry?.()) return;
            try { new Audio(fakemon.cry).play().catch(() => {}); } catch {}
        }
        // the editor's own tabs only: the collection's tab strip stays on screen
        // underneath the editor sheet and must keep its own .active
        function switchTab(tabEl, tabName) {
            const editor = document.getElementById('editor-view');
            if (!editor) return;
            editor.querySelectorAll('.editor-tabs .tab').forEach(t => t.classList.remove('active'));
            editor.querySelectorAll('.tab-content').forEach(t => t.style.display = 'none');
            (tabEl || editor.querySelector(`.editor-tabs .tab[onclick*="'${tabName}'"]`))?.classList.add('active');
            const target = document.getElementById(`tab-${tabName}`);
            target.style.display = 'block';
            // force a reflow between removing/re-adding the class so the enter animation replays on every switch, not just the first.
            target.classList.remove('tab-content-enter');
            void target.offsetWidth;
            target.classList.add('tab-content-enter');
            if (tabName === 'moves') {
                setTimeout(() => api.toggleLevelInput(), 10);
            }
            if (tabName === 'stats') {
                setTimeout(() => api.renderEvolutionBoard?.(), 10);
            }
            if (tabName === 'analysis') {
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
            // the board's markup is read back on the next line, so it has to exist now
            api.updatePreviewNow();
            const source = document.getElementById('pokedex-board-container');
            const wrap = document.getElementById('preview-modal-board-wrap');
            wrap.innerHTML = source.innerHTML.replace(/id="pokedex-board-export"/, 'id="pokedex-board-preview-modal"');
            const editBtn = document.getElementById('preview-modal-edit-btn');
            editBtn.onclick = () => { api.closeModal('fakemon-preview-modal'); editFakemon(id); };
            document.getElementById('fakemon-preview-modal').classList.add('active');
            maybeAutoplayCry(fakemon);
        }

// ==================== create menu ====================
        function toggleCreateMenu(event) {
            if (event) event.stopPropagation();
            const menu = document.getElementById('create-menu');
            if (!menu) return;
            menu.style.display = menu.style.display === 'none' || !menu.style.display ? 'block' : 'none';
        }
        function closeCreateMenu() {
            const menu = document.getElementById('create-menu');
            if (menu) menu.style.display = 'none';
        }
        document.addEventListener('click', (event) => {
            if (!event.target.closest('.export-as-wrap')) closeCreateMenu();
        });

// ==================== folders ====================
        let folderNameModalMode = 'create'; // 'create' | 'rename'
        let folderNameModalTargetId = null;
        let folderColorSelection = null;

        function buildFolderColorSwatches(selectedHex) {
            const container = document.getElementById('folder-color-options');
            if (!container) return;
            const noneSwatch = `<div class="color-option folder-color-none${!selectedHex ? ' selected' : ''}" title="None" onclick="selectFolderColor(null)"><i data-lucide="slash" style="width:14px;height:14px;"></i></div>`;
            const swatches = POKEMON_COLORS.map(c => {
                const sel = c.hex === selectedHex ? ' selected' : '';
                return `<div class="color-option${sel}" style="background-color:${c.hex};" title="${c.name}" onclick="selectFolderColor('${c.hex}')"></div>`;
            }).join('');
            container.innerHTML = noneSwatch + swatches;
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }
        function selectFolderColor(hex) {
            folderColorSelection = hex;
            buildFolderColorSwatches(hex);
        }
        function createFolder() {
            folderNameModalMode = 'create';
            folderNameModalTargetId = null;
            folderColorSelection = null;
            document.getElementById('folder-name-modal-title').textContent = 'New Folder';
            const input = document.getElementById('folder-name-input');
            input.value = '';
            buildFolderColorSwatches(null);
            document.getElementById('folder-name-modal').classList.add('active');
            setTimeout(() => input.focus(), 50);
        }
        function renameFolder(id, event) {
            if (event) event.stopPropagation();
            const folder = state.folders.find(f => f.id === id);
            if (!folder) return;
            folderNameModalMode = 'rename';
            folderNameModalTargetId = id;
            folderColorSelection = folder.color || null;
            document.getElementById('folder-name-modal-title').textContent = 'Rename Folder';
            const input = document.getElementById('folder-name-input');
            input.value = folder.name;
            buildFolderColorSwatches(folderColorSelection);
            document.getElementById('folder-name-modal').classList.add('active');
            setTimeout(() => { input.focus(); input.select(); }, 50);
        }
        function confirmFolderName() {
            const name = document.getElementById('folder-name-input').value.trim();
            if (!name) { api.showToast('Please enter a folder name!', 'error'); return; }
            if (folderNameModalMode === 'rename' && folderNameModalTargetId) {
                const folder = state.folders.find(f => f.id === folderNameModalTargetId);
                if (folder) { folder.name = name; folder.color = folderColorSelection || null; }
            } else {
                state.folders.push({
                    id: 'folder_' + Date.now().toString(),
                    name: name,
                    color: folderColorSelection || null,
                    pinned: false,
                    type: collectionView,
                    createdAt: Date.now()
                });
            }
            api.saveToStorage();
            renderCollection();
            api.closeModal('folder-name-modal');
            api.showToast(folderNameModalMode === 'rename' ? 'Folder renamed!' : 'Folder created!', 'success');
        }
        function openFolder(id) {
            state.currentFolderId = id;
            document.getElementById('search-input').value = '';
            renderCollection();
        }
        function deleteFolder(id, event) {
            if (event) event.stopPropagation();
            const folder = state.folders.find(f => f.id === id);
            if (!folder) return;
            const kind = folder.type || 'fakemon';
            const label = kind === 'moves' ? 'Moves' : kind === 'abilities' ? 'Abilities' : 'Fakemon';
            if (!confirm(`Delete "${folder.name}"? ${label} inside will be moved back to My Collection.`)) return;
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
        function moveLibraryItemToFolder(kind, itemId, folderId) {
            const arr = kind === 'moves' ? state.customMoves : kind === 'abilities' ? state.customAbilities : state.customItems;
            const item = (arr || []).find(x => x.id === itemId);
            if (!item) return;
            item.folderId = folderId || null;
            api.saveToStorage();
            renderCollection();
            const folder = state.folders.find(f => f.id === folderId);
            api.showToast(folder ? `Moved to "${folder.name}"!` : 'Moved to My Collection!', 'success');
        }
        function moveLibraryItemOutOfFolder(kind, itemId, event) {
            if (event) event.stopPropagation();
            moveLibraryItemToFolder(kind, itemId, null);
        }
        function toggleCustomLibraryPin(kind, id, event) {
            if (event) event.stopPropagation();
            const arr = kind === 'moves' ? state.customMoves : kind === 'abilities' ? state.customAbilities : state.customItems;
            const item = (arr || []).find(x => x.id === id);
            if (!item) return;
            item.pinned = !item.pinned;
            api.saveToStorage();
            renderCollection();
            api.showToast(item.pinned ? `"${item.name}" pinned!` : `"${item.name}" unpinned!`, 'success');
        }

        function duplicateCustomLibraryItem(kind, id, event) {
            if (event) event.stopPropagation();
            const arr = kind === 'moves' ? state.customMoves : kind === 'abilities' ? state.customAbilities : state.customItems;
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

        function deleteCustomLibraryItem(kind, id, event) {
            if (event) event.stopPropagation();
            const arr = kind === 'moves' ? state.customMoves : kind === 'abilities' ? state.customAbilities : state.customItems;
            const item = (arr || []).find(x => x.id === id);
            if (!item) return;
            if (!confirm(`Delete "${item.name}" from your ${kind === 'moves' ? 'move' : 'ability'} library?`)) return;
            if (kind === 'moves') state.customMoves = state.customMoves.filter(x => x.id !== id);
            else if (kind === 'abilities') state.customAbilities = state.customAbilities.filter(x => x.id !== id);
            else state.customItems = state.customItems.filter(x => x.id !== id);
            api.saveToStorage();
            renderCollection();
            api.showToast(`${kind === 'moves' ? 'Move' : 'Ability'} deleted!`, 'info');
        }
        function toggleFolderPin(id, event) {
            if (event) event.stopPropagation();
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
            if (event) event.stopPropagation();
            moveFakemonToFolder(fakemonId, null);
        }
        function toggleFakemonPin(id, event) {
            if (event) event.stopPropagation();
            const fakemon = state.fakemonDB.find(f => f.id === id);
            if (!fakemon) return;
            fakemon.pinned = !fakemon.pinned;
            api.saveToStorage();
            renderCollection();
            api.showToast(fakemon.pinned ? `"${fakemon.name}" pinned!` : `"${fakemon.name}" unpinned!`, 'success');
        }

        // ---- drag & drop wiring ----
        let draggedFakemonId = null;
        let draggedLibraryItem = null; // { kind, id }
        function handleCardDragStart(id, event) {
            draggedFakemonId = id;
            draggedLibraryItem = null;
            event.dataTransfer.effectAllowed = 'move';
            try { event.dataTransfer.setData('text/plain', id); } catch (e) {}
        }
        // regions.js accepts Fakemon cards dropped on the sidebar
        function getDraggedFakemonId() { return draggedFakemonId; }
        function getDraggedLibraryItem() { return draggedLibraryItem; }
        function handleCardDragEnd() {
            draggedFakemonId = null;
            draggedLibraryItem = null;
            document.querySelectorAll('.folder-card.drag-over').forEach(el => el.classList.remove('drag-over'));
        }
        function handleLibraryCardDragStart(kind, id, event) {
            draggedFakemonId = null;
            draggedLibraryItem = { kind, id };
            event.dataTransfer.effectAllowed = 'move';
            try { event.dataTransfer.setData('text/plain', id); } catch (e) {}
        }
        function handleFolderDragOver(event) {
            event.preventDefault();
            event.currentTarget.classList.add('drag-over');
        }
        function handleFolderDragLeave(event) {
            event.currentTarget.classList.remove('drag-over');
        }
        function handleFolderDrop(folderId, event) {
            event.preventDefault();
            event.currentTarget.classList.remove('drag-over');
            if (draggedLibraryItem) {
                moveLibraryItemToFolder(draggedLibraryItem.kind, draggedLibraryItem.id, folderId);
            } else {
                const id = draggedFakemonId || (event.dataTransfer && event.dataTransfer.getData('text/plain'));
                if (id) moveFakemonToFolder(id, folderId);
            }
            draggedFakemonId = null;
            draggedLibraryItem = null;
        }

// ==================== collection ====================
        let collectionView = 'fakemon';

        const COLLECTION_LAYOUT_KEY = 'woogidex.collection.layout.v1';
        let collectionLayout = (() => {
            try { return localStorage.getItem(COLLECTION_LAYOUT_KEY) === 'list' ? 'list' : 'grid'; }
            catch { return 'grid'; }
        })();

        function applyCollectionLayoutUI() {
            const grid = document.getElementById('collection-grid');
            const btn = document.getElementById('collection-layout-toggle');
            if (grid) grid.classList.toggle('collection-list', collectionLayout === 'list');
            if (btn) {
                const isList = collectionLayout === 'list';
                btn.setAttribute('aria-pressed', String(isList));
                btn.title = isList ? 'Switch to grid view' : 'Switch to list view';
                btn.innerHTML = `<i data-lucide="${isList ? 'layout-grid' : 'list'}" aria-hidden="true"></i>`;
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        }

        function toggleCollectionLayout() {
            collectionLayout = collectionLayout === 'list' ? 'grid' : 'list';
            try { localStorage.setItem(COLLECTION_LAYOUT_KEY, collectionLayout); } catch {}
            applyCollectionLayoutUI();
            renderCollection();
        }

        const COLLECTION_SORT_KEY = 'woogidex.collection.sort.v2';

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

        function saveCollectionSortPrefs(prefs) {
            try { localStorage.setItem(COLLECTION_SORT_KEY, JSON.stringify(prefs)); } catch {}
        }

        function getCollectionSortPrefsFromUI() {
            const saved = getCollectionSortPrefs();
            const byEl = document.getElementById('collection-sort-by');
            const orderEl = document.getElementById('collection-sort-order');
            return {
                by: byEl?.value || saved.by,
                order: orderEl?.value === 'asc' ? 'asc' : orderEl?.value === 'desc' ? 'desc' : saved.order
            };
        }

        function applyCollectionSortUI() {
            const prefs = getCollectionSortPrefs();
            const byEl = document.getElementById('collection-sort-by');
            const orderEl = document.getElementById('collection-sort-order');
            if (byEl) {
                const hasSavedBy = [...byEl.options].some(o => o.value === prefs.by);
                byEl.value = hasSavedBy ? prefs.by : (byEl.options[0]?.value || 'name');
            }
            if (orderEl) orderEl.value = prefs.order;
            return {
                by: byEl?.value || prefs.by,
                order: orderEl?.value === 'asc' ? 'asc' : 'desc'
            };
        }

        function changeCollectionSort() {
            const prefs = getCollectionSortPrefsFromUI();
            saveCollectionSortPrefs(prefs);
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
            const text = v => String(v ?? '').localeCompare(String(v ?? ''), undefined, { sensitivity: 'base' });
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

        function renderBreadcrumb() {
            const el = document.getElementById('collection-heading');
            if (!el) return;
            const region = api.activeRegionBreadcrumb?.() || null;
            const bannerEl = document.getElementById('collection-region-banner');
            if (bannerEl) {
                const showBanner = !!(region && region.banner);
                bannerEl.hidden = !showBanner;
                bannerEl.style.backgroundImage = showBanner ? `url('${region.banner}')` : '';
            }
            const exportLabel = document.querySelector('#collection-export-btn span');
            if (exportLabel) exportLabel.textContent = api.getActiveRegion?.() ? `Export ${api.getActiveRegion().name}` : 'Export';
            if (region) {
                el.innerHTML = `
                    <span class="breadcrumb-root" onclick="selectRegion(null)" style="cursor:pointer;">My Collection</span>
                    <span class="breadcrumb-sep" style="color:var(--text-muted);"> / </span>
                    <span class="breadcrumb-current">${region.color ? `<span class="region-dot region-dot-lg" style="--region-color:${escapeCollectionHtml(region.color)}"></span>` : ''}${escapeCollectionHtml(region.name)}</span>
                `;
                const sub = document.querySelector('#collection-header-row .page-subtitle');
                if (sub) sub.textContent = region.description || 'Everything in this region.';
                return;
            }
            const sub = document.querySelector('#collection-header-row .page-subtitle');
            if (sub) sub.textContent = 'Your Fakémon, folders, and custom moves, abilities and items.';
            if (!state.currentFolderId) {
                el.innerHTML = `<span class="breadcrumb-root" onclick="openFolder(null)" style="cursor:pointer;">My Collection</span>`;
                return;
            }
            const folder = state.folders.find(f => f.id === state.currentFolderId);
            const folderName = folder ? folder.name : 'Folder';
            el.innerHTML = `
                <span class="breadcrumb-root" onclick="openFolder(null)" style="cursor:pointer;">My Collection</span>
                <span class="breadcrumb-sep" style="color:var(--text-muted);"> / </span>
                <span class="breadcrumb-current">${escapeCollectionHtml(folderName)}</span>
            `;
        }

        function setCollectionView(view) {
            const newView = ['fakemon', 'moves', 'abilities', 'items', 'types'].includes(view) ? view : 'fakemon';
            // choosing a tab leaves a region's details page
            if (api.isRegionDetailsOpen?.()) api.closeRegionDetails?.();
            if (newView !== collectionView) state.currentFolderId = null;
            collectionView = newView;
            document.querySelectorAll('[data-collection-view]').forEach(tab => {
                const on = tab.dataset.collectionView === collectionView;
                tab.classList.toggle('active', on);
                tab.setAttribute('aria-selected', String(on));
            });

            const searchInput = document.getElementById('search-input');
            const sortBy = document.getElementById('collection-sort-by');
            const sortOrder = document.getElementById('collection-sort-order');
            const importBtn = document.getElementById('collection-import-btn');
            const exportBtn = document.getElementById('collection-export-btn');
            const fakemonCreate = document.getElementById('create-fakemon-menu-item');
            const folderCreate = document.getElementById('create-folder-menu-item');
            const moveCreate = document.getElementById('create-move-menu-item');
            const abilityCreate = document.getElementById('create-ability-menu-item');
            const itemCreate = document.getElementById('create-item-menu-item');
            const shinyToggle = document.getElementById('collection-shiny-toggle');

            if (collectionView === 'fakemon') {
                if (shinyToggle) shinyToggle.style.display = 'inline-flex';
                if (searchInput) searchInput.placeholder = 'Search your Fakemon...';
                if (sortBy) {
                    sortBy.innerHTML = `
                        <option value="created">Date Added</option>
                        <option value="name">Name</option>
                        <option value="number">Pokédex Number</option>
                        <option value="bst">BST</option>
                        <option value="updated">Last Updated</option>`;
                }
                if (sortOrder) sortOrder.innerHTML = '<option value="desc">Descending</option><option value="asc">Ascending</option>';
                applyCollectionSortUI();
                if (importBtn) importBtn.style.display = '';
                if (exportBtn) exportBtn.style.display = '';
                if (fakemonCreate) fakemonCreate.style.display = '';
                if (folderCreate) folderCreate.style.display = '';
                if (moveCreate) moveCreate.style.display = '';
                if (abilityCreate) abilityCreate.style.display = '';
                if (itemCreate) itemCreate.style.display = '';
            } else {
                if (shinyToggle) shinyToggle.style.display = 'none';
                if (searchInput) searchInput.placeholder = collectionView === 'moves' ? 'Search your custom moves...' : collectionView === 'abilities' ? 'Search your custom abilities...' : collectionView === 'types' ? 'Search your custom types...' : 'Search your custom items...';
                if (sortBy) {
                    sortBy.innerHTML = '<option value="name">Name</option><option value="created">Date Added</option><option value="updated">Last Updated</option>';
                }
                if (sortOrder) sortOrder.innerHTML = '<option value="asc">Ascending</option><option value="desc">Descending</option>';
                applyCollectionSortUI();
                if (importBtn) importBtn.style.display = '';
                if (exportBtn) exportBtn.style.display = '';
                if (fakemonCreate) fakemonCreate.style.display = '';
                if (folderCreate) folderCreate.style.display = '';
                if (moveCreate) moveCreate.style.display = '';
                if (abilityCreate) abilityCreate.style.display = '';
                if (itemCreate) itemCreate.style.display = '';
                if (shinyToggle) shinyToggle.style.display = 'none';
            }
            renderCollection();
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

import { esc as escapeCollectionHtml } from '../core/html.js';

        function renderCustomLibraryCollection(kind) {
            const grid = document.getElementById('collection-grid');
            const empty = document.getElementById('empty-collection');
            const search = (document.getElementById('search-input')?.value || '').trim().toLowerCase();
            const sortPrefs = getCollectionSortPrefsFromUI();
            const isMove = kind === 'moves';
            const isAbility = kind === 'abilities';
            const source = isMove ? (state.customMoves || []) : isAbility ? (state.customAbilities || []) : (state.customItems || []);
            let items = source.filter(item => {
                if (!search) return true;
                const text = isMove
                    ? `${item.name || ''} ${item.type || ''} ${item.category || ''} ${item.desc || ''}`
                    : `${item.name || ''} ${item.desc || ''}`;
                return text.toLowerCase().includes(search);
            });
            const inRegion = !!api.getActiveRegionId?.();
            if (inRegion) items = items.filter(item => api.entryInActiveRegion(item));
            else if (!search) items = items.filter(item => (item.folderId || null) === state.currentFolderId);
            items = sortLibraryList(items, sortPrefs.by === 'name' ? (sortPrefs.order === 'asc' ? 'name-asc' : 'name-desc') : sortPrefs.order === 'asc' ? 'oldest' : 'newest');

            // folders only show at the root level, and only while not searching.
            let folders = (!search && !state.currentFolderId && !inRegion) ? state.folders.filter(f => f.type === kind) : [];
            folders.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

            const vanillaCards = collectionLayout === 'list' ? '' : (api.regionVanillaLibraryCards?.(kind, search) || '');
            // an empty library still gets its "Add new" card; the message is for a search that found nothing
            if (search && !items.length && !folders.length && !vanillaCards) {
                grid.style.display = 'grid';
                grid.innerHTML = '';
                empty.style.display = 'block';
                const label = isMove ? 'custom moves' : isAbility ? 'custom abilities' : 'custom items';
                const title = isMove ? 'Custom Moves' : isAbility ? 'Custom Abilities' : 'Custom Items';
                const singular = isMove ? 'move' : isAbility ? 'ability' : 'item';
                empty.querySelector('h3').textContent = search ? `No ${label} found` : `No ${title} Yet`;
                empty.querySelector('p').textContent = search ? 'Try a different search.' : `Create your first custom ${singular} to get started!`;
                const emptyButton = empty.querySelector('button');
                if (emptyButton) {
                    emptyButton.textContent = `Create Custom ${singular.charAt(0).toUpperCase() + singular.slice(1)}`;
                    emptyButton.onclick = () => isMove ? api.openCustomMoveChooser() : isAbility ? api.openCustomAbilityChooser() : api.openCustomItemModal();
                }
                return;
            }

            empty.style.display = 'none';
            grid.style.display = collectionLayout === 'list' ? 'flex' : 'grid';

            const folderCards = folders.map(folder => {
                const count = source.filter(item => item.folderId === folder.id).length;
                const color = folder.color || null;
                const cardStyle = color ? `border-color:${color};background:color-mix(in srgb, ${color} 10%, var(--bg-panel));` : '';
                const iconStyle = color ? `color:${color};` : '';
                return `
                    <div class="collection-card folder-card${folder.pinned ? ' pinned' : ''}" style="${cardStyle}" ondragover="handleFolderDragOver(event)" ondragleave="handleFolderDragLeave(event)" ondrop="handleFolderDrop('${folder.id}', event)" onclick="openFolder('${folder.id}')">
                        <div class="card-actions">
                            <button class="${folder.pinned ? 'pinned-btn' : ''}" onclick="toggleFolderPin('${folder.id}', event)" title="${folder.pinned ? 'Unpin' : 'Pin'}"><i data-lucide="pin" style="width:14px;height:14px;"></i></button>
                            <button onclick="renameFolder('${folder.id}', event)" title="Rename / Color"><i data-lucide="pencil" style="width:14px;height:14px;"></i></button>
                            <button class="card-delete-btn" onclick="deleteFolder('${folder.id}', event)" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
                        </div>
                        <div class="card-art folder-card-art" style="${iconStyle}"><i data-lucide="folder" style="width:48px;height:48px;"></i></div>
                        <div class="card-body">
                        <div class="card-name">${escapeCollectionHtml(folder.name)}</div>
                        <div class="card-bst">${count} ${isMove ? 'Move' : isAbility ? 'Ability' : 'Item'}${count === 1 ? '' : 's'}</div>
                        </div>
                    </div>
                `;
            }).join('');

            const itemCards = items.map(item => libraryCard(kind, item, !!item.folderId && !search)).join('');

            grid.innerHTML = (search ? '' : addNewCardHtml(kind)) + folderCards + itemCards + vanillaCards;
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        // One action row for every custom-library card, so grid and list layouts can't drift apart.
        function libraryCardActions(kind, item, inFolder) {
            const id = escapeCollectionHtml(item.id);
            const singular = kind === 'moves' ? 'move' : kind === 'abilities' ? 'ability' : 'item';
            return `
                <button class="${item.pinned ? 'pinned-btn' : ''}" onclick="toggleCustomLibraryPin('${kind}','${id}', event)" title="${item.pinned ? 'Unpin' : 'Pin'}"><i data-lucide="pin" style="width:14px;height:14px"></i></button>
                <button onclick="openLibraryEditorSheet('${kind}','${id}');event.stopPropagation();" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px"></i></button>
                ${inFolder ? `<button onclick="moveLibraryItemOutOfFolder('${kind}','${id}', event)" title="Remove from folder"><i data-lucide="folder-output" style="width:14px;height:14px;"></i></button>` : ''}
                <button onclick="duplicateCustomLibraryItem('${kind}','${id}', event)" title="Duplicate"><i data-lucide="copy" style="width:14px;height:14px"></i></button>
                <div class="collection-card-export-wrap"><button onclick="exportCustomLibraryItem('${singular}','${id}');event.stopPropagation();" title="Export"><i data-lucide="download" style="width:14px;height:14px"></i></button></div>
                <button class="card-delete-btn" onclick="deleteCustomLibraryItem('${kind}','${id}', event)" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px"></i></button>`;
        }

        // Moves/items/abilities differ only in what they display, described once
        // here and laid out once below, on the same card frame as a Fakemon.
        const CATEGORY_ICONS = { Physical: 'swords', Special: 'sparkle', Status: 'circle-dot' };
        function libraryCardParts(kind, item) {
            if (kind === 'moves') {
                const type = String(item.type || 'Normal');
                const category = String(item.category || 'Status');
                const acc = (item.accuracy === true || item.accuracy === undefined || item.accuracy === false)
                    ? '—' : `${item.accuracy}%`;
                return {
                    // the move's own image if it has one; otherwise the type's colour fills
                    // the emblem and the category is its icon
                    art: item.artwork
                        ? `<img src="${item.artwork}" alt="" draggable="false" loading="lazy" decoding="async">`
                        : `<span class="library-emblem type-${escapeCollectionHtml(type.toLowerCase())}"><i data-lucide="${CATEGORY_ICONS[category] || 'zap'}"></i></span>`,
                    corner: escapeCollectionHtml(category),
                    pills: `<span class="type-badge type-${escapeCollectionHtml(type.toLowerCase())}">${escapeCollectionHtml(type)}</span>`,
                    meta: `<span class="card-bst"><em>BP</em>${escapeCollectionHtml(item.basePower || '—')}</span><span class="card-bst"><em>ACC</em>${escapeCollectionHtml(acc)}</span><span class="card-bst"><em>PP</em>${escapeCollectionHtml(item.pp || '—')}</span>`
                };
            }
            // no stats to show: the description's first line takes the meta row
            const descLine = `<span class="library-tile-desc${item.desc ? '' : ' is-empty'}">${escapeCollectionHtml(item.desc || 'No description')}</span>`;
            if (kind === 'items') {
                return {
                    art: item.artwork
                        ? `<img src="${item.artwork}" alt="${escapeCollectionHtml(item.name)} artwork" draggable="false" loading="lazy" decoding="async">`
                        : '<span class="library-emblem library-emblem-plain"><i data-lucide="gem"></i></span>',
                    corner: '',
                    pills: `<span class="library-tag">${item.isMegaStone ? 'Mega Stone' : 'Item'}</span>`,
                    meta: descLine
                };
            }
            return {
                art: item.artwork
                    ? `<img src="${item.artwork}" alt="" draggable="false" loading="lazy" decoding="async">`
                    : '<span class="library-emblem library-emblem-plain"><i data-lucide="sparkles"></i></span>',
                corner: '',
                // no badge row for abilities: it only ever said "Ability"
                pills: null,
                meta: descLine
            };
        }

        function libraryCard(kind, item, inFolder) {
            const id = escapeCollectionHtml(item.id);
            const { art, corner, pills, meta } = libraryCardParts(kind, item);
            // the full description is the tooltip; the tile keeps the Fakemon
            // card's three lines (name, one detail line, badges) so both are one size
            const desc = String(item.desc || '').trim();
            return `<div class="collection-card library-tile${item.pinned ? ' pinned' : ''}" draggable="true" ondragstart="handleLibraryCardDragStart('${kind}','${id}', event)" ondragend="handleCardDragEnd()" onclick="openLibraryEditorSheet('${kind}','${id}')"${desc ? ` title="${escapeCollectionHtml(desc)}"` : ''}>
                <div class="card-actions">${libraryCardActions(kind, item, inFolder)}</div>
                <div class="card-art">${art}${corner ? `<span class="card-number library-tile-corner">${corner}</span>` : ''}${item.vanillaId ? '<span class="vanilla-card-tag">Edited</span>' : ''}</div>
                <div class="card-body">
                    <div class="card-name" title="${escapeCollectionHtml(item.name)}">${escapeCollectionHtml(item.name)}</div>
                    <div class="card-meta-row">${meta}</div>
                    ${pills === null
                        // keeps the row's height, so ability cards stay the size of the others
                        ? '<div class="card-types card-types-spacer" aria-hidden="true"></div>'
                        : `<div class="card-types">${pills}</div>`}
                </div>
            </div>`;
        }

        // The custom move / ability / item editors, opened from My Collection:
        // the same forms as everywhere else, but as a panel sliding in from the
        // right (css/modals.css .as-sheet) to match the Fakemon editor. The
        // openers clear .as-sheet, so opened from the editor they stay modals.
        const LIBRARY_EDITOR_MODALS = { moves: 'custom-move-modal', abilities: 'custom-ability-modal', items: 'custom-item-modal' };
        function openLibraryEditorSheet(kind, id = '') {
            if (kind === 'moves') { if (id) api.editCustomMoveLibrary?.(id); else api.openCustomMoveModal?.(); }
            else if (kind === 'abilities') api.openCustomAbilityLibraryModal?.(id);
            else if (kind === 'items') api.openCustomItemModal?.(id);
            else if (kind === 'types') { api.openCustomTypeEditor?.(id); return; }
            else return;
            document.getElementById(LIBRARY_EDITOR_MODALS[kind])?.classList.add('as-sheet');
        }

        // The first tile of each library: "Add new ...", the same action as the
        // Create menu's matching item. Left out while searching, where it would
        // read as a result.
        const ADD_NEW = {
            fakemon: { label: 'Fakémon', run: 'createNewFakemon()' },
            moves: { label: 'move', run: "openLibraryEditorSheet('moves')" },
            abilities: { label: 'ability', run: "openLibraryEditorSheet('abilities')" },
            items: { label: 'item', run: "openLibraryEditorSheet('items')" },
            types: { label: 'type', run: "openLibraryEditorSheet('types')" }
        };
        function addNewCardHtml(kind) {
            const spec = ADD_NEW[kind];
            if (!spec) return '';
            return `<button type="button" class="collection-card collection-add-card" onclick="${spec.run}">
                <span class="card-art"><span class="collection-add-icon"><i data-lucide="plus"></i></span></span>
                <span class="card-body"><span class="card-name">Add new ${spec.label}</span></span>
            </button>`;
        }

        // mirrors the real card markup so the first paint (before storage loads) has the right shape and swapping in real cards causes no layout shift.
        function collectionCardSkeleton() {
            return `
                <div class="collection-card skel-card">
                    <div class="card-art skel"></div>
                    <div class="card-body">
                        <div class="skel skel-text skel-name"></div>
                        <div class="skel skel-text skel-bst"></div>
                        <div class="card-types">
                            <span class="skel skel-pill"></span>
                            <span class="skel skel-pill"></span>
                        </div>
                    </div>
                </div>
            `;
        }

        function renderCollectionSkeleton(count = 8) {
            const grid = document.getElementById('collection-grid');
            const empty = document.getElementById('empty-collection');
            if (!grid) return;
            if (empty) empty.style.display = 'none';
            grid.innerHTML = Array.from({ length: count }, () => collectionCardSkeleton()).join('');
        }

        // one action row, shared by grid and list layouts so neither can drift.
        function collectionCardActions(f, search) {
            const inFolder = !!f.folderId && !search;
            return `
                <button class="${f.pinned ? 'pinned-btn' : ''}" onclick="toggleFakemonPin('${f.id}', event)" title="${f.pinned ? 'Unpin' : 'Pin'}"><i data-lucide="pin" style="width:14px;height:14px;"></i></button>
                <button onclick="editFakemon('${f.id}'); event.stopPropagation();" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px;"></i></button>
                ${inFolder ? `<button onclick="moveFakemonOutOfFolder('${f.id}', event)" title="Remove from folder"><i data-lucide="folder-output" style="width:14px;height:14px;"></i></button>` : ''}
                <button onclick="duplicateFakemon('${f.id}', event)" title="Duplicate"><i data-lucide="copy" style="width:14px;height:14px;"></i></button>
                <button onclick="backupFakemonToCloud('${f.id}', event)" title="Back up to cloud"><i data-lucide="cloud-upload" style="width:14px;height:14px;"></i></button>
                <div class="collection-card-export-wrap">
                    <button onclick="toggleCollectionFakemonExportMenu('${f.id}', event)" title="Export"><i data-lucide="download" style="width:14px;height:14px;"></i></button>
                    <div class="collection-card-export-menu" id="fakemon-export-menu-${f.id}" style="display:none;">
                        <button type="button" onclick="exportCollectionFakemonAsPNG('${f.id}', event)">Export as PNG</button>
                        <button type="button" onclick="exportCollectionFakemonAsPlainText('${f.id}', event)">Export as Plain Text</button>
                        <button type="button" onclick="exportCollectionFakemonAsJSON('${f.id}', event)">Export as JSON</button>
                        <button type="button" onclick="exportCollectionFakemonAsShowdown('${f.id}', event)">Export as Showdown Mod</button>
                        <button type="button" onclick="exportCollectionFakemonAsEssentials('${f.id}', event)">Export as Essentials Mod</button>
                    </div>
                </div>
                <button class="card-delete-btn" onclick="deleteFakemon('${f.id}', event)" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>`;
        }

        // full-size grid card (default layout)
        function gridCardFor(f, search) {
            const type1Class = f.type1 ? `type-${f.type1.toLowerCase()}` : '';
            const type2Class = f.type2 ? `type-${f.type2.toLowerCase()}` : '';
            const inFolder = !!f.folderId && !search;
            return `
                    <div class="collection-card${f.pinned ? ' pinned' : ''}" draggable="true" ondragstart="handleCardDragStart('${f.id}', event)" ondragend="handleCardDragEnd()" onclick="previewFakemon('${f.id}')">
                        <div class="card-actions">
                            ${collectionCardActions(f, search)}
                        </div>
                        <div class="card-art">${(state.collectionShinyPreview && f.shinyArtwork) ? `<img src="${f.shinyArtwork}" alt="${f.name} shiny" draggable="false" loading="lazy" decoding="async">` : (f.artwork ? `<img src="${f.artwork}" alt="${f.name}" draggable="false" loading="lazy" decoding="async">` : '<img class="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork" draggable="false">')}${api.cloudBadgeHtml?.(f) || ''}<span class="card-number">${escapeCollectionHtml(f.number || '#???')}</span></div>
                        <div class="card-body">
                            <div class="card-name" title="${escapeCollectionHtml(f.name)}">${escapeCollectionHtml(f.name)}</div>
                            <div class="card-meta-row">
                                <span class="card-bst"><em>BST</em>${getFakemonBST(f)}</span>
                                ${api.getShowCollectionCardDate?.() === false ? '' : `<span class="card-date">${new Date(f.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>`}
                            </div>
                            <div class="card-types">
                                ${f.type1 ? `<span class="type-badge ${type1Class}">${escapeCollectionHtml(f.type1)}</span>` : ''}
                                ${f.type2 ? `<span class="type-badge ${type2Class}">${escapeCollectionHtml(f.type2)}</span>` : ''}
                            </div>
                        </div>
                    </div>
                `;
        }

        // compact single-row card for the list layout; carries the same actions as the grid card (previously dropped some, forcing a switch back to grid to export).
        function collectionListCard(f, search) {
            const type1Class = f.type1 ? `type-${f.type1.toLowerCase()}` : '';
            const type2Class = f.type2 ? `type-${f.type2.toLowerCase()}` : '';
            return `
                <div class="collection-card collection-list-card${f.pinned ? ' pinned' : ''}" draggable="true" ondragstart="handleCardDragStart('${f.id}', event)" ondragend="handleCardDragEnd()" onclick="previewFakemon('${f.id}')">
                    <div class="card-actions">
                        ${collectionCardActions(f, search)}
                    </div>
                    <div class="card-art">${(state.collectionShinyPreview && f.shinyArtwork) ? `<img src="${f.shinyArtwork}" alt="${f.name} shiny" draggable="false" loading="lazy" decoding="async">` : (f.artwork ? `<img src="${f.artwork}" alt="${f.name}" draggable="false" loading="lazy" decoding="async">` : '<img class="no-art-placeholder" src="assets/no_art_placeholder.png" alt="No artwork" draggable="false">')}${api.cloudBadgeHtml?.(f) || ''}</div>
                    <div class="card-number">${escapeCollectionHtml(f.number || '#???')}</div>
                    <div class="card-name">${f.name}</div>
                    <div class="card-types">
                        ${f.type1 ? `<span class="type-badge ${type1Class}">${f.type1}</span>` : ''}
                        ${f.type2 ? `<span class="type-badge ${type2Class}">${f.type2}</span>` : ''}
                    </div>
                    <div class="card-bst" style="font-size:11px;color:var(--text-muted);">BST ${getFakemonBST(f)}</div>
                </div>
            `;
        }

        // A render rebuilds every card's innerHTML and re-runs lucide.createIcons()
        // over the document, so it is the most visible thing the app does. Several
        // independent things ask for one in the same tick on boot and after a save
        // (the route, the auth refresh, the cloud manifest), and each one used to
        // repaint -- which is what the flickering was. They now collapse into the
        // single render before the next frame; nothing reads the grid back
        // synchronously, so the only difference is how many times it is drawn.
        let collectionRenderQueued = false;
        function renderCollection() {
            if (collectionRenderQueued) return;
            collectionRenderQueued = true;
            queueMicrotask(() => {
                collectionRenderQueued = false;
                renderCollectionNow();
            });
        }

        function renderCollectionNow() {
        log.debug('COLLECTION', 'Rendering collection', { count: state.fakemonDB.length, folders: state.folders.length });
            api.syncCustomTypes?.();
            renderBreadcrumb();
            api.renderRegionSidebar?.();
            const grid = document.getElementById('collection-grid');
            const empty = document.getElementById('empty-collection');
            const extra = document.getElementById('collection-extra');
            if (extra) extra.innerHTML = '';

            // a region's details page replaces the tabs and grid
            const details = document.getElementById('region-details');
            const detailsOpen = !!api.isRegionDetailsOpen?.();
            document.getElementById('collection-view')?.classList.toggle('showing-region-details', detailsOpen);
            if (details) details.hidden = !detailsOpen;
            if (detailsOpen) { api.renderRegionDetails?.(); return; }

            if (collectionView === 'types') {
                empty.style.display = 'none';
                grid.style.display = collectionLayout === 'list' ? 'flex' : 'grid';
                const search = (document.getElementById('search-input')?.value || '').trim();
                // the view decides which custom and main-game types show, and the chart covers them all
                const html = api.typesTabParts?.({ search, ...(api.typesTabArgs?.() || {}) }) || { cards: '', after: '' };
                grid.innerHTML = html.cards;
                if (extra) extra.innerHTML = html.after;
                if (typeof lucide !== 'undefined') lucide.createIcons();
                return;
            }
            if (collectionView !== 'fakemon') {
                renderCustomLibraryCollection(collectionView);
                if (typeof lucide !== 'undefined') lucide.createIcons();
                return;
            }
            const search = document.getElementById('search-input').value.toLowerCase();
            const sortPrefs = getCollectionSortPrefsFromUI();

            let filtered = state.fakemonDB;
            if (search) {
                filtered = state.fakemonDB.filter(f =>
                    f.name.toLowerCase().includes(search) ||
                    (f.species && f.species.toLowerCase().includes(search)) ||
                    (f.type1 && f.type1.toLowerCase().includes(search)) ||
                    (f.type2 && f.type2.toLowerCase().includes(search))
                );
            } else if (api.getActiveRegionId?.()) {
                // a region is a flat view of its Fakemon, whatever folder they're in
                filtered = state.fakemonDB;
            } else {
                filtered = state.fakemonDB.filter(f => (f.folderId || null) === state.currentFolderId);
            }
            if (api.getActiveRegionId?.()) filtered = filtered.filter(f => api.fakemonInActiveRegion(f));
            filtered = sortFakemonList(filtered, sortPrefs.by, sortPrefs.order);

            // folders only show at the root level, and only while not searching or in a region.
            let folders = (!search && !state.currentFolderId && !api.getActiveRegionId?.()) ? state.folders.filter(f => (f.type || 'fakemon') === 'fakemon') : [];
            folders.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

            if (search && filtered.length === 0 && folders.length === 0) {
                grid.style.display = 'none';
                empty.style.display = 'block';
                // reset empty-state copy to Fakemon defaults (switching views could otherwise leave stale text/button).
                empty.querySelector('h3').textContent = search ? 'No Fakemon Found' : 'No Fakemon Yet';
                empty.querySelector('p').textContent = search ? 'Try a different search.' : 'Create your first custom Pokemon to get started!';
                const emptyButton = empty.querySelector('button');
                if (emptyButton) {
                    emptyButton.textContent = 'Create Fakemon';
                    emptyButton.onclick = () => createNewFakemon();
                }
                return;
            }
            grid.style.display = collectionLayout === 'list' ? 'flex' : 'grid';
            empty.style.display = 'none';

            const folderCards = folders.map(folder => {
                const count = state.fakemonDB.filter(f => f.folderId === folder.id).length;
                const color = folder.color || null;
                const cardStyle = color ? `border-color:${color};background:color-mix(in srgb, ${color} 10%, var(--bg-panel));` : '';
                const iconStyle = color ? `color:${color};` : '';
                return `
                    <div class="collection-card folder-card${folder.pinned ? ' pinned' : ''}" style="${cardStyle}" ondragover="handleFolderDragOver(event)" ondragleave="handleFolderDragLeave(event)" ondrop="handleFolderDrop('${folder.id}', event)" onclick="openFolder('${folder.id}')">
                        <div class="card-actions">
                            <button class="${folder.pinned ? 'pinned-btn' : ''}" onclick="toggleFolderPin('${folder.id}', event)" title="${folder.pinned ? 'Unpin' : 'Pin'}"><i data-lucide="pin" style="width:14px;height:14px;"></i></button>
                            <button onclick="renameFolder('${folder.id}', event)" title="Rename / Color"><i data-lucide="pencil" style="width:14px;height:14px;"></i></button>
                            <button class="card-delete-btn" onclick="deleteFolder('${folder.id}', event)" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
                        </div>
                        <div class="card-art folder-card-art" style="${iconStyle}"><i data-lucide="folder" style="width:48px;height:48px;"></i></div>
                        <div class="card-body">
                            <div class="card-name">${escapeCollectionHtml(folder.name)}</div>
                            <div class="card-bst">${count} Fakemon</div>
                        </div>
                    </div>
                `;
            }).join('');

            const fakemonCards = filtered.map(f => collectionLayout === 'list'
                ? collectionListCard(f, search)
                : gridCardFor(f, search)
            ).join('');

            // the vanilla Pokemon a region brings over, after its own Fakemon
            const vanillaCards = collectionLayout === 'list' ? '' : (api.regionVanillaPokemonCards?.(search) || '');
            grid.innerHTML = (search ? '' : addNewCardHtml('fakemon')) + folderCards + fakemonCards + vanillaCards;
            if (typeof lucide !== 'undefined') lucide.createIcons();
            api.updateCollectionShinyPreviewUI?.();
        }

        function toggleCollectionFakemonExportMenu(id, event) {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            document.querySelectorAll('.collection-card-export-menu').forEach(menu => {
                if (menu.id !== `fakemon-export-menu-${id}`) menu.style.display = 'none';
            });
            const menu = document.getElementById(`fakemon-export-menu-${id}`);
            if (menu) menu.style.display = menu.style.display === 'none' || !menu.style.display ? 'block' : 'none';
        }

        function closeCollectionFakemonExportMenus() {
            document.querySelectorAll('.collection-card-export-menu').forEach(menu => menu.style.display = 'none');
        }

        document.addEventListener('click', event => {
            if (!event.target.closest('.collection-card-export-wrap')) closeCollectionFakemonExportMenus();
        });

        function renderCustomLibraries() {
            const moveGrid=document.getElementById('custom-move-library-grid'), moveEmpty=document.getElementById('custom-move-library-empty');
            const abilityGrid=document.getElementById('custom-ability-library-grid'), abilityEmpty=document.getElementById('custom-ability-library-empty');
            const moves=state.customMoves||[], abilities=state.customAbilities||[];
            if(moveGrid){moveGrid.innerHTML=moves.map(m=>`<div class="library-card"><div class="library-card-actions"><button onclick="editCustomMoveLibrary('${String(m.id).replace(/'/g,"\\'")}');event.stopPropagation();" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px"></i></button></div><div class="library-card-title">${escapeLibraryHtml(m.name)}</div><div class="library-card-meta">${escapeLibraryHtml(m.type||'Normal')} · ${escapeLibraryHtml(m.category||'Status')} · ${m.basePower||'-'} BP · ${m.pp||'-'} PP</div><div class="library-card-desc">${escapeLibraryHtml(m.desc||'No description')}</div></div>`).join(''); moveEmpty.style.display=moves.length?'none':'block';}
            if(abilityGrid){abilityGrid.innerHTML=abilities.map(a=>`<div class="library-card"><div class="library-card-actions"><button onclick="editCustomAbilityLibrary('${String(a.id).replace(/'/g,"\\'")}');event.stopPropagation();" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px"></i></button></div><div class="library-card-title">${escapeLibraryHtml(a.name)}</div><div class="library-card-desc">${escapeLibraryHtml(a.desc||'No description')}</div></div>`).join(''); abilityEmpty.style.display=abilities.length?'none':'block';}
            if(typeof lucide!=='undefined')lucide.createIcons();
        }

        function filterCollection() { renderCollection(); }

        window.changeCollectionSort = changeCollectionSort;

        

export { toggleCollectionFakemonExportMenu, closeCollectionFakemonExportMenus, showCollection, createNewFakemon, editFakemon, previewFakemon, switchTab, setCollectionView, renderCollection, renderCustomLibraries, filterCollection, toggleCreateMenu, closeCreateMenu, createFolder, confirmFolderName, selectFolderColor, openFolder, renameFolder, deleteFolder, toggleFolderPin, toggleFakemonPin, moveFakemonToFolder, moveFakemonOutOfFolder, moveLibraryItemToFolder, moveLibraryItemOutOfFolder, deleteCustomLibraryItem, toggleCustomLibraryPin, duplicateCustomLibraryItem, handleCardDragStart, handleCardDragEnd, handleLibraryCardDragStart, handleFolderDragOver, handleFolderDragLeave, handleFolderDrop, sortFakemonList, getFakemonBST, changeCollectionSort , createBlankFakemonFromModal, openPokemonTemplateChooser, renderPokemonTemplateChooser, usePokemonTemplate, renderCollectionSkeleton, getPokemonTemplateSprite, applyCollectionLayoutUI, toggleCollectionLayout, openLibraryEditorSheet, getDraggedFakemonId, getDraggedLibraryItem, renderBreadcrumb};