import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

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

const SB_PROXY = {
    target: 'https://qstbascfeolkyxtrqqwv.supabase.co',
    changeOrigin: true,
    rewrite: path => path.replace(/^\/sb/, '')
};

export default defineConfig({
    base: './',
    publicDir: 'public',
    plugins: [react(), fallback404()],
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
                    if (id.includes('node_modules/lucide')) return 'lucide';
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
