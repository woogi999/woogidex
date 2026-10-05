import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';

// static site on GitHub Pages, so this has to survive being served from a
// subdirectory *and* from paths that don't exist on disk (/community/12).
//
//   base: './'   emitted URLs must be relative; index.html fixes up <base
//                href> at runtime, and an absolute '/' base would send a
//                deep link to the domain root instead.
//   assetsDir    renamed off default 'assets' since public/assets/ already
//                holds site images and both would land in dist/.
//   fallback404  GitHub Pages serves 404.html for unmatched paths, so it has
//                to be a copy of the *built* index.html (hashed bundle URLs),
//                not the source.

const NOTICE = `<!-- GENERATED FILE - DO NOT EDIT.
     A copy of the built index.html, written during 'npm run build'.
     GitHub Pages serves this for any path that is not a file on disk, which is
     how /community/12 and /profile/woogi reach the app with their URL intact. -->
`;

function fallback404() {
    return {
        name: 'woogidex-404-fallback',
        apply: 'build',
        enforce: 'post',
        // generateBundle, not closeBundle: under Rolldown the HTML is still
        // in-memory here, so emitting from it keeps the two byte-identical
        generateBundle(_options, bundle) {
            const html = bundle['index.html'];
            if (!html) throw new Error('fallback404: index.html was not emitted');
            this.emitFile({
                type: 'asset',
                fileName: '404.html',
                source: NOTICE + html.source
            });
        }
    };
}

// The service worker (sw/service-worker.js) needs the exact file list of this
// build to keep an offline copy, so it is written here rather than copied from
// public/. Precached: the page, every chunk the app can run offline, and the
// small pictures the collection draws. Left out (fetched and kept on first use
// instead, so a cheap phone doesn't download them up front): the admin panel,
// and Battle (its page, engine and 3D renderer), which only works online anyway.
const SW_SKIP = /^(admin|three\.module|battle-ui|BattlePage)-/;
const SW_PUBLIC = ['assets/favicon.png', 'assets/no_art_placeholder.png', 'assets/woogidex_logo.png'];

function serviceWorker() {
    return {
        name: 'woogidex-service-worker',
        apply: 'build',
        enforce: 'post',
        generateBundle(_options, bundle) {
            const publicDir = resolve(import.meta.dirname, 'public');
            const typeIcons = readdirSync(resolve(publicDir, 'assets/types')).map(f => `assets/types/${f}`);
            const chunks = Object.keys(bundle)
                .filter(f => /^bundle\/[^/]+\.(js|css)$/.test(f) && !SW_SKIP.test(f.slice('bundle/'.length)))
                .sort();
            const files = ['./', ...chunks, ...SW_PUBLIC, ...typeIcons];
            // changes whenever anything it caches does, which is what makes the
            // browser install the new worker and refresh the offline copy
            const hash = createHash('sha256');
            for (const f of chunks) hash.update(f);
            hash.update(String(bundle['index.html']?.source ?? ''));
            for (const f of [...SW_PUBLIC, ...typeIcons]) hash.update(readFileSync(resolve(publicDir, f)));
            const source = readFileSync(resolve(import.meta.dirname, 'sw/service-worker.js'), 'utf8')
                .replace('const VERSION = __VERSION__', `const VERSION = ${JSON.stringify(hash.digest('hex').slice(0, 12))}`)
                .replace('const PRECACHE = __PRECACHE__', `const PRECACHE = ${JSON.stringify(files)}`)
                // same rule as the HTML below: no source comments on the live site
                .replace(/^[ \t]*\/\/.*(?:\r?\n)?/gm, '');
            this.emitFile({ type: 'asset', fileName: 'sw.js', source });
        }
    };
}

// Comments are for whoever edits the source, not for anyone opening dev tools
// on the live site. JS and CSS lose theirs when they're minified; HTML (the
// pages, and the views in public/ that are copied as-is) and the small inline
// scripts in it are not minified, so this strips them from the built files.
function stripComments(html) {
    return html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/(<script(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/g,
            (_, open, body, close) => open + body.replace(/^[ \t]*\/\/.*(?:\r?\n)?/gm, '') + close)
        .replace(/\n[ \t]*(?:\r?\n[ \t]*)+\n/g, '\n\n');
}

function stripHtmlComments() {
    let outDir = 'dist';
    return {
        name: 'woogidex-strip-html-comments',
        apply: 'build',
        configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
        // after everything is written, so it covers 404.html and public/views too
        closeBundle() {
            const walk = dir => readdirSync(dir, { withFileTypes: true }).forEach(entry => {
                const full = resolve(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.html')) writeFileSync(full, stripComments(readFileSync(full, 'utf8')));
            });
            walk(outDir);
        }
    };
}

// The custom emojis are plain files in public/emojis (subfolders are picker
// categories). Their names come from the file names, so adding one is just
// dropping a file in: this module lists them at build time, and messages only
// ever store the ":name:" text. The browser fetches each picture once and
// caches it (public/_headers), which keeps them off our bandwidth bill.
// Names follow the same rule the files were renamed with: no leading id
// number, spaces and dashes become underscores, all lowercase.
const EMOJI_VIRTUAL = 'virtual:emoji-manifest';
const EMOJI_RESOLVED = '\0' + EMOJI_VIRTUAL;
const EMOJI_EXT = /\.(png|gif|webp|jpe?g|avif)$/i;

export function emojiName(fileName) {
    return fileName.replace(EMOJI_EXT, '')
        .replace(/^[0-9]+[-_ ]+/, '')
        .replace(/[\s-]+/g, '_')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '');
}

function scanEmojis(root) {
    const out = [];
    const seen = new Set();
    const walk = (dir, category) => {
        let entries = [];
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const full = resolve(dir, entry.name);
            if (entry.isDirectory()) { walk(full, entry.name); continue; }
            if (!EMOJI_EXT.test(entry.name)) continue;
            const name = emojiName(entry.name);
            if (!name || seen.has(name)) continue;     // first file wins a clash
            seen.add(name);
            const rel = full.slice(root.length + 1).replace(/\\/g, '/');
            out.push({ name, src: `emojis/${rel}`, category, animated: /\.gif$/i.test(entry.name) });
        }
    };
    walk(root, 'general');
    return out;
}

function emojiManifest() {
    const root = resolve(import.meta.dirname, 'public/emojis');
    return {
        name: 'woogidex-emoji-manifest',
        resolveId(id) { return id === EMOJI_VIRTUAL ? EMOJI_RESOLVED : null; },
        load(id) {
            if (id !== EMOJI_RESOLVED) return null;
            return `export default ${JSON.stringify(scanEmojis(root))};`;
        },
        // a file dropped in while `npm run dev` is running shows up on reload
        configureServer(server) {
            server.watcher.add(root);
            const refresh = file => {
                if (!resolve(file).startsWith(root)) return;
                const mod = server.moduleGraph.getModuleById(EMOJI_RESOLVED);
                if (mod) server.moduleGraph.invalidateModule(mod);
                server.ws.send({ type: 'full-reload' });
            };
            server.watcher.on('add', refresh);
            server.watcher.on('unlink', refresh);
        }
    };
}

const SB_PROXY = {
    target: 'https://qstbascfeolkyxtrqqwv.supabase.co',
    changeOrigin: true,
    // Realtime (live chat messages) is a WebSocket
    ws: true,
    rewrite: path => path.replace(/^\/sb/, '')
};

export default defineConfig({
    base: './',
    publicDir: 'public',
    plugins: [react(), emojiManifest(), fallback404(), serviceWorker(), stripHtmlComments()],
    build: {
        outDir: 'dist',
        assetsDir: 'bundle',
        emptyOutDir: true,
        rollupOptions: {
            input: {
                main: resolve(import.meta.dirname, 'index.html'),
                admin: resolve(import.meta.dirname, 'admin.html')
            },
            output: {
                // big, rarely-changing deps split out to stay cached across
                // releases instead of invalidating with every code change
                manualChunks(id) {
                    if (id.includes('node_modules/@supabase')) return 'supabase';
                }
            }
        }
    },
    // /sb is the same-origin Supabase proxy (worker/index.js); Cloudflare runs
    // it in production, vite stands in locally so USE_SAME_ORIGIN_PROXY doesn't
    // require deploying to test. `preview` matters too: the smoke test uses it.
    server: { port: 5173, proxy: { '/sb': SB_PROXY } },
    preview: { proxy: { '/sb': SB_PROXY } }
});
