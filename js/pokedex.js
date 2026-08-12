import { state, api } from './app.js';
import { POKEMON_COLORS } from './data.js';

// ==================== NAVIGATION ====================
        function showCollection() {
            api.autoSave(true); // Force immediate save before leaving
            document.getElementById('editor-view').style.display = 'none';
            document.getElementById('collection-view').style.display = 'block';
            document.getElementById('save-status').style.display = 'none';
            setCollectionView(collectionView || 'fakemon');
        }
        // ==================== NEW FAKEMON FLOW ====================
        function createNewFakemon() {
            api.autoSave(true);
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
            document.getElementById('collection-view').style.display = 'none';
            document.getElementById('editor-view').style.display = 'block';
            document.getElementById('save-status').style.display = '';
            switchTab(document.querySelector('.tab'), 'basic');
            document.getElementById('new-fakemon-modal')?.classList.remove('active');
            document.getElementById('pokemon-template-modal')?.classList.remove('active');

            // Apply the vanilla data before the first editor render. The template
            // learnset is hydrated immediately from the already-loaded Showdown
            // move dex, so the Moves tab is fully populated without needing to
            // leave and reopen the editor. PokeAPI species/lore can finish loading
            // afterward without delaying the editor itself.
            if (template) await applyPokemonTemplate(template, name);
            api.updatePreview();
        }

        function createBlankFakemonFromModal() {
            const name = getNewFakemonName();
            if (name) startNewFakemonEditor(name, null);
        }

        function openPokemonTemplateChooser() {
            // A name is optional when starting from a vanilla template. The
            // selected Pokemon's name is used as the initial editor name when
            // the user leaves this field blank.
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

        function slugPokemonPart(value) {
            return String(value || '')
                .toLowerCase()
                .replace(/[’']/g, '')
                .replace(/\./g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
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
                // Showdown's sprite directory uses a few compact form tokens:
                // Mega-X/Y => megax/megay, Alola-Totem => alolatotem, etc.
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
            // The animated Showdown directory has the canonical form filenames,
            // including charizard-megax and raticate-alolatotem.
            return `https://play.pokemonshowdown.com/sprites/ani/${spriteId || 'missingno'}.gif`;
        }

        function escapeTemplateHtml(value) {
            return String(value == null ? '' : value)
                .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
        }

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
                // PokeAPI's Pokemon endpoint is useful for regional/form IDs because
                // it points back to the canonical Pokemon Species resource.
                try {
                    const pokemonResponse = await fetch(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(rawId)}`);
                    if (pokemonResponse.ok) {
                        const pokemon = await pokemonResponse.json();
                        const speciesUrl = pokemon?.species?.url;
                        if (speciesUrl) {
                            const speciesResponse = await fetch(speciesUrl);
                            if (speciesResponse.ok) species = await speciesResponse.json();
                        }
                    }
                } catch (formErr) {
                    console.warn('[PokeAPI] Pokemon lookup fallback:', formErr);
                }

                if (!species) {
                    for (const candidate of [...new Set(speciesCandidates)]) {
                        const response = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${encodeURIComponent(candidate)}`);
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
                console.warn('[PokeAPI] Could not load species data for template:', template?.name, err);
                return null;
            }
        }

        async function applyPokemonTemplate(template,newName) {
            const stats=template.stats||{};
            document.getElementById('fakemon-name').value=newName;
            // Species/genus and Pokédex lore are supplied asynchronously by PokeAPI.
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
            // getPokemonTemplateLearnset intentionally stores minimal move entries.
            // Rehydrate them immediately so type/category/power/accuracy/PP/flags/
            // descriptions are available on the first render of the editor.
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

            // PokeAPI's Pokemon Species resource supplies the official genus (the
            // editor's Species / Category field) and English flavor-text entries.
            const speciesData = await fetchPokemonSpeciesTemplateData(template);
            if (speciesData) {
                if (speciesData.genus) document.getElementById('fakemon-species').value = speciesData.genus;
                if (speciesData.dexEntries[0]) document.getElementById('dex-entry1').value = speciesData.dexEntries[0];
                if (speciesData.dexEntries[1]) document.getElementById('dex-entry2').value = speciesData.dexEntries[1];
                api.updatePreview();
            }
        }

        async function usePokemonTemplate(id) {
            const template=state.sdPokedex?.[id];
            if(!template) { api.showToast('That Pokemon could not be loaded. Please try another.', 'error'); return; }
            const enteredName=(document.getElementById('new-fakemon-name')?.value || '').trim();
            const name=enteredName || template.name || 'Fakemon';
            startNewFakemonEditor(name,template);
            api.showToast(`Loading ${template.name} species data...`, 'info');
        }

        function editFakemon(id) {
            api.autoSave(true); // Save current before switching
            const fakemon = state.fakemonDB.find(f => f.id === id);
            if (!fakemon) return;
            state.editingId = id;
            api.loadFakemonIntoEditor(fakemon);
            document.getElementById('collection-view').style.display = 'none';
            document.getElementById('editor-view').style.display = 'block';
            document.getElementById('save-status').style.display = '';
            switchTab(document.querySelector('.tab'), 'basic');
            api.updatePreview();
        }
        function switchTab(tabEl, tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.style.display = 'none');
            if (tabEl) tabEl.classList.add('active');
            else document.querySelector(`.tab[onclick*="'${tabName}'"]`).classList.add('active');
            document.getElementById(`tab-${tabName}`).style.display = 'block';
            if (tabName === 'moves') {
                setTimeout(() => api.toggleLevelInput(), 10);
            }
        }

// ==================== QUICK PREVIEW POPUP ====================
        function previewFakemon(id) {
            const fakemon = state.fakemonDB.find(f => f.id === id);
            if (!fakemon) return;
            // Reuse the existing editor rendering pipeline: load the record into the
            // (hidden) editor form, let updatePreview() render the board, then clone
            // the result into the popup instead of switching to the full editor.
            state.editingId = id;
            api.loadFakemonIntoEditor(fakemon);
            api.updatePreview();
            const source = document.getElementById('pokedex-board-container');
            const wrap = document.getElementById('preview-modal-board-wrap');
            wrap.innerHTML = source.innerHTML.replace(/id="pokedex-board-export"/, 'id="pokedex-board-preview-modal"');
            const editBtn = document.getElementById('preview-modal-edit-btn');
            editBtn.onclick = () => { api.closeModal('fakemon-preview-modal'); editFakemon(id); };
            document.getElementById('fakemon-preview-modal').classList.add('active');
        }

// ==================== CREATE MENU ====================
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

// ==================== FOLDERS ====================
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
            else state.fakemonDB.forEach(f => { if (f.folderId === id) f.folderId = null; });
            state.folders = state.folders.filter(f => f.id !== id);
            if (state.currentFolderId === id) state.currentFolderId = null;
            api.saveToStorage();
            renderCollection();
            api.showToast('Folder deleted!', 'info');
        }
        function moveLibraryItemToFolder(kind, itemId, folderId) {
            const arr = kind === 'moves' ? state.customMoves : state.customAbilities;
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
        function deleteCustomLibraryItem(kind, id, event) {
            if (event) event.stopPropagation();
            const arr = kind === 'moves' ? state.customMoves : state.customAbilities;
            const item = (arr || []).find(x => x.id === id);
            if (!item) return;
            if (!confirm(`Delete "${item.name}" from your ${kind === 'moves' ? 'move' : 'ability'} library?`)) return;
            if (kind === 'moves') state.customMoves = state.customMoves.filter(x => x.id !== id);
            else state.customAbilities = state.customAbilities.filter(x => x.id !== id);
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

        // ---- Drag & drop wiring ----
        let draggedFakemonId = null;
        let draggedLibraryItem = null; // { kind, id }
        function handleCardDragStart(id, event) {
            draggedFakemonId = id;
            draggedLibraryItem = null;
            event.dataTransfer.effectAllowed = 'move';
            try { event.dataTransfer.setData('text/plain', id); } catch (e) {}
        }
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

// ==================== COLLECTION ====================
        let collectionView = 'fakemon';

        function sortFakemonList(list, sortMode) {
            const sorted = [...list];
            switch (sortMode) {
                case 'oldest':
                    sorted.sort((a, b) => a.createdAt - b.createdAt); break;
                case 'name-asc':
                    sorted.sort((a, b) => a.name.localeCompare(b.name)); break;
                case 'name-desc':
                    sorted.sort((a, b) => b.name.localeCompare(a.name)); break;
                case 'bst-desc':
                    sorted.sort((a, b) => getFakemonBST(b) - getFakemonBST(a)); break;
                case 'bst-asc':
                    sorted.sort((a, b) => getFakemonBST(a) - getFakemonBST(b)); break;
                case 'updated':
                    sorted.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)); break;
                case 'newest':
                default:
                    sorted.sort((a, b) => b.createdAt - a.createdAt); break;
            }
            // Pinned items always float to the top, preserving the chosen sort within each group.
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
            const newView = ['fakemon', 'moves', 'abilities'].includes(view) ? view : 'fakemon';
            if (newView !== collectionView) state.currentFolderId = null;
            collectionView = newView;
            const select = document.getElementById('collection-view-select');
            if (select) select.value = collectionView;

            const searchInput = document.getElementById('search-input');
            const sort = document.getElementById('collection-sort');
            const importBtn = document.getElementById('collection-import-btn');
            const exportBtn = document.getElementById('collection-export-btn');
            const fakemonCreate = document.getElementById('create-fakemon-menu-item');
            const folderCreate = document.getElementById('create-folder-menu-item');
            const moveCreate = document.getElementById('create-move-menu-item');
            const abilityCreate = document.getElementById('create-ability-menu-item');

            if (collectionView === 'fakemon') {
                if (searchInput) searchInput.placeholder = 'Search your Fakemon...';
                if (sort) {
                    sort.innerHTML = `
                        <option value="newest">Newest First</option>
                        <option value="oldest">Oldest First</option>
                        <option value="name-asc">Name (A-Z)</option>
                        <option value="name-desc">Name (Z-A)</option>
                        <option value="bst-desc">BST (High-Low)</option>
                        <option value="bst-asc">BST (Low-High)</option>
                        <option value="updated">Recently Updated</option>`;
                }
                if (importBtn) importBtn.style.display = '';
                if (exportBtn) exportBtn.style.display = '';
                if (fakemonCreate) fakemonCreate.style.display = '';
                if (folderCreate) folderCreate.style.display = '';
                if (moveCreate) moveCreate.style.display = '';
                if (abilityCreate) abilityCreate.style.display = '';
            } else {
                if (searchInput) searchInput.placeholder = collectionView === 'moves' ? 'Search your custom moves...' : 'Search your custom abilities...';
                if (sort) {
                    sort.innerHTML = `
                        <option value="name-asc">Name (A-Z)</option>
                        <option value="name-desc">Name (Z-A)</option>
                        <option value="newest">Newest First</option>
                        <option value="oldest">Oldest First</option>`;
                    sort.value = 'name-asc';
                }
                if (importBtn) importBtn.style.display = '';
                if (exportBtn) exportBtn.style.display = '';
                if (fakemonCreate) fakemonCreate.style.display = '';
                if (folderCreate) folderCreate.style.display = '';
                if (moveCreate) moveCreate.style.display = '';
                if (abilityCreate) abilityCreate.style.display = '';
            }
            renderCollection();
        }

        function sortLibraryList(list, sortMode) {
            const sorted = [...list];
            if (sortMode === 'name-desc') sorted.sort((a, b) => String(b.name || '').localeCompare(String(a.name || '')));
            else if (sortMode === 'newest') sorted.sort((a, b) => String(b.id || '').localeCompare(String(a.id || '')));
            else if (sortMode === 'oldest') sorted.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
            else sorted.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            return sorted;
        }

        function escapeCollectionHtml(value) {
            return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
        }

        function renderCustomLibraryCollection(kind) {
            const grid = document.getElementById('collection-grid');
            const empty = document.getElementById('empty-collection');
            const search = (document.getElementById('search-input')?.value || '').trim().toLowerCase();
            const sortMode = document.getElementById('collection-sort')?.value || 'name-asc';
            const isMove = kind === 'moves';
            const source = isMove ? (state.customMoves || []) : (state.customAbilities || []);
            let items = source.filter(item => {
                if (!search) return true;
                const text = isMove
                    ? `${item.name || ''} ${item.type || ''} ${item.category || ''} ${item.desc || ''}`
                    : `${item.name || ''} ${item.desc || ''}`;
                return text.toLowerCase().includes(search);
            });
            if (!search) items = items.filter(item => (item.folderId || null) === state.currentFolderId);
            items = sortLibraryList(items, sortMode);

            // Folders only show at the root level, and only while not searching.
            let folders = (!search && !state.currentFolderId) ? state.folders.filter(f => f.type === kind) : [];
            folders.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

            if (!items.length && !folders.length) {
                grid.style.display = 'grid';
                grid.innerHTML = '';
                empty.style.display = 'block';
                empty.querySelector('h3').textContent = search ? `No ${isMove ? 'custom moves' : 'custom abilities'} found` : `No ${isMove ? 'Custom Moves' : 'Custom Abilities'} Yet`;
                empty.querySelector('p').textContent = search ? 'Try a different search.' : `Create your first custom ${isMove ? 'move' : 'ability'} to get started!`;
                const emptyButton = empty.querySelector('button');
                if (emptyButton) {
                    emptyButton.textContent = isMove ? 'Create Custom Move' : 'Create Custom Ability';
                    emptyButton.onclick = () => isMove ? api.openCustomMoveChooser() : api.openCustomAbilityChooser();
                }
                return;
            }

            empty.style.display = 'none';
            grid.style.display = 'grid';

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
                        <div class="card-name">${escapeCollectionHtml(folder.name)}</div>
                        <div class="card-bst" style="font-size:11px;color:var(--text-muted);">${count} ${isMove ? 'Move' : 'Ability'}${count === 1 ? '' : 's'}</div>
                    </div>
                `;
            }).join('');

            const itemCards = items.map(item => {
                const id = escapeCollectionHtml(item.id);
                const inFolder = !!item.folderId && !search;
                const moveOutBtn = inFolder ? `<button onclick="moveLibraryItemOutOfFolder('${kind}','${id}', event)" title="Remove from folder"><i data-lucide="folder-output" style="width:14px;height:14px;"></i></button>` : '';
                if (isMove) {
                    const typeClass = `type-${String(item.type || 'Normal').toLowerCase()}`;
                    const acc = item.accuracy === true || item.accuracy === undefined || item.accuracy === false ? '—' : `${item.accuracy}%`;
                    return `<div class="collection-library-card" draggable="true" ondragstart="handleLibraryCardDragStart('moves','${id}', event)" ondragend="handleCardDragEnd()">
                        <div class="card-actions">
                            <button onclick="editCustomMoveLibrary('${id}');event.stopPropagation();" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px"></i></button>
                            <button onclick="exportCustomLibraryItem('move','${id}');event.stopPropagation();" title="Export Move"><i data-lucide="download" style="width:14px;height:14px"></i></button>
                            ${moveOutBtn}
                            <button class="card-delete-btn" onclick="deleteCustomLibraryItem('moves','${id}', event)" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px"></i></button>
                        </div>
                        <div class="collection-library-card-title">${escapeCollectionHtml(item.name)}</div>
                        <div class="collection-library-card-meta"><span class="type-pill ${typeClass}">${escapeCollectionHtml(item.type || 'Normal')}</span> · ${escapeCollectionHtml(item.category || 'Status')} · ${item.basePower || '—'} BP · ${acc} · ${item.pp || '—'} PP</div>
                        <div class="collection-library-card-desc">${escapeCollectionHtml(item.desc || 'No description')}</div>
                    </div>`;
                }
                return `<div class="collection-library-card" draggable="true" ondragstart="handleLibraryCardDragStart('abilities','${id}', event)" ondragend="handleCardDragEnd()">
                    <div class="card-actions">
                        <button onclick="editCustomAbilityLibrary('${id}');event.stopPropagation();" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px"></i></button>
                        <button onclick="exportCustomLibraryItem('ability','${id}');event.stopPropagation();" title="Export Ability"><i data-lucide="download" style="width:14px;height:14px"></i></button>
                        ${moveOutBtn}
                        <button class="card-delete-btn" onclick="deleteCustomLibraryItem('abilities','${id}', event)" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px"></i></button>
                    </div>
                    <div class="collection-library-card-title">${escapeCollectionHtml(item.name)}</div>
                    <div class="collection-library-card-desc">${escapeCollectionHtml(item.desc || 'No description')}</div>
                </div>`;
            }).join('');

            grid.innerHTML = folderCards + itemCards;
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function renderCollection() {
            renderBreadcrumb();
            const grid = document.getElementById('collection-grid');
            const empty = document.getElementById('empty-collection');
            if (collectionView !== 'fakemon') {
                renderCustomLibraryCollection(collectionView);
                return;
            }
            const search = document.getElementById('search-input').value.toLowerCase();
            const sortMode = document.getElementById('collection-sort') ? document.getElementById('collection-sort').value : 'newest';

            let filtered = state.fakemonDB;
            if (search) {
                filtered = state.fakemonDB.filter(f =>
                    f.name.toLowerCase().includes(search) ||
                    (f.species && f.species.toLowerCase().includes(search)) ||
                    (f.type1 && f.type1.toLowerCase().includes(search)) ||
                    (f.type2 && f.type2.toLowerCase().includes(search))
                );
            } else {
                filtered = state.fakemonDB.filter(f => (f.folderId || null) === state.currentFolderId);
            }
            filtered = sortFakemonList(filtered, sortMode);

            // Folders only show at the root level, and only while not searching.
            let folders = (!search && !state.currentFolderId) ? state.folders.filter(f => (f.type || 'fakemon') === 'fakemon') : [];
            folders.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

            if (filtered.length === 0 && folders.length === 0) {
                grid.style.display = 'none';
                empty.style.display = 'block';
                // Reset the empty-state copy back to the Fakemon defaults: switching
                // here from the Moves/Abilities view previously left their custom
                // text (and "Create Move/Ability" button) in place.
                empty.querySelector('h3').textContent = search ? 'No Fakemon Found' : 'No Fakemon Yet';
                empty.querySelector('p').textContent = search ? 'Try a different search.' : 'Create your first custom Pokemon to get started!';
                const emptyButton = empty.querySelector('button');
                if (emptyButton) {
                    emptyButton.textContent = 'Create Fakemon';
                    emptyButton.onclick = () => createNewFakemon();
                }
                return;
            }
            grid.style.display = 'grid';
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
                        <div class="card-name">${folder.name}</div>
                        <div class="card-bst" style="font-size:11px;color:var(--text-muted);">${count} Fakemon</div>
                    </div>
                `;
            }).join('');

            const fakemonCards = filtered.map(f => {
                const type1Class = f.type1 ? `type-${f.type1.toLowerCase()}` : '';
                const type2Class = f.type2 ? `type-${f.type2.toLowerCase()}` : '';
                const inFolder = !!f.folderId && !search;
                return `
                    <div class="collection-card${f.pinned ? ' pinned' : ''}" draggable="true" ondragstart="handleCardDragStart('${f.id}', event)" ondragend="handleCardDragEnd()" onclick="previewFakemon('${f.id}')">
                        <div class="card-actions">
                            <button class="${f.pinned ? 'pinned-btn' : ''}" onclick="toggleFakemonPin('${f.id}', event)" title="${f.pinned ? 'Unpin' : 'Pin'}"><i data-lucide="pin" style="width:14px;height:14px;"></i></button>
                            <button onclick="editFakemon('${f.id}'); event.stopPropagation();" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px;"></i></button>
                            ${inFolder ? `<button onclick="moveFakemonOutOfFolder('${f.id}', event)" title="Remove from folder"><i data-lucide="folder-output" style="width:14px;height:14px;"></i></button>` : ''}
                            <button onclick="duplicateFakemon('${f.id}', event)" title="Duplicate"><i data-lucide="copy" style="width:14px;height:14px;"></i></button>
                            <button class="card-delete-btn" onclick="deleteFakemon('${f.id}', event)" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
                        </div>
                        <div class="card-art">${f.artwork ? `<img src="${f.artwork}" alt="${f.name}" draggable="false">` : '<span class="placeholder">ART</span>'}</div>
                        <div class="card-name">${f.name}</div>
                        <div class="card-types">
                            ${f.type1 ? `<span class="type-badge ${type1Class}">${f.type1}</span>` : ''}
                            ${f.type2 ? `<span class="type-badge ${type2Class}">${f.type2}</span>` : ''}
                        </div>
                        <div class="card-bst" style="font-size:11px;color:var(--text-muted);">Created: ${new Date(f.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} ${new Date(f.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                `;
            }).join('');

            grid.innerHTML = folderCards + fakemonCards;
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function renderCustomLibraries() {
            const escapeLibraryHtml = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
            const moveGrid=document.getElementById('custom-move-library-grid'), moveEmpty=document.getElementById('custom-move-library-empty');
            const abilityGrid=document.getElementById('custom-ability-library-grid'), abilityEmpty=document.getElementById('custom-ability-library-empty');
            const moves=state.customMoves||[], abilities=state.customAbilities||[];
            if(moveGrid){moveGrid.innerHTML=moves.map(m=>`<div class="library-card"><div class="library-card-actions"><button onclick="editCustomMoveLibrary('${String(m.id).replace(/'/g,"\\'")}');event.stopPropagation();" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px"></i></button></div><div class="library-card-title">${escapeLibraryHtml(m.name)}</div><div class="library-card-meta">${escapeLibraryHtml(m.type||'Normal')} · ${escapeLibraryHtml(m.category||'Status')} · ${m.basePower||'—'} BP · ${m.pp||'—'} PP</div><div class="library-card-desc">${escapeLibraryHtml(m.desc||'No description')}</div></div>`).join(''); moveEmpty.style.display=moves.length?'none':'block';}
            if(abilityGrid){abilityGrid.innerHTML=abilities.map(a=>`<div class="library-card"><div class="library-card-actions"><button onclick="editCustomAbilityLibrary('${String(a.id).replace(/'/g,"\\'")}');event.stopPropagation();" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px"></i></button></div><div class="library-card-title">${escapeLibraryHtml(a.name)}</div><div class="library-card-desc">${escapeLibraryHtml(a.desc||'No description')}</div></div>`).join(''); abilityEmpty.style.display=abilities.length?'none':'block';}
            if(typeof lucide!=='undefined')lucide.createIcons();
        }

        function filterCollection() { renderCollection(); }

        

export { showCollection, createNewFakemon, editFakemon, previewFakemon, switchTab, setCollectionView, renderCollection, renderCustomLibraries, filterCollection, toggleCreateMenu, closeCreateMenu, createFolder, confirmFolderName, selectFolderColor, openFolder, renameFolder, deleteFolder, toggleFolderPin, toggleFakemonPin, moveFakemonToFolder, moveFakemonOutOfFolder, moveLibraryItemToFolder, moveLibraryItemOutOfFolder, deleteCustomLibraryItem, handleCardDragStart, handleCardDragEnd, handleLibraryCardDragStart, handleFolderDragOver, handleFolderDragLeave, handleFolderDrop, sortFakemonList, getFakemonBST , createBlankFakemonFromModal, openPokemonTemplateChooser, renderPokemonTemplateChooser, usePokemonTemplate};