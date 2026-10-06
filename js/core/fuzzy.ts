// Forgiving search for short names (emojis, for now): "sob", "crying",
// "cryng" and "sad" should all find 😭. Each thing searched has a few terms
// (its shortcodes, its name, synonyms), each weighted; the query is scored
// against every term and the best one counts.
//
//   exact             100     sob      -> sob
//   starts with        90..80 so       -> sob
//   a later word       75     crying   -> loudly crying face
//   a typo or two      45..20 cryign   -> crying
//   inside a word      40     ob       -> sob
//   letters in order   20     lcf      -> loudly crying face
//
// A query of several words ("red heart") needs every word to match some
// term; the result is their average.

export interface FuzzyTerm { text: string; weight: number; }

/** Lowercased, with _ - and runs of spaces read as one space. */
export function normalizeTerm(s: string): string {
    return String(s || '').toLowerCase().replace(/[_\-\s]+/g, ' ').trim();
}

/**
 * Edit distance with swaps counted as one edit (optimal string alignment),
 * giving up once it's past `max` (returns max + 1).
 */
function editDistance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const n = a.length, m = b.length;
    let prev2 = new Array(m + 1).fill(0);
    let prev = Array.from({ length: m + 1 }, (_, j) => j);
    for (let i = 1; i <= n; i++) {
        const cur = new Array(m + 1);
        cur[0] = i;
        let best = cur[0];
        for (let j = 1; j <= m; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
            cur[j] = v;
            if (v < best) best = v;
        }
        if (best > max) return max + 1;
        prev2 = prev;
        prev = cur;
    }
    return prev[m];
}

function isSubsequence(q: string, t: string): boolean {
    let i = 0;
    for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++;
    return i === q.length;
}

/** How well one query word fits one term, 0 to 100. */
function scoreWord(q: string, t: string): number {
    if (!q || !t) return 0;
    if (t === q) return 100;
    if (t.startsWith(q)) return 90 - Math.min(10, t.length - q.length);
    if (t.includes(' ' + q)) return 75;
    // inside a word: weaker than a near-miss at a word's start ("hart": heart, not chart)
    if (t.includes(q)) return 40;
    // a typo while typing, against the term's start, the whole term, or any of
    // its words. Getting the first letter right counts for more ("piza" is
    // pizza before lizard), and three letters need it ("dgo" is dog, but "sob"
    // isn't robot); a near-miss on the whole term beats one on a word inside a
    // longer one ("hart" is heart before smiling face with hearts).
    if (q.length >= 3) {
        const allowed = q.length >= 7 ? 2 : 1;
        let best = allowed + 1, first = false, whole = false;
        for (const w of t.includes(' ') ? [t, ...t.split(' ')] : [t]) {
            const f = w[0] === q[0];
            if (q.length === 3 && !f) continue;
            const full = editDistance(q, w, allowed);
            // three letters: only a near-miss on a whole word ("dgo"/dog, not "sob"/soccer)
            const start = q.length === 3 ? allowed + 1 : Math.min(editDistance(q, w.slice(0, q.length), allowed), editDistance(q, w.slice(0, q.length + 1), allowed));
            const d = Math.min(full, start);
            const w2 = w === t && full <= start;
            if (d < best || (d === best && ((f && !first) || (f === first && w2 && !whole)))) { best = d; first = f; whole = w2; }
            if (best === 1 && first && whole) break;
        }
        if (best <= allowed) return (first ? 45 : 35) - (whole ? 0 : 3) - (best - 1) * 15;
    }
    if (q.length >= 3 && isSubsequence(q, t)) return 20;
    return 0;
}

/** The query's score against something with these terms, 0 if it doesn't match. */
export function fuzzyScore(query: string, terms: FuzzyTerm[]): number {
    const q = normalizeTerm(query);
    if (!q) return 0;
    let whole = 0;
    for (const t of terms) whole = Math.max(whole, scoreWord(q, t.text) * t.weight);
    const words = q.split(' ');
    if (words.length === 1) return whole;
    // several words: each has to land somewhere
    let sum = 0;
    for (const w of words) {
        let best = 0;
        for (const t of terms) best = Math.max(best, scoreWord(w, t.text) * t.weight);
        if (!best) return whole;
        sum += best;
    }
    return Math.max(whole, sum / words.length);
}

/** The items that match, best first (ties keep their order), at most `limit`. */
export function fuzzySearch<T>(query: string, items: T[], termsOf: (item: T) => FuzzyTerm[], limit = 100, min = 1): T[] {
    if (!normalizeTerm(query)) return items.slice(0, limit);
    const scored: Array<[T, number, number]> = [];
    items.forEach((item, i) => {
        const s = fuzzyScore(query, termsOf(item));
        if (s >= min) scored.push([item, s, i]);
    });
    scored.sort((a, b) => b[1] - a[1] || a[2] - b[2]);
    return scored.slice(0, limit).map(s => s[0]);
}
