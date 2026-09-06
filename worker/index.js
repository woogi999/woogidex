// ==================== Supabase reverse proxy ====================
// Forwards everything under /sb/* to the Supabase project unchanged, so our
// WAF/bot/rate-limit rules -- which only ever saw static asset traffic when
// the browser talked to Supabase directly -- now cover API calls too. Also
// collapses the site onto one origin, removing cross-origin CORS preflights.
//
// Invariants:
//   * Real client IP must survive the hop -- Cloudflare rewrites
//     X-Forwarded-For/CF-Connecting-IP on the way into *.supabase.co too, so
//     without the signed header below every sign-in got recorded (and rate
//     limited) as one shared address. See supabase/functions/_shared/client-ip.ts.
//   * Nothing may be cached -- these are per-user authenticated responses on
//     a shared URL space.
//   * Redirects must not be followed -- OAuth 302s belong to the browser.
//   * Only /sb/* should reach this Worker; `run_worker_first` in
//     wrangler.jsonc keeps ordinary page loads off it.

const SUPABASE_ORIGIN = 'https://qstbascfeolkyxtrqqwv.supabase.co';
const PREFIX = '/sb';

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) {
            // shouldn't happen with run_worker_first, but fail safe
            return env.ASSETS.fetch(request);
        }

        const target = new URL(SUPABASE_ORIGIN);
        target.pathname = url.pathname.slice(PREFIX.length) || '/';
        target.search = url.search;

        const headers = new Headers(request.headers);
        const ip = request.headers.get('cf-connecting-ip');
        if (ip) {
            // rewritten by Cloudflare before Supabase sees them, but set anyway
            // since other things in the chain read them and it costs nothing
            headers.set('x-forwarded-for', ip);
            headers.set('x-real-ip', ip);
            // this one survives; only trusted upstream when signed
            if (env.PROXY_SHARED_SECRET) {
                headers.set('x-woogi-client-ip', ip);
                headers.set('x-woogi-proxy-key', env.PROXY_SHARED_SECRET);
            }
        }
        // a client must not be able to smuggle these headers past us
        if (!ip || !env.PROXY_SHARED_SECRET) {
            headers.delete('x-woogi-client-ip');
            headers.delete('x-woogi-proxy-key');
        }
        headers.delete('cookie');
        headers.set('x-forwarded-host', url.host);
        headers.set('x-forwarded-proto', 'https');

        const upstream = new Request(target, {
            method: request.method,
            headers,
            body: request.body,
            redirect: 'manual'
        });

        const response = await fetch(upstream, {
            cf: { cacheTtl: 0, cacheEverything: false }
        });

        // no WebSocket expected here (battles use WebRTC + REST handshake); if
        // Realtime is ever adopted, return `response` untouched for status 101
        // instead -- rebuilding it below would drop the socket
        //
        // headers are immutable as returned; clone to force uncacheable
        const out = new Response(response.body, response);
        out.headers.set('cache-control', 'no-store');
        return out;
    }
};
