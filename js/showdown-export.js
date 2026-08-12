import { state, api } from './app.js';

// ==================== SHOWDOWN MOD EXPORT ====================
// Packages up the Fakemon currently open in the editor into a tiny
// Pokémon Showdown mod (pokedex.ts + learnsets.ts, plus install notes in
// the README) as a downloadable ZIP. Keeps things simple on purpose;
// custom moves/abilities aren't real Showdown data, so we skip trying to
// export those as mod files since they'd need actual battle-effect code
// to do anything.

        function toShowdownId(value) {
            return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        }

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
            // Using gen 9 ("9") learn-method notation. Moves with no explicit
            // method (learnMethod: 'none') get exported as tutor moves ("9T")
            // so they're still learnable instead of just vanishing.
            if (entry.learnMethod === 'level') return `9L${entry.level || 1}`;
            if (entry.learnMethod === 'tm') return '9M';
            if (entry.learnMethod === 'egg') return '9E';
            return '9T';
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

        function buildLearnsetLines(fakemon) {
            const learnset = (fakemon.learnset || []).filter(m => m && m.name && !(m.source === 'custom' || m.custom === true));
            const skippedCustom = (fakemon.learnset || []).filter(m => m && m.name && (m.source === 'custom' || m.custom === true));
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

        function buildPokedexTs(fakemon, speciesId) {
            const { entry, hasCustomAbility } = buildSpeciesEntry(fakemon);

            return `// Made with Woogidex!
// Toss this file into your Showdown server's mod folder as pokedex.ts
// (either an existing mod or a new one you make; see the README).
${hasCustomAbility ? '//\n// Heads up: this Fakemon has a custom ability on it, and that\'s not\n// something a vanilla Showdown server knows about, so it won\'t actually\n// do anything in battle. If you want it working, you\'ll need to write it\n// up yourself in an abilities.ts file in this same mod folder.\n' : ''}
export const Pokedex: {[k: string]: Partial<import('../../../sim/dex-species').SpeciesData>} = {
\t${speciesId}: ${JSON.stringify(entry, null, '\t').replace(/\n/g, '\n\t')},
};
`;
        }

        function buildLearnsetsTs(fakemon, speciesId) {
            const { entries, skippedCustom } = buildLearnsetLines(fakemon);

            return `// Made with Woogidex!
// Toss this file into your Showdown server's mod folder as learnsets.ts
// (either an existing mod or a new one you make; see the README).
//
// Only moves that actually exist in vanilla Showdown made the cut here.${skippedCustom.length ? `\n// Left out ${skippedCustom.length} custom move${skippedCustom.length === 1 ? '' : 's'} Showdown doesn't know about: ${skippedCustom.map(m => m.name).join(', ')}.` : ''}

export const Learnsets: {[k: string]: import('../../../sim/dex-species').LearnsetData} = {
\t${speciesId}: {
\t\tlearnset: {
${entries || '\t\t\t// No vanilla Showdown moves in this learnset.'}
\t\t},
\t},
};
`;
        }

        function buildReadmeTxt(fakemon) {
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
- Only moves ${fakemon.name} learns that already exist in vanilla Showdown
  made it into the learnset. Any custom moves got left out, since they'd
  need actual battle-effect code written for them to work.
- Same deal with custom abilities; they're listed by name in pokedex.ts,
  but won't do anything in battle unless you write them up yourself in an
  abilities.ts file in the mod folder.
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
- Only moves that already exist in vanilla Showdown made it into each
  learnset. Custom moves got left out, since they'd need actual
  battle-effect code written for them to work.${skippedTotal ? ` (${skippedTotal} custom move${skippedTotal === 1 ? '' : 's'} skipped across your collection.)` : ''}
- Custom abilities are still listed by name in pokedex.ts, but won't do
  anything in battle unless you write them up yourself in an abilities.ts
  file in the mod folder.
`;
        }

        async function exportShowdownMod() {
            try {
                const fakemon = typeof api.buildFakemonObject === 'function' ? api.buildFakemonObject() : null;
                if (!fakemon) { api.showToast('Please enter a Pokemon name first!', 'error'); return; }
                if (typeof JSZip === 'undefined') { api.showToast('ZIP library failed to load. Check your connection and try again.', 'error'); return; }

                const speciesId = toShowdownId(fakemon.name) || 'fakemon';
                const zip = new JSZip();
                zip.file('pokedex.ts', buildPokedexTs(fakemon, speciesId));
                zip.file('learnsets.ts', buildLearnsetsTs(fakemon, speciesId));
                zip.file('README.txt', buildReadmeTxt(fakemon));

                const blob = await zip.generateAsync({ type: 'blob' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `${speciesId}-showdown-mod.zip`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                api.showToast('Showdown mod exported!', 'success');
            } catch (err) {
                console.error('[Showdown Mod Export]', err);
                api.showToast('Showdown mod export failed!', 'error');
            }
        }

        function buildCollectionPokedexTs(fakemonList, speciesIds) {
            const anyCustomAbility = fakemonList.some(f => (f.abilities || []).some(a => a && (a.source === 'custom' || a.custom === true)));
            const entries = fakemonList.map((f, i) => {
                const { entry } = buildSpeciesEntry(f);
                return `\t${speciesIds[i]}: ${JSON.stringify(entry, null, '\t').replace(/\n/g, '\n\t')},`;
            }).join('\n');

            return `// Made with Woogidex!
// Your whole collection's species data, ready to drop into
// data/mods/<modname>/pokedex.ts (this file's already sitting in the mod
// folder in this ZIP, so you shouldn't need to move it).
${anyCustomAbility ? '//\n// Heads up: some of these Fakemon have custom abilities on them, and\n// that\'s not something a vanilla Showdown server knows about, so those\n// abilities won\'t actually do anything in battle. If you want them\n// working, you\'ll need to write them up yourself in an abilities.ts file\n// in this same mod folder.\n' : ''}
export const Pokedex: {[k: string]: Partial<import('../../../sim/dex-species').SpeciesData>} = {
${entries}
};
`;
        }

        function buildCollectionLearnsetsTs(fakemonList, speciesIds) {
            let totalSkipped = 0;
            const entries = fakemonList.map((f, i) => {
                const { entries: lines, skippedCustom } = buildLearnsetLines(f);
                totalSkipped += skippedCustom.length;
                return `\t${speciesIds[i]}: {\n\t\tlearnset: {\n${lines || '\t\t\t// No vanilla Showdown moves in this learnset.'}\n\t\t},\n\t},`;
            }).join('\n');

            const text = `// Made with Woogidex!
// Your whole collection's learnsets, ready to drop into
// data/mods/<modname>/learnsets.ts (this file's already sitting in the
// mod folder in this ZIP, so you shouldn't need to move it).
//
// Only moves that actually exist in vanilla Showdown made the cut here.${totalSkipped ? `\n// Left out ${totalSkipped} custom move${totalSkipped === 1 ? '' : 's'} across your collection that Showdown doesn't know about.` : ''}

export const Learnsets: {[k: string]: import('../../../sim/dex-species').LearnsetData} = {
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
                zip.file('README.txt', buildCollectionReadmeTxt(fakemonList, modId, totalSkipped));

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
                console.error('[Collection Showdown Mod Export]', err);
                api.showToast('Collection Showdown mod export failed!', 'error');
            }
        }

export { exportShowdownMod, exportCollectionAsShowdownMod };