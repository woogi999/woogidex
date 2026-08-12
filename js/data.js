// ==================== REFERENCE DATA ====================
        const POKEMON_TYPES = [
            'Normal','Fire','Water','Electric','Grass','Ice',
            'Fighting','Poison','Ground','Flying','Psychic','Bug',
            'Rock','Ghost','Dragon','Dark','Steel','Fairy'
        ];
        const POKEMON_COLORS = [
            {name:'Red',hex:'#ef4444'},{name:'Blue',hex:'#3b82f6'},{name:'Yellow',hex:'#eab308'},
            {name:'Green',hex:'#22c55e'},{name:'Black',hex:'#1f2937'},{name:'Brown',hex:'#92400e'},
            {name:'Purple',hex:'#a855f7'},{name:'Gray',hex:'#6b7280'},{name:'White',hex:'#f3f4f6'},
            {name:'Pink',hex:'#ec4899'},{name:'Orange',hex:'#f97316'},{name:'Cyan',hex:'#06b6d4'}
        ];
        const NATURE_DATA = {
            'Adamant': { up: 'atk', down: 'spa' },
            'Bashful': { up: 'spa', down: 'spa' },
            'Bold': { up: 'def', down: 'atk' },
            'Brave': { up: 'atk', down: 'spe' },
            'Calm': { up: 'spd', down: 'atk' },
            'Careful': { up: 'spd', down: 'spa' },
            'Docile': { up: 'def', down: 'def' },
            'Gentle': { up: 'spd', down: 'def' },
            'Hardy': { up: 'atk', down: 'atk' },
            'Hasty': { up: 'spe', down: 'def' },
            'Impish': { up: 'def', down: 'spa' },
            'Jolly': { up: 'spe', down: 'spa' },
            'Lax': { up: 'def', down: 'spd' },
            'Lonely': { up: 'atk', down: 'def' },
            'Mild': { up: 'spa', down: 'def' },
            'Modest': { up: 'spa', down: 'atk' },
            'Naive': { up: 'spe', down: 'spd' },
            'Naughty': { up: 'atk', down: 'spd' },
            'Quiet': { up: 'spa', down: 'spe' },
            'Quirky': { up: 'spd', down: 'spd' },
            'Rash': { up: 'spa', down: 'spd' },
            'Relaxed': { up: 'def', down: 'spe' },
            'Sassy': { up: 'spd', down: 'spe' },
            'Serious': { up: 'spe', down: 'spe' },
            'Timid': { up: 'spe', down: 'atk' }
        };
        const NATURES = Object.keys(NATURE_DATA);
function getCategoryIcon(category, size) {
    size = size || 16;
    const urls = {
        'Physical': 'https://img.pokemondb.net/images/icons/move-physical.png',
        'Special': 'https://img.pokemondb.net/images/icons/move-special.png',
        'Status': 'https://img.pokemondb.net/images/icons/move-status.png'
    };
    const url = urls[category] || urls['Status'];
    return `<img src="${url}" alt="${category}" style="width:${size}px;height:${size}px;vertical-align:middle;image-rendering:auto;">`;
}



// Standard Pokémon type-effectiveness chart.
// Values are the damage multipliers for an attacking type against a defending type.
const TYPE_EFFECTIVENESS = {
    Normal:   { Rock:0.5, Ghost:0, Steel:0.5 },
    Fire:     { Fire:0.5, Water:0.5, Grass:2, Ice:2, Bug:2, Rock:0.5, Dragon:0.5, Steel:2 },
    Water:    { Fire:2, Water:0.5, Grass:0.5, Ground:2, Rock:2, Dragon:0.5 },
    Electric: { Water:2, Electric:0.5, Grass:0.5, Ground:0, Flying:2, Dragon:0.5 },
    Grass:    { Fire:0.5, Water:2, Grass:0.5, Poison:0.5, Ground:2, Flying:0.5, Bug:0.5, Rock:2, Dragon:0.5, Steel:0.5 },
    Ice:      { Fire:0.5, Water:0.5, Grass:2, Ice:0.5, Ground:2, Flying:2, Dragon:2, Steel:0.5 },
    Fighting: { Normal:2, Ice:2, Poison:0.5, Flying:0.5, Psychic:0.5, Bug:0.5, Rock:2, Ghost:0, Dark:2, Steel:2, Fairy:0.5 },
    Poison:   { Grass:2, Poison:0.5, Ground:0.5, Rock:0.5, Ghost:0.5, Steel:0, Fairy:2 },
    Ground:   { Fire:2, Electric:2, Grass:0.5, Poison:2, Flying:0, Bug:0.5, Rock:2, Steel:2 },
    Flying:   { Electric:0.5, Grass:2, Fighting:2, Bug:2, Rock:0.5, Steel:0.5 },
    Psychic:  { Fighting:2, Poison:2, Psychic:0.5, Steel:0.5, Dark:0 },
    Bug:      { Fire:0.5, Grass:2, Fighting:0.5, Poison:0.5, Flying:0.5, Psychic:2, Ghost:0.5, Dark:2, Steel:0.5, Fairy:0.5 },
    Rock:     { Fire:2, Ice:2, Fighting:0.5, Ground:0.5, Flying:2, Bug:2, Steel:0.5 },
    Ghost:    { Normal:0, Psychic:2, Ghost:2, Dark:0.5 },
    Dragon:   { Dragon:2, Steel:0.5, Fairy:0 },
    Dark:     { Fighting:0.5, Psychic:2, Ghost:2, Dark:0.5, Fairy:0.5 },
    Steel:    { Fire:0.5, Water:0.5, Electric:0.5, Ice:2, Rock:2, Fairy:2, Steel:0.5 },
    Fairy:    { Fire:0.5, Fighting:2, Poison:0.5, Dragon:2, Dark:2, Steel:0.5 }
};

        const STAT_NAMES = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

        function findNatureByBoosts(upStat, downStat) {
            return Object.entries(NATURE_DATA).find(([name, data]) => data.up === upStat && data.down === downStat)?.[0] || 'Hardy';
        }

        function getNatureOptionLabel(nature) {
            const data = NATURE_DATA[nature];
            if (!data || data.up === data.down) return nature;
            return `${nature}  (+${STAT_NAMES[data.up]}, −${STAT_NAMES[data.down]})`;
        }


export { getCategoryIcon, findNatureByBoosts, getNatureOptionLabel, POKEMON_TYPES, POKEMON_COLORS, NATURE_DATA, NATURES, STAT_NAMES, TYPE_EFFECTIVENESS };