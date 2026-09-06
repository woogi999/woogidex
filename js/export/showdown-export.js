import { log } from '../core/log.js';
import { state, api } from '../core/app.js';

// packages the Fakemon open in the editor into a Showdown mod (pokedex.ts +
// learnsets.ts, plus a README) as a ZIP. Custom moves/abilities without
// battle-effect code are skipped since there's nothing for Showdown to run.

import { toId as toShowdownId } from '../core/html.js';

        function parseHeightToMeters(heightDisplay) {
            const match = String(heightDisplay || '').trim().match(/^([\d.]+)\s*(m|ft)?$/i);
            if (!match) return 0;
            const val = parseFloat(match[1]) || 0;
            const unit = (match[2] || 'm').toLowerCase();
            return Math.round((unit === 'ft' ? val / 3.28084 : val) * 100) / 100;
        }

        function parseWeightToKg(weightDisplay) {
            const match = String(weightDisplay || '').trim().match(/^([\d.]+)\s*(kg|lb)?$/i);
            if (!match) return 0;
            const val = parseFloat(match[1]) || 0;
            const unit = (match[2] || 'kg').toLowerCase();
            return Math.round((unit === 'lb' ? val / 2.20462 : val) * 10) / 10;
        }

        function getEggGroupsArray(eggGroups) {
            if (Array.isArray(eggGroups)) return eggGroups.filter(Boolean);
            const text = String(eggGroups || '').trim();
            if (!text || /^none$/i.test(text)) return [];
            return text.split(/\s*,\s*/).filter(Boolean);
        }

        function buildGenderField(genderRatio) {
            const ratio = String(genderRatio || '50-50').trim();
            if (ratio === 'genderless') return { gender: 'N' };
            const parts = ratio.split('-').map(Number);
            const male = isNaN(parts[0]) ? 50 : parts[0];
            const female = isNaN(parts[1]) ? (100 - male) : parts[1];
            if (male === 100 && female === 0) return { gender: 'M' };
            if (male === 0 && female === 100) return { gender: 'F' };
            return { genderRatio: { M: Math.round((male / 100) * 100) / 100, F: Math.round((female / 100) * 100) / 100 } };
        }

        function buildAbilitiesField(abilities) {
            const entries = (abilities || []).filter(a => a && a.name && a.name.trim());
            const slots = entries.map((a, i) => ({ ...a, role: api.getAbilityRole ? api.getAbilityRole(i) : '' }));
            const normal = slots.filter(a => !a.role);
            const hidden = slots.find(a => a.role === 'Hidden');
            const event = slots.find(a => a.role === 'Event');
            const out = {};
            normal.forEach((a, i) => { out[String(i)] = a.name; });
            if (hidden) out.H = hidden.name;
            if (event) out.S = event.name;
            return out;
        }

        function learnMethodToken(entry) {
            // gen 9 notation; moves with no explicit method export as tutor moves
            if (entry.learnMethod === 'level') return `9L${entry.level || 1}`;
            if (entry.learnMethod === 'tm') return '9M';
            if (entry.learnMethod === 'egg') return '9E';
            return '9T';
        }

        function getShowdownEvolutionGraphForFakemon(fakemon) {
            return fakemon?.evolutionGraph || state.evolutionGraph || null;
        }

        // a graph can contain both Fakemon and vanilla Showdown species, so
        // don't restrict either endpoint to kind === "fakemon"
        function collectShowdownEvolutionRelations(graph) {
            if (!graph?.nodes || !graph?.edges) return [];
            const nodes = graph.nodes;
            const outgoing = new Map();
            graph.edges.forEach(e => {
                if (!outgoing.has(e.from)) outgoing.set(e.from, []);
                outgoing.get(e.from).push(e.to);
            });
            const methods = new Set(nodes.filter(n => n?.kind === 'method').map(n => n.id));
            const relations = [];
            const walk = (parent, nodeId, methodList, seen) => {
                if (seen.has(nodeId)) return;
                const node = nodes.find(n => n.id === nodeId);
                if (!node) return;
                const nextSeen = new Set(seen); nextSeen.add(nodeId);
                if (!methods.has(nodeId)) {
                    relations.push({ parent, child: node, methods: [...methodList] });
                    return;
                }
                const nextMethods = [...methodList, node];
                (outgoing.get(nodeId) || []).forEach(next => walk(parent, next, nextMethods, nextSeen));
            };
            nodes.filter(n => n && n.kind !== 'method').forEach(parent => {
                (outgoing.get(parent.id) || []).forEach(next => walk(parent, next, [], new Set([parent.id])));
            });
            const unique = new Map();
            relations.forEach(r => {
                const key = `${r.parent.id}->${r.child.id}:${r.methods.map(m => m.id).join('|')}`;
                if (!unique.has(key)) unique.set(key, r);
            });
            return [...unique.values()];
        }

        function buildShowdownEvolutionContext(fakemonList, graphOverride = null) {
            const fakemonIds = new Map((fakemonList || []).map((f, i) => [String(f.id), toShowdownId(f.name) || `fakemon${i + 1}`]));
            const graph = graphOverride || fakemonList?.find(f => f?.evolutionGraph)?.evolutionGraph || state.evolutionGraph || null;
            if (!graph?.nodes) return { graph: null, speciesByNode: new Map(), relations: [] };
            const used = new Set(fakemonIds.values());
            const speciesByNode = new Map();
            graph.nodes.forEach(n => {
                if (!n || n.kind === 'method') return;
                let id = '';
                if (n.kind === 'fakemon' && n.refId) id = fakemonIds.get(String(n.refId)) || toShowdownId(n.name || n.refId);
                else id = toShowdownId(n.refId || n.name);
                if (!id) return;
                let unique = id, i = 2;
                while (used.has(unique) && ![...fakemonIds.values()].includes(unique)) unique = `${id}${i++}`;
                used.add(unique); speciesByNode.set(n.id, unique);
            });
            return { graph, speciesByNode, relations: collectShowdownEvolutionRelations(graph) };
        }

        function applyEvolutionToSpeciesEntries(entries, fakemonList, speciesIds, graphOverride = null) {
            const ctx = buildShowdownEvolutionContext(fakemonList, graphOverride);
            if (!ctx.graph) return [];
            const byId = new Map();
            entries.forEach((entry, i) => byId.set(speciesIds[i], entry));
            ctx.speciesByNode.forEach((speciesId, nodeId) => {
                if (!byId.has(speciesId)) {
                    const node = ctx.graph.nodes.find(n => n.id === nodeId);
                    byId.set(speciesId, { name: node?.name || speciesId });
                }
            });
            const notes = [];
            ctx.relations.forEach(r => {
                const parentId = ctx.speciesByNode.get(r.parent.id), childId = ctx.speciesByNode.get(r.child.id);
                if (!parentId || !childId || parentId === childId) return;
                const parent = byId.get(parentId), child = byId.get(childId);
                if (!parent || !child) return;
                parent.evos = [...new Set([...(parent.evos || []), childId])];
                child.prevo = child.prevo || parentId;
                const methods = r.methods || [];
                if (!methods.length) return;
                const labels = methods.map(m => {
                    if (m.methodType === 'level') return `Level ${Number(m.value) || 1}`;
                    if (m.methodType === 'item') return `Use ${m.value || 'an item'}`;
                    return String(m.description || 'Custom condition');
                });
                const first = methods[0];
                if (first.methodType === 'level') { child.evoType = 'level'; child.evoLevel = Number(first.value) || 1; }
                else if (first.methodType === 'item' && first.value) { child.evoType = 'useItem'; child.evoItem = toShowdownId(first.value); }
                else child.evoType = 'other';
                if (labels.length > 1 || first.methodType === 'custom') child.evoCondition = labels.join(' + ');
                if (first.methodType === 'custom' || labels.length > 1) notes.push(`${child.name}: ${labels.join(' + ')}`);
            });
            return notes;
        }

        function buildSpeciesEntry(fakemon) {
            const num = parseInt(String(fakemon.number || '').replace(/[^0-9]/g, ''), 10) || 0;
            const types = [fakemon.type1, fakemon.type2].filter(Boolean);
            const eggGroups = getEggGroupsArray(fakemon.eggGroups);
            const entry = {
                num,
                name: fakemon.name,
                types: types.length ? types : ['Normal'],
                ...buildGenderField(fakemon.genderRatio),
                baseStats: {
                    hp: fakemon.stats.hp, atk: fakemon.stats.atk, def: fakemon.stats.def,
                    spa: fakemon.stats.spa, spd: fakemon.stats.spd, spe: fakemon.stats.spe
                },
                abilities: buildAbilitiesField(fakemon.abilities),
                heightm: parseHeightToMeters(fakemon.height),
                weightkg: parseWeightToKg(fakemon.weight),
                color: fakemon.color || 'Gray',
                eggGroups: eggGroups.length ? eggGroups : ['Undiscovered']
            };
            if (fakemon.isMega || fakemon.isFormeChange) {
                entry.baseSpecies = fakemon.species || fakemon.name;
                entry.forme = fakemon.isMega ? 'Mega' : 'Forme';
            }
            const hasCustomAbility = (fakemon.abilities || []).some(a => a && (a.source === 'custom' || a.custom === true));
            return { entry, hasCustomAbility };
        }

        // a custom move with battle logic (block-built or hand-written) belongs
        // in the learnset alongside vanilla moves; only a move with no logic at
        // all is skipped, since exporting an unresolvable name breaks the file
        function customMoveHasCode(entry) {
            const lib = (state.customMoves || []).find(x => x.id === entry.customId)
                || (state.customMoves || []).find(x => String(x.name || '').toLowerCase() === String(entry.name || '').toLowerCase());
            return !!api.hasExportableCode?.(lib);
        }

        function buildLearnsetLines(fakemon) {
            const isCustom = (m) => m.source === 'custom' || m.custom === true;
            const named = (fakemon.learnset || []).filter(m => m && m.name);
            const learnset = named.filter(m => !isCustom(m) || customMoveHasCode(m));
            const skippedCustom = named.filter(m => isCustom(m) && !customMoveHasCode(m));
            const entries = learnset.map(m => `\t\t\t${toShowdownId(m.name)}: ["${learnMethodToken(m)}"],`).join('\n');
            return { entries, skippedCustom };
        }

        function makeUniqueSpeciesIds(fakemonList) {
            const used = new Map();
            return fakemonList.map(f => {
                let id = toShowdownId(f.name) || 'fakemon';
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
                const graph = getShowdownEvolutionGraphForFakemon(f);
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

        function buildPokedexTs(fakemon, speciesId) {
            const { entry, hasCustomAbility } = buildSpeciesEntry(fakemon);
            const graph = getShowdownEvolutionGraphForFakemon(fakemon);
            const ctx = buildShowdownEvolutionContext([fakemon], graph);
            const entries = new Map([[speciesId, entry]]);
            ctx.speciesByNode.forEach((id, nodeId) => {
                if (!entries.has(id)) {
                    const node = graph.nodes.find(n => n.id === nodeId);
                    entries.set(id, { name: node?.name || id });
                }
            });
            applyEvolutionToSpeciesEntries([...entries.values()], [fakemon], [speciesId], graph);
            const body = [...entries.entries()].map(([id, data]) => `\t${id}: ${JSON.stringify(data, null, '\t').replace(/\n/g, '\n\t')},`).join('\n');
            return `// Made with Woogidex!\n// Evolution graph data includes vanilla species present on the board.\nexport const Pokedex: {[k: string]: Partial<import('../../../../sim/dex-species').SpeciesData>} = {\n${body}\n};\n`;
        }

        function buildLearnsetsTs(fakemon, speciesId) {
            const { entries, skippedCustom } = buildLearnsetLines(fakemon);

            return `// Made with Woogidex!
// toss this file into your Showdown server's mod folder as learnsets.ts
// (either an existing mod or a new one you make; see the README).
//
// only moves that actually exist in vanilla Showdown made the cut here.${skippedCustom.length ? `\n// left out ${skippedCustom.length} custom move${skippedCustom.length === 1 ? '' : 's'} Showdown doesn't know about: ${skippedCustom.map(m => m.name).join(', ')}.` : ''}

export const Learnsets: {[k: string]: import('../../../../sim/dex-species').LearnsetData} = {
\t${speciesId}: {
\t\tlearnset: {
${entries || '\t\t\t// No vanilla Showdown moves in this learnset.'}
\t\t},
\t},
};
`;
        }

        function buildReadmeTxt(fakemon, family = [fakemon]) {
            const relatives = (family || []).filter(f => f && f !== fakemon).map(f => f.name);
            const familyNote = relatives.length
                ? `\n- Its family came along too, with full stats and learnsets: ${relatives.join(', ')}.`
                : '';
            return `${fakemon.name}'s Showdown Mod
===================================

Hey! This ZIP has everything you need to get ${fakemon.name} running on
your own Pokémon Showdown server.

What's inside:
- pokedex.ts; the species data (stats, types, abilities, etc.)
- learnsets.ts; its moveset (vanilla Showdown moves only, more on that below)

Getting it installed:
1. Drop pokedex.ts and learnsets.ts into a mod folder on your server, at
   data/mods/<modname>/. You can use a mod you already have going, or
   make a new folder there for this Fakemon; either works.
2. Get ${fakemon.name} into a format so you can actually battle with it.
   You've got two options:
   a. Add it to a format you already run. Find that format's entry in
      config/formats.ts and set mod: '<modname>' to point at the mod
      folder from step 1 (if it already has a different mod, you'll
      need to merge the two mods together; Showdown only allows one
      mod per format).
   b. Make a new format for it. Something like this works:
        {
            name: "[Gen 9] ${fakemon.name} Mod",
            mod: '<modname>',
            ruleset: ['Standard', 'Dynamax Clause'],
        },
      Add that to the Formats array in config/formats.ts.
3. Restart your server and you're set.

A couple things worth knowing:
- Vanilla moves ${fakemon.name} learns went straight into the learnset. A
  custom move is only left out of it if it has no battle logic at all -
  anything you built in the block editor or wrote by hand was exported to
  moves.ts, and its learnset line came with it.
- Custom abilities are listed by name in pokedex.ts, and any you gave battle
  logic to - block editor or hand-written code - were exported to
  abilities.ts. Custom items go to items.ts the same way. Keep whichever of
  those files you got in the mod folder alongside pokedex.ts. Anything with
  no logic at all won't do anything in battle until you write it up in that
  file yourself.${familyNote}
`;
        }

        function buildCollectionReadmeTxt(fakemonList, modId, skippedTotal) {
            const names = fakemonList.map(f => f.name).join(', ');
            return `Your Collection's Showdown Mod
===================================

Hey! This ZIP has your whole collection (${fakemonList.length} Fakemon)
bundled into one ready-to-go Pokémon Showdown mod: ${names}.

What's inside:
- A "${modId}" folder with pokedex.ts and learnsets.ts for every Fakemon
  in your collection. It's already set up as a full mod folder, so you
  don't need to build anything yourself.

Getting it installed:
1. Drag the "${modId}" folder straight into your server's data/mods/
   directory. That's it for the mod itself.
2. Get your Fakemon into a format so you can actually battle with them.
   You've got two options:
   a. Add this mod to a format you already run. Find that format's entry
      in config/formats.ts and set mod: '${modId}' to point at the folder
      you just dropped in (if it already has a different mod, you'll
      need to merge the two mods together; Showdown only allows one
      mod per format).
   b. Make a new format for it. Something like this works:
        {
            name: "[Gen 9] My Collection Mod",
            mod: '${modId}',
            ruleset: ['Standard', 'Dynamax Clause'],
        },
      Add that to the Formats array in config/formats.ts.
3. Restart your server and you're set.

A couple things worth knowing:
- Vanilla moves went straight into each learnset. A custom move is only left
  out if it has no battle logic at all - anything you built in the block
  editor or wrote by hand was exported to moves.ts.${skippedTotal ? ` (${skippedTotal} custom move${skippedTotal === 1 ? '' : 's'} skipped across your collection.)` : ''}
- Custom abilities are still listed by name in pokedex.ts, and any you gave
  battle logic to - block editor or hand-written code - were exported into
  this same folder's abilities.ts. Custom items go to items.ts the same way.
  Anything with no logic at all needs to be written up by hand in those
  files.
`;
        }

        async function exportShowdownMod() {
            try {
                const fakemon = typeof api.buildFakemonObject === 'function' ? api.buildFakemonObject() : null;
                if (!fakemon) { api.showToast('Please enter a Pokemon name first!', 'error'); return; }
                if (typeof JSZip === 'undefined') { api.showToast('ZIP library failed to load. Check your connection and try again.', 'error'); return; }

                // prevos/evolutions/megas/formes are separate Fakemon on the
                // evolution board; export the whole family, not name-only stubs
                const family = api.buildFakemonExportBundle?.(fakemon)?.fakemonDB || [fakemon];
                const speciesIds = makeUniqueSpeciesIds(family);
                const zip = new JSZip();
                zip.file('pokedex.ts', buildCollectionPokedexTs(family, speciesIds));
                const { text: learnsetsText } = buildCollectionLearnsetsTs(family, speciesIds);
                zip.file('learnsets.ts', learnsetsText);
                const abilitiesTs = api.buildShowdownAbilitiesFile ? api.buildShowdownAbilitiesFile(family) : null;
                if (abilitiesTs) zip.file('abilities.ts', abilitiesTs);
                const movesTs = api.buildShowdownMovesFile ? api.buildShowdownMovesFile(family) : null;
                if (movesTs) zip.file('moves.ts', movesTs);
                const itemsTs = api.buildShowdownItemsFile ? api.buildShowdownItemsFile(family) : null;
                if (itemsTs) zip.file('items.ts', itemsTs);
                zip.file('README.txt', buildReadmeTxt(fakemon, family));
                const evolutionNotes = buildEvolutionNotesText(family);
                if (evolutionNotes) zip.file('evolution_notes.txt', evolutionNotes);

                const blob = await zip.generateAsync({ type: 'blob' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `${speciesIds[0]}-showdown-mod.zip`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                api.showToast('Showdown mod exported!', 'success');
            } catch (err) {
                log.error('SHOWDOWN EXPORT', 'Showdown mod export failed', err);
                api.showToast('Showdown mod export failed!', 'error');
            }
        }

        function buildCollectionPokedexTs(fakemonList, speciesIds) {
            const entries = new Map();
            fakemonList.forEach((f, i) => entries.set(speciesIds[i], buildSpeciesEntry(f).entry));
            const graph = fakemonList.find(f => f?.evolutionGraph)?.evolutionGraph || state.evolutionGraph || null;
            const ctx = buildShowdownEvolutionContext(fakemonList, graph);
            ctx.speciesByNode.forEach((id, nodeId) => {
                if (!entries.has(id)) {
                    const node = graph.nodes.find(n => n.id === nodeId);
                    entries.set(id, { name: node?.name || id });
                }
            });
            const entryList = [...entries.values()];
            const idList = [...entries.keys()];
            applyEvolutionToSpeciesEntries(entryList, fakemonList, idList, graph);
            const anyCustomAbility = fakemonList.some(f => (f.abilities || []).some(a => a && (a.source === 'custom' || a.custom === true)));
            const body = [...entries.entries()].map(([id, data]) => `\t${id}: ${JSON.stringify(data, null, '\t').replace(/\n/g, '\n\t')},`).join('\n');
            return `// Made with Woogidex!\n// Evolution graph data includes vanilla species present on the board.\n${anyCustomAbility ? '// Some custom abilities are display-only until implemented in the mod.\n' : ''}export const Pokedex: {[k: string]: Partial<import('../../../../sim/dex-species').SpeciesData>} = {\n${body}\n};\n`;
        }

        function buildCollectionLearnsetsTs(fakemonList, speciesIds) {
            let totalSkipped = 0;
            const entries = fakemonList.map((f, i) => {
                const { entries: lines, skippedCustom } = buildLearnsetLines(f);
                totalSkipped += skippedCustom.length;
                return `\t${speciesIds[i]}: {\n\t\tlearnset: {\n${lines || '\t\t\t// No vanilla Showdown moves in this learnset.'}\n\t\t},\n\t},`;
            }).join('\n');

            const text = `// Made with Woogidex!
// your whole collection's learnsets, ready to drop into
// data/mods/<modname>/learnsets.ts (this file's already sitting in the
// mod folder in this ZIP, so you shouldn't need to move it).
//
// only moves that actually exist in vanilla Showdown made the cut here.${totalSkipped ? `\n// left out ${totalSkipped} custom move${totalSkipped === 1 ? '' : 's'} across your collection that Showdown doesn't know about.` : ''}

export const Learnsets: {[k: string]: import('../../../../sim/dex-species').LearnsetData} = {
${entries}
};
`;
            return { text, totalSkipped };
        }

        async function exportCollectionAsShowdownMod() {
            try {
                const fakemonList = (state.fakemonDB || []).filter(f => f && f.name);
                if (!fakemonList.length) { api.showToast('Your collection is empty; nothing to export!', 'error'); return; }
                if (typeof JSZip === 'undefined') { api.showToast('ZIP library failed to load. Check your connection and try again.', 'error'); return; }

                const modId = 'woogidexmod';
                const speciesIds = makeUniqueSpeciesIds(fakemonList);

                const zip = new JSZip();
                const modFolder = zip.folder(modId);
                modFolder.file('pokedex.ts', buildCollectionPokedexTs(fakemonList, speciesIds));
                const { text: learnsetsText, totalSkipped } = buildCollectionLearnsetsTs(fakemonList, speciesIds);
                modFolder.file('learnsets.ts', learnsetsText);
                const abilitiesTs = api.buildShowdownAbilitiesFile ? api.buildShowdownAbilitiesFile(fakemonList) : null;
                if (abilitiesTs) modFolder.file('abilities.ts', abilitiesTs);
                const movesTs = api.buildShowdownMovesFile ? api.buildShowdownMovesFile(fakemonList) : null;
                if (movesTs) modFolder.file('moves.ts', movesTs);
                const itemsTs = api.buildShowdownItemsFile ? api.buildShowdownItemsFile(fakemonList) : null;
                if (itemsTs) modFolder.file('items.ts', itemsTs);
                zip.file('README.txt', buildCollectionReadmeTxt(fakemonList, modId, totalSkipped));
                const evolutionNotes = buildEvolutionNotesText(fakemonList);
                if (evolutionNotes) zip.file('evolution_notes.txt', evolutionNotes);

                const blob = await zip.generateAsync({ type: 'blob' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `${modId}-showdown-mod.zip`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                api.showToast('Collection exported as a Showdown mod!', 'success');
            } catch (err) {
                log.error('SHOWDOWN EXPORT', 'Collection Showdown mod export failed', err);
                api.showToast('Collection Showdown mod export failed!', 'error');
            }
        }

export { exportShowdownMod, exportCollectionAsShowdownMod };