import { state, api } from './app.js';

// ==================== POKEMON ESSENTIALS EXPORT ====================
// Generates PBS (Pokemon Base Statistics) text files for Pokemon Essentials
// (the RPG Maker fangame engine), the same way showdown-export.js does for
// Showdown. Targets the modern v19+ split-file PBS format: pokemon.txt
// (species/stats/moves), pokemon_metrics.txt (height/weight/kind/shape/
// color), and pokemon_dexentries.txt (dex description). Custom moves and
// abilities are skipped from the mechanical data for the same reason as
// the Showdown export; Essentials needs actual script-level effect code
// for those to do anything, not just a name in a text file.

        function toEssentialsId(value) {
            return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
        }

        function toEssentialsEggGroupId(value) {
            return String(value || '').replace(/[^A-Za-z0-9]+/g, '');
        }

        function parseHeightMeters(heightDisplay) {
            const match = String(heightDisplay || '').trim().match(/^([\d.]+)\s*(m|ft)?$/i);
            if (!match) return 0;
            const val = parseFloat(match[1]) || 0;
            const unit = (match[2] || 'm').toLowerCase();
            return Math.round((unit === 'ft' ? val / 3.28084 : val) * 100) / 100;
        }

        function parseWeightKg(weightDisplay) {
            const match = String(weightDisplay || '').trim().match(/^([\d.]+)\s*(kg|lb)?$/i);
            if (!match) return 0;
            const val = parseFloat(match[1]) || 0;
            const unit = (match[2] || 'kg').toLowerCase();
            return Math.round((unit === 'lb' ? val / 2.20462 : val) * 10) / 10;
        }

        function getEggGroupsList(eggGroups) {
            const arr = Array.isArray(eggGroups) ? eggGroups.filter(Boolean)
                : String(eggGroups || '').split(/\s*,\s*/).filter(g => g && !/^none$/i.test(g));
            const ids = arr.map(toEssentialsEggGroupId).filter(Boolean);
            return ids.length ? ids : ['Undiscovered'];
        }

        function buildEssentialsGenderRatio(genderRatio) {
            const ratio = String(genderRatio || '50-50').trim();
            if (ratio === 'genderless') return 'Genderless';
            const parts = ratio.split('-').map(Number);
            const male = isNaN(parts[0]) ? 50 : parts[0];
            const female = isNaN(parts[1]) ? (100 - male) : parts[1];
            // Snap to the nearest of Essentials' standard gender-ratio buckets.
            const buckets = [
                { female: 0, id: 'AlwaysMale' },
                { female: 12.5, id: 'Female12.5Percent' },
                { female: 25, id: 'Female25Percent' },
                { female: 50, id: 'Female50Percent' },
                { female: 75, id: 'Female75Percent' },
                { female: 100, id: 'AlwaysFemale' }
            ];
            let closest = buckets[0];
            let bestDiff = Infinity;
            buckets.forEach(b => {
                const diff = Math.abs(b.female - female);
                if (diff < bestDiff) { bestDiff = diff; closest = b; }
            });
            return closest.id;
        }

        function essentialsMoveToken(entry) {
            // No explicit method ('none') gets treated as a tutor move so it's
            // still teachable in-game instead of just disappearing.
            if (entry.learnMethod === 'level') return { bucket: 'level', level: entry.level || 1 };
            if (entry.learnMethod === 'egg') return { bucket: 'egg' };
            return { bucket: 'tutor' };
        }

        function getEssentialsEvolutionGraphForFakemon(fakemon) {
            return fakemon?.evolutionGraph || state.evolutionGraph || null;
        }

        function collectEssentialsEvolutionRelations(graph) {
            if (!graph?.nodes || !graph?.edges) return [];
            const outgoing = new Map();
            graph.edges.forEach(e => { if (!outgoing.has(e.from)) outgoing.set(e.from, []); outgoing.get(e.from).push(e.to); });
            const methodIds = new Set(graph.nodes.filter(n => n?.kind === 'method').map(n => n.id));
            const relations = [];
            const walk = (parent, nodeId, methods, seen) => {
                if (seen.has(nodeId)) return;
                const node = graph.nodes.find(n => n.id === nodeId); if (!node) return;
                const nextSeen = new Set(seen); nextSeen.add(nodeId);
                if (!methodIds.has(nodeId)) { relations.push({parent, child:node, methods:[...methods]}); return; }
                const nextMethods = [...methods, node];
                (outgoing.get(nodeId) || []).forEach(next => walk(parent, next, nextMethods, nextSeen));
            };
            graph.nodes.filter(n => n && !methodIds.has(n.id)).forEach(parent => (outgoing.get(parent.id) || []).forEach(next => walk(parent, next, [], new Set([parent.id]))));
            return relations;
        }

        function getEssentialsEvolutionNodeId(node, fakemonList, internalNames) {
            if (!node) return '';
            if (node.kind === 'fakemon' && node.refId) {
                const i = (fakemonList || []).findIndex(f => String(f.id) === String(node.refId));
                return i >= 0 ? (internalNames?.[i] || toEssentialsId(fakemonList[i].name)) : toEssentialsId(node.name || node.refId);
            }
            return toEssentialsId(node.refId || node.name);
        }

        function getEvolutionPathsForNode(graph, node, fakemonList, internalNames) {
            const paths = [], notes = [];
            if (!graph || !node) return {paths, notes};
            collectEssentialsEvolutionRelations(graph).filter(r => r.parent.id === node.id).forEach(r => {
                const targetId = getEssentialsEvolutionNodeId(r.child, fakemonList, internalNames);
                if (!targetId) return;
                (r.methods || []).forEach(m => {
                    if (m.methodType === 'level') paths.push(`${targetId},Level,${Math.max(1, Number(m.value) || 1)}`);
                    else if (m.methodType === 'item' && m.value) paths.push(`${targetId},Item,${toEssentialsId(m.value)}`);
                    else if (m.methodType === 'custom' && m.description) notes.push(`${node.name || getEssentialsEvolutionNodeId(node, fakemonList, internalNames)} -> ${r.child.name || targetId}: ${m.description}`);
                });
            });
            return {paths, notes};
        }

        function getEvolutionPathsForFakemon(fakemon, fakemonList, internalNames) {
            const graph = getEssentialsEvolutionGraphForFakemon(fakemon);
            const owner = graph?.nodes?.find(n => n?.kind === 'fakemon' && String(n.refId) === String(fakemon.id));
            return owner ? getEvolutionPathsForNode(graph, owner, fakemonList, internalNames) : {paths:[], notes:[]};
        }

        function buildVanillaEvolutionOverrides(graph, fakemonList, internalNames) {
            const lines = [];
            if (!graph?.nodes) return '';
            collectEssentialsEvolutionRelations(graph).forEach(r => {
                if (r.parent.kind !== 'vanilla') return;
                const parentId = getEssentialsEvolutionNodeId(r.parent, fakemonList, internalNames);
                const targetId = getEssentialsEvolutionNodeId(r.child, fakemonList, internalNames);
                if (!parentId || !targetId) return;
                (r.methods || []).forEach(m => {
                    if (m.methodType === 'level') lines.push(`    ${parentId}, ${targetId}, :Level, ${Math.max(1, Number(m.value) || 1)}`);
                    else if (m.methodType === 'item' && m.value) lines.push(`    ${parentId}, ${targetId}, :Item, :${toEssentialsId(m.value)}`);
                    else if (m.methodType === 'custom' && m.description) lines.push(`    ${parentId}, ${targetId}, :Custom, ${JSON.stringify(String(m.description))}`);
                });
            });
            if (!lines.length) return '';
            return `# Generated by Woogidex. These additions target vanilla species already present in Essentials.\n# Add these evolutions at runtime; do not duplicate the vanilla PBS species sections.\n${lines.join('\n')}`;
        }

        function buildSpeciesBlock(fakemon, internalName, evolutionContext = null) {
            const types = [fakemon.type1, fakemon.type2].filter(Boolean).map(toEssentialsId);
            const stats = fakemon.stats || {};
            const abilities = (fakemon.abilities || []).filter(a => a && a.name && a.name.trim());
            const slots = abilities.map((a, i) => ({ ...a, role: api.getAbilityRole ? api.getAbilityRole(i) : '' }));
            const normalAbilities = slots.filter(a => !a.role && !(a.source === 'custom' || a.custom === true)).map(a => toEssentialsId(a.name));
            const hiddenAbility = slots.find(a => a.role === 'Hidden' && !(a.source === 'custom' || a.custom === true));
            const hasCustomAbility = slots.some(a => a.source === 'custom' || a.custom === true);

            const learnset = (fakemon.learnset || []).filter(m => m && m.name && !(m.source === 'custom' || m.custom === true));
            const skippedCustom = (fakemon.learnset || []).filter(m => m && m.name && (m.source === 'custom' || m.custom === true));

            const levelMoves = [];
            const eggMoves = [];
            const tutorMoves = [];
            learnset.forEach(m => {
                const token = essentialsMoveToken(m);
                const moveId = toEssentialsId(m.name);
                if (token.bucket === 'level') levelMoves.push({ level: token.level, moveId });
                else if (token.bucket === 'egg') eggMoves.push(moveId);
                else tutorMoves.push(moveId);
            });
            levelMoves.sort((a, b) => a.level - b.level);
            const movesLine = levelMoves.map(m => `${m.level},${m.moveId}`).join(',');

            const lines = [];
            lines.push(`[${internalName}]`);
            lines.push(`Name = ${fakemon.name}`);
            lines.push(`Types = ${types.length ? types.join(',') : 'NORMAL'}`);
            lines.push(`BaseStats = ${stats.hp || 0},${stats.atk || 0},${stats.def || 0},${stats.spa || 0},${stats.spd || 0},${stats.spe || 0}`);
            lines.push(`GenderRatio = ${buildEssentialsGenderRatio(fakemon.genderRatio)}`);
            lines.push('GrowthRate = Medium');
            lines.push('BaseExp = 100');
            lines.push('Rareness = 45');
            lines.push('Happiness = 70');
            lines.push(`Abilities = ${normalAbilities.length ? normalAbilities.join(',') : ''}`);
            if (hiddenAbility) lines.push(`HiddenAbilities = ${toEssentialsId(hiddenAbility.name)}`);
            lines.push(`Moves = ${movesLine}`);
            if (tutorMoves.length) lines.push(`TutorMoves = ${tutorMoves.join(',')}`);
            if (eggMoves.length) lines.push(`EggMoves = ${eggMoves.join(',')}`);
            lines.push(`EggGroups = ${getEggGroupsList(fakemon.eggGroups).join(',')}`);
            lines.push('Generation = 9');
            const evo = evolutionContext ? getEvolutionPathsForFakemon(fakemon, evolutionContext.fakemonList, evolutionContext.internalNames) : {paths:[],notes:[]};
            if (evo.paths.length) lines.push(`Evolutions = ${evo.paths.join(',')}`);

            return { block: lines.join('\r\n'), hasCustomAbility, skippedCustom, evolutionNotes:evo.notes };
        }

        function buildMetricsBlock(fakemon, internalName) {
            const lines = [];
            lines.push(`[${internalName}]`);
            lines.push(`Height = ${parseHeightMeters(fakemon.height)}`);
            lines.push(`Weight = ${parseWeightKg(fakemon.weight)}`);
            lines.push(`Color = ${fakemon.color || 'Gray'}`);
            lines.push('Shape = Head');
            lines.push(`Kind = ${(fakemon.species || 'Fakemon').replace(/\s*Pok[eé]mon\s*$/i, '').trim() || 'Fakemon'}`);
            lines.push('Habitat = None');
            return lines.join('\r\n');
        }

        function buildDexEntryBlock(fakemon, internalName) {
            const text = (fakemon.dexEntry || fakemon.description || `A mysterious Fakemon known as ${fakemon.name}.`).replace(/\r?\n/g, ' ').trim();
            return `[${internalName}]\r\n1=${text}`;
        }

        function makeUniqueInternalNames(fakemonList) {
            const used = new Map();
            return fakemonList.map(f => {
                let id = toEssentialsId(f.name) || 'FAKEMON';
                const count = used.get(id) || 0;
                used.set(id, count + 1);
                if (count > 0) id = `${id}${count + 1}`;
                return id;
            });
        }

        function buildEvolutionNotesText(fakemonList) {
            const lines = [];
            const seen = new Set();
            (fakemonList || []).forEach(f => {
                const graph = getEssentialsEvolutionGraphForFakemon(f);
                if (!graph?.nodes || !graph?.edges) return;
                const owner = graph.nodes.find(n => n?.kind === 'fakemon' && String(n.refId) === String(f.id));
                if (!owner) return;
                (graph.edges || []).filter(e => e.from === owner.id).forEach(edge => {
                    const methods = [];
                    const visited = new Set();
                    let node = graph.nodes.find(n => n.id === edge.to);
                    while (node && node.kind === 'method' && !visited.has(node.id)) {
                        visited.add(node.id); methods.push(node);
                        const next = (graph.edges || []).find(e => e.from === node.id);
                        node = next ? graph.nodes.find(n => n.id === next.to) : null;
                    }
                    if (!node || node.kind !== 'fakemon') return;
                    const methodText = methods.map(m => m.methodType === 'level' ? `Level ${Number(m.value) || 1}` : m.methodType === 'item' ? `Use ${m.value || 'an item'}` : String(m.description || 'Custom Method')).join(' / ');
                    const line = `${f.name} -> ${node.name || node.refId}${methodText ? ` (${methodText})` : ''}`;
                    if (!seen.has(line)) { seen.add(line); lines.push(line); }
                });
            });
            return lines.join('\r\n') + (lines.length ? '\r\n' : '');
        }

        function buildReadmeTxt(fakemon) {
            return `${fakemon.name}'s Pokemon Essentials Files
===================================

Hey! This ZIP has everything you need to add ${fakemon.name} to your
Pokemon Essentials project as a proper species.

What's inside:
- pokemon.txt; the species entry (types, stats, abilities, moves, etc.)
- pokemon_metrics.txt; height, weight, color, and other dex-page info
- pokemon_dexentries.txt; a basic Pokedex description

These match the modern (v19+) split PBS text format. If you're on an
older Essentials version that uses a single combined pokemon.txt file
instead, you'll need to merge the fields in by hand.

Getting it installed:
1. Open each file in this ZIP and copy the [${toEssentialsId(fakemon.name) || 'FAKEMON'}]
   block inside it.
2. Paste that block into the matching file in your project's PBS folder
   (usually PBS/pokemon.txt, PBS/pokemon_metrics.txt, and
   PBS/pokemon_dexentries.txt), anywhere after the last entry.
3. In RPG Maker, open the game and use the debug menu's "Compile all
   data" option (or just hit F12 in-editor, depending on your version)
   so Essentials rebuilds its data from the PBS files.
4. Playtest and go find ${fakemon.name}!

A couple things worth knowing:
- Only moves ${fakemon.name} learns that already exist as vanilla moves
  got included here. Custom moves got left out, since they'd need actual
  script code written for them to do anything.
- Moves without a level attached in the editor got exported as tutor
  moves, so they're still teachable instead of just disappearing.
- Custom abilities are left out of the Abilities/HiddenAbilities lines
  for the same reason as custom moves; you'd need to script the effect
  yourself and add it to your abilities data.
- Shape and Habitat are just placeholder defaults since the editor
  doesn't track those; feel free to change them in pokemon_metrics.txt.
`;
        }

        function buildCollectionReadmeTxt(fakemonList, totalSkipped) {
            const names = fakemonList.map(f => f.name).join(', ');
            return `Your Collection's Pokemon Essentials Files
===================================

Hey! This ZIP has your whole collection (${fakemonList.length} Fakemon)
bundled into ready-to-go Pokemon Essentials PBS files: ${names}.

What's inside:
- A "PBS" folder with pokemon.txt, pokemon_metrics.txt, and
  pokemon_dexentries.txt, already containing an entry for every Fakemon
  in your collection.

These match the modern (v19+) split PBS text format. If you're on an
older Essentials version that uses a single combined pokemon.txt file
instead, you'll need to merge the fields in by hand.

Getting it installed:
1. If you're starting a brand new project, you can drag the "PBS" folder
   straight in and use it as-is.
2. If you already have a project with its own species, open each file in
   the "PBS" folder and copy the entries into the matching file in your
   project (PBS/pokemon.txt, PBS/pokemon_metrics.txt, and
   PBS/pokemon_dexentries.txt), anywhere after the last entry.
3. In RPG Maker, use the debug menu's "Compile all data" option so
   Essentials rebuilds its data from the PBS files.
4. Playtest and your whole collection should be ready to catch!

A couple things worth knowing:
- Only moves that already exist as vanilla moves got included in each
  learnset. Custom moves got left out, since they'd need actual script
  code written for them to do anything.${totalSkipped ? ` (${totalSkipped} custom move${totalSkipped === 1 ? '' : 's'} skipped across your collection.)` : ''}
- Moves without a level attached in the editor got exported as tutor
  moves, so they're still teachable instead of just disappearing.
- Custom abilities are left out of the Abilities/HiddenAbilities lines
  for the same reason as custom moves.
- Shape and Habitat are just placeholder defaults since the editor
  doesn't track those; feel free to change them in pokemon_metrics.txt.
`;
        }

        async function exportEssentialsMod() {
            try {
                const fakemon = typeof api.buildFakemonObject === 'function' ? api.buildFakemonObject() : null;
                if (!fakemon) { api.showToast('Please enter a Pokemon name first!', 'error'); return; }
                if (typeof JSZip === 'undefined') { api.showToast('ZIP library failed to load. Check your connection and try again.', 'error'); return; }

                const internalName = toEssentialsId(fakemon.name) || 'FAKEMON';
                const { block: pokemonBlock, evolutionNotes } = buildSpeciesBlock(fakemon, internalName, { fakemonList:[fakemon], internalNames:[internalName] });
                const metricsBlock = buildMetricsBlock(fakemon, internalName);
                const dexBlock = buildDexEntryBlock(fakemon, internalName);

                const zip = new JSZip();
                zip.file('pokemon.txt', `#-------------------------------\r\n${pokemonBlock}\r\n`);
                zip.file('pokemon_metrics.txt', `#-------------------------------\r\n${metricsBlock}\r\n`);
                zip.file('pokemon_dexentries.txt', `#-------------------------------\r\n${dexBlock}\r\n`);
                zip.file('README.txt', buildReadmeTxt(fakemon));
                const evolutionText = buildEvolutionNotesText([fakemon]);
                if (evolutionText) zip.file('evolution_notes.txt', evolutionText);
                const graph = getEssentialsEvolutionGraphForFakemon(fakemon);
                const vanillaOverrides = buildVanillaEvolutionOverrides(graph, [fakemon], [internalName]);
                if (vanillaOverrides) zip.file('vanilla_evolution_overrides.txt', vanillaOverrides);

                const blob = await zip.generateAsync({ type: 'blob' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `${internalName.toLowerCase()}-essentials-mod.zip`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                api.showToast('Essentials files exported!', 'success');
            } catch (err) {
                console.error('[Essentials Export]', err);
                api.showToast('Essentials export failed!', 'error');
            }
        }

        async function exportCollectionAsEssentialsMod() {
            try {
                const fakemonList = (state.fakemonDB || []).filter(f => f && f.name);
                if (!fakemonList.length) { api.showToast('Your collection is empty; nothing to export!', 'error'); return; }
                if (typeof JSZip === 'undefined') { api.showToast('ZIP library failed to load. Check your connection and try again.', 'error'); return; }

                const internalNames = makeUniqueInternalNames(fakemonList);
                let totalSkipped = 0;
                const pokemonBlocks = [];
                const metricsBlocks = [];
                const dexBlocks = [];
                const evolutionNotes = [];

                fakemonList.forEach((f, i) => {
                    const { block, skippedCustom, evolutionNotes: notes } = buildSpeciesBlock(f, internalNames[i], { fakemonList, internalNames });
                    if (notes?.length) evolutionNotes.push(...notes);
                    totalSkipped += skippedCustom.length;
                    pokemonBlocks.push(block);
                    metricsBlocks.push(buildMetricsBlock(f, internalNames[i]));
                    dexBlocks.push(buildDexEntryBlock(f, internalNames[i]));
                });

                const join = blocks => blocks.map(b => `#-------------------------------\r\n${b}`).join('\r\n') + '\r\n';

                const zip = new JSZip();
                const pbsFolder = zip.folder('PBS');
                pbsFolder.file('pokemon.txt', join(pokemonBlocks));
                pbsFolder.file('pokemon_metrics.txt', join(metricsBlocks));
                pbsFolder.file('pokemon_dexentries.txt', join(dexBlocks));
                zip.file('README.txt', buildCollectionReadmeTxt(fakemonList, totalSkipped));
                const evolutionText = buildEvolutionNotesText(fakemonList);
                if (evolutionText) zip.file('evolution_notes.txt', evolutionText);
                const graph = fakemonList.find(f => f?.evolutionGraph)?.evolutionGraph || state.evolutionGraph || null;
                const vanillaOverrides = buildVanillaEvolutionOverrides(graph, fakemonList, internalNames);
                if (vanillaOverrides) zip.file('vanilla_evolution_overrides.txt', vanillaOverrides);

                const blob = await zip.generateAsync({ type: 'blob' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `pbs-essentials-mod.zip`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                api.showToast('Collection exported for Essentials!', 'success');
            } catch (err) {
                console.error('[Collection Essentials Export]', err);
                api.showToast('Collection Essentials export failed!', 'error');
            }
        }

export { exportEssentialsMod, exportCollectionAsEssentialsMod };
