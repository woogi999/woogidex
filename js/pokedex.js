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
        function createNewFakemon() {
            api.autoSave(true); // Save current before starting new
            state.editingId = null;
            api.resetEditor();
            document.getElementById('collection-view').style.display = 'none';
            document.getElementById('editor-view').style.display = 'block';
            document.getElementById('save-status').style.display = '';
            switchTab(document.querySelector('.tab'), 'basic');
            api.updatePreview();
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
            if (!confirm(`Delete "${folder.name}"? Fakemon inside will be moved back to My Collection.`)) return;
            state.fakemonDB.forEach(f => { if (f.folderId === id) f.folderId = null; });
            state.folders = state.folders.filter(f => f.id !== id);
            if (state.currentFolderId === id) state.currentFolderId = null;
            api.saveToStorage();
            renderCollection();
            api.showToast('Folder deleted!', 'info');
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
        function handleCardDragStart(id, event) {
            draggedFakemonId = id;
            event.dataTransfer.effectAllowed = 'move';
            try { event.dataTransfer.setData('text/plain', id); } catch (e) {}
        }
        function handleCardDragEnd() {
            draggedFakemonId = null;
            document.querySelectorAll('.folder-card.drag-over').forEach(el => el.classList.remove('drag-over'));
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
            const id = draggedFakemonId || (event.dataTransfer && event.dataTransfer.getData('text/plain'));
            if (id) moveFakemonToFolder(id, folderId);
            draggedFakemonId = null;
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
            const el = document.getElementById('collection-breadcrumb');
            if (!el) return;
            if (!state.currentFolderId) {
                el.innerHTML = `<span class="breadcrumb-root" onclick="openFolder(null)" style="cursor:pointer;">My Collection</span>`;
                return;
            }
            const folder = state.folders.find(f => f.id === state.currentFolderId);
            const folderName = folder ? folder.name : 'Folder';
            el.innerHTML = `
                <span class="breadcrumb-root" onclick="openFolder(null)" style="cursor:pointer;color:var(--text-secondary);">My Collection</span>
                <span style="color:var(--text-muted);">/</span>
                <span>${folderName}</span>
            `;
        }

        function setCollectionView(view) {
            collectionView = ['fakemon', 'moves', 'abilities'].includes(view) ? view : 'fakemon';
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
            items = sortLibraryList(items, sortMode);

            if (!items.length) {
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
            grid.innerHTML = items.map(item => {
                const id = escapeCollectionHtml(item.id);
                if (isMove) {
                    const typeClass = `type-${String(item.type || 'Normal').toLowerCase()}`;
                    const acc = item.accuracy === true || item.accuracy === undefined || item.accuracy === false ? '—' : `${item.accuracy}%`;
                    return `<div class="collection-library-card">
                        <div class="library-card-actions">
                            <button onclick="editCustomMoveLibrary('${id}');event.stopPropagation();" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px"></i></button>
                            <button onclick="exportCustomLibraryItem('move','${id}');event.stopPropagation();" title="Export Move"><i data-lucide="download" style="width:14px;height:14px"></i></button>
                        </div>
                        <div class="collection-library-card-title">${escapeCollectionHtml(item.name)}</div>
                        <div class="collection-library-card-meta"><span class="type-pill ${typeClass}">${escapeCollectionHtml(item.type || 'Normal')}</span> · ${escapeCollectionHtml(item.category || 'Status')} · ${item.basePower || '—'} BP · ${acc} · ${item.pp || '—'} PP</div>
                        <div class="collection-library-card-desc">${escapeCollectionHtml(item.desc || 'No description')}</div>
                    </div>`;
                }
                return `<div class="collection-library-card">
                    <div class="library-card-actions">
                        <button onclick="editCustomAbilityLibrary('${id}');event.stopPropagation();" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px"></i></button>
                        <button onclick="exportCustomLibraryItem('ability','${id}');event.stopPropagation();" title="Export Ability"><i data-lucide="download" style="width:14px;height:14px"></i></button>
                    </div>
                    <div class="collection-library-card-title">${escapeCollectionHtml(item.name)}</div>
                    <div class="collection-library-card-desc">${escapeCollectionHtml(item.desc || 'No description')}</div>
                </div>`;
            }).join('');
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
            let folders = (!search && !state.currentFolderId) ? [...state.folders] : [];
            folders.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

            if (filtered.length === 0 && folders.length === 0) {
                grid.style.display = 'none';
                empty.style.display = 'block';
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

        

export { showCollection, createNewFakemon, editFakemon, previewFakemon, switchTab, setCollectionView, renderCollection, renderCustomLibraries, filterCollection, toggleCreateMenu, closeCreateMenu, createFolder, confirmFolderName, selectFolderColor, openFolder, renameFolder, deleteFolder, toggleFolderPin, toggleFakemonPin, moveFakemonToFolder, moveFakemonOutOfFolder, handleCardDragStart, handleCardDragEnd, handleFolderDragOver, handleFolderDragLeave, handleFolderDrop, sortFakemonList, getFakemonBST };