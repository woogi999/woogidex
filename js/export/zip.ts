// A small ZIP writer for the exports (Showdown mods, Essentials PBS files,
// plain-text collections). Replaces JSZip, a ~95 KB library of which the
// exports used three calls: add a file, add a folder, make a Blob.
//
// Text files only, compressed with the browser's own deflate
// (CompressionStream) where it has one, stored as-is where it doesn't. The
// format is the classic one every unzip tool reads: a local header before
// each file, then a central directory, then its end record.

const enc = new TextEncoder();

// CRC-32 (the one ZIP uses), table built on first use
let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
    if (typeof CompressionStream === 'undefined') return null;
    try {
        const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
        return null;      // a browser without deflate-raw: store instead
    }
}

/** MS-DOS date and time, which is what ZIP stores. */
function dosDateTime(d = new Date()) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
}

export class Zip {
    private files: Array<{ name: string; data: Uint8Array }> = [];

    /** Adds (or replaces) a text file. Paths use "/" for folders. */
    file(name: string, content: string): this {
        const data = enc.encode(String(content));
        this.files = this.files.filter(f => f.name !== name);
        this.files.push({ name, data });
        return this;
    }

    /** A view that puts files under `name/`. */
    folder(name: string) {
        const prefix = name.replace(/\/+$/, '') + '/';
        return { file: (child: string, content: string) => { this.file(prefix + child, content); return this; } };
    }

    async blob(): Promise<Blob> {
        const parts: BlobPart[] = [];
        const central: BlobPart[] = [];
        const { time, date } = dosDateTime();
        let offset = 0;
        for (const f of this.files) {
            const name = enc.encode(f.name);
            const crc = crc32(f.data);
            const packed = await deflate(f.data);
            const useDeflate = !!packed && packed.length < f.data.length;
            const body = useDeflate ? packed! : f.data;
            const method = useDeflate ? 8 : 0;

            const local = new DataView(new ArrayBuffer(30));
            local.setUint32(0, 0x04034b50, true);       // local file header
            local.setUint16(4, 20, true);               // version needed
            local.setUint16(6, 0x0800, true);           // names are UTF-8
            local.setUint16(8, method, true);
            local.setUint16(10, time, true);
            local.setUint16(12, date, true);
            local.setUint32(14, crc, true);
            local.setUint32(18, body.length, true);
            local.setUint32(22, f.data.length, true);
            local.setUint16(26, name.length, true);
            local.setUint16(28, 0, true);
            parts.push(local.buffer, name as BlobPart, body as BlobPart);

            const entry = new DataView(new ArrayBuffer(46));
            entry.setUint32(0, 0x02014b50, true);       // central directory entry
            entry.setUint16(4, 20, true);               // made by
            entry.setUint16(6, 20, true);               // version needed
            entry.setUint16(8, 0x0800, true);
            entry.setUint16(10, method, true);
            entry.setUint16(12, time, true);
            entry.setUint16(14, date, true);
            entry.setUint32(16, crc, true);
            entry.setUint32(20, body.length, true);
            entry.setUint32(24, f.data.length, true);
            entry.setUint16(28, name.length, true);
            entry.setUint32(42, offset, true);          // where its local header is
            central.push(entry.buffer, name as BlobPart);

            offset += 30 + name.length + body.length;
        }
        const centralSize = central.reduce((n, p) => n + ((p as ArrayBuffer).byteLength ?? (p as Uint8Array).length), 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);             // end of central directory
        end.setUint16(8, this.files.length, true);
        end.setUint16(10, this.files.length, true);
        end.setUint32(12, centralSize, true);
        end.setUint32(16, offset, true);
        return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
    }

    /** JSZip's spelling, so the export code reads the same as before. */
    generateAsync(_options?: { type: 'blob' }): Promise<Blob> {
        return this.blob();
    }
}
