// Reads a plain JavaScript object literal ({name:"Thunderbolt",num:85,...})
// without running it. Showdown ships some datasets as .js files rather than
// JSON (unquoted keys), and those come from another site, so they're parsed
// as data here, never eval'd. Only data is understood: objects, arrays,
// strings, numbers, true/false/null/undefined. Anything else throws.

export function parseJsLiteral(src: string, start = 0): { value: any; end: number } {
    let i = start;
    const n = src.length;

    const fail = (what: string): never => { throw new SyntaxError(`${what} at ${i}`); };
    const skip = () => {
        while (i < n) {
            const c = src.charCodeAt(i);
            if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
            if (c === 47 && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
            if (c === 47 && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
            break;
        }
    };

    function str(): string {
        const q = src[i++];
        let out = '';
        while (i < n) {
            const c = src[i++];
            if (c === q) return out;
            if (c !== '\\') { out += c; continue; }
            const e = src[i++];
            switch (e) {
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'v': out += '\v'; break;
                case '0': out += '\0'; break;
                case 'x': out += String.fromCharCode(parseInt(src.slice(i, i + 2), 16)); i += 2; break;
                case 'u':
                    if (src[i] === '{') { const e2 = src.indexOf('}', i); out += String.fromCodePoint(parseInt(src.slice(i + 1, e2), 16)); i = e2 + 1; }
                    else { out += String.fromCharCode(parseInt(src.slice(i, i + 4), 16)); i += 4; }
                    break;
                case '\r': if (src[i] === '\n') i++; break;
                case '\n': break;
                default: out += e;
            }
        }
        return fail('Unterminated string');
    }

    function word(): string {
        const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 64));
        if (!m) fail('Unexpected character');
        i += m![0].length;
        return m![0];
    }

    function value(): any {
        skip();
        const c = src[i];
        if (c === '{') {
            i++;
            const obj: Record<string, any> = {};
            for (;;) {
                skip();
                if (src[i] === '}') { i++; return obj; }
                let key: string;
                if (src[i] === '"' || src[i] === "'") key = str();
                else if (/[0-9]/.test(src[i])) { const m = /^[0-9.]+/.exec(src.slice(i, i + 32))!; key = m[0]; i += key.length; }
                else key = word();
                skip();
                if (src[i++] !== ':') fail('Expected :');
                // never let a key named __proto__ reach the prototype
                const v = value();
                if (key === '__proto__') Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
                else obj[key] = v;
                skip();
                if (src[i] === ',') { i++; continue; }
                if (src[i] === '}') { i++; return obj; }
                fail('Expected , or }');
            }
        }
        if (c === '[') {
            i++;
            const arr: any[] = [];
            for (;;) {
                skip();
                if (src[i] === ']') { i++; return arr; }
                arr.push(value());
                skip();
                if (src[i] === ',') { i++; continue; }
                if (src[i] === ']') { i++; return arr; }
                fail('Expected , or ]');
            }
        }
        if (c === '"' || c === "'") return str();
        if (c === '-' || c === '+' || c === '.' || /[0-9]/.test(c)) {
            const m = /^[-+]?(0x[0-9a-f]+|(\d+\.?\d*|\.\d+)(e[-+]?\d+)?)/i.exec(src.slice(i, i + 64));
            if (!m) fail('Bad number');
            i += m![0].length;
            return Number(m![0]);
        }
        const w = word();
        if (w === 'true') return true;
        if (w === 'false') return false;
        if (w === 'null') return null;
        if (w === 'undefined') return undefined;
        if (w === 'Infinity') return Infinity;
        if (w === 'NaN') return NaN;
        return fail(`Unexpected ${w}`);
    }

    const v = value();
    return { value: v, end: i };
}
