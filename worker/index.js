// ==================== Supabase reverse proxy + link previews ====================
// Two jobs, each only for the paths wrangler.jsonc sends here
// (run_worker_first); every other page and file is served straight from the
// asset store without running this at all.
//
// 1. /sb/* -- forwards to the Supabase project unchanged, so our WAF/bot/
//    rate-limit rules -- which only ever saw static asset traffic when the
//    browser talked to Supabase directly -- now cover API calls too. Also
//    collapses the site onto one origin, removing cross-origin CORS preflights.
//
//    Invariants:
//      * Real client IP must survive the hop -- Cloudflare rewrites
//        X-Forwarded-For/CF-Connecting-IP on the way into *.supabase.co too, so
//        without the signed header below every sign-in got recorded (and rate
//        limited) as one shared address. See supabase/functions/_shared/client-ip.ts.
//      * Nothing may be cached -- these are per-user authenticated responses on
//        a shared URL space.
//      * Redirects must not be followed -- OAuth 302s belong to the browser.
//      * WebSocket upgrades (Realtime, which delivers chat messages live) are
//        handed back untouched: rebuilding a 101 response drops the socket.
//
// 2. /community/<id>, /post/<id>, /profile/<name>, and the top-level pages --
//    link previews. Discord, iMessage, X and friends fetch a pasted link
//    without running any JavaScript, so the single-page app always looked
//    like the home page to them. Here the page's own HTML is served with its
//    title, description and picture filled in for whatever the link points
//    at. Ordinary visitors get the same HTML; the app ignores these tags.

const SUPABASE_ORIGIN = 'https://qstbascfeolkyxtrqqwv.supabase.co';
// the publishable key, same one the site ships with (js/core/supabase.ts)
const SUPABASE_ANON_KEY = 'sb_publishable_B4jEJ--w0XFsgXDmQeJREA_xH1GRBsf';
const PREFIX = '/sb';
const SITE_NAME = 'Woogidex';
const DEFAULT_IMAGE = '/assets/woogidex_icon.png';
const DEFAULT_DESCRIPTION = 'A fan-made Fakemon creator. Design custom Fakemon, publish them to the Community Hub, and battle them out in a simulator.';

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === PREFIX || url.pathname.startsWith(PREFIX + '/')) return proxy(request, env, url);
        if (url.pathname.startsWith('/og-image/')) return ogImage(url);
        if (request.method === 'GET' || request.method === 'HEAD') {
            const preview = await withLinkPreview(request, env, url).catch(() => null);
            if (preview) return preview;
        }
        return env.ASSETS.fetch(request);
    }
};

// ==================== the Supabase proxy ====================
async function proxy(request, env, url) {
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

    // Realtime: pass the upgrade through and return Supabase's 101 as it is
    if ((request.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
        return fetch(new Request(target, { method: request.method, headers }));
    }

    const upstream = new Request(target, {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual'
    });

    const response = await fetch(upstream, {
        cf: { cacheTtl: 0, cacheEverything: false }
    });

    // headers are immutable as returned; clone to force uncacheable
    const out = new Response(response.body, response);
    out.headers.set('cache-control', 'no-store');
    return out;
}

// ==================== link previews ====================
const STATIC_PAGES = {
    '': { title: SITE_NAME, description: DEFAULT_DESCRIPTION },
    collection: { title: 'My Collection', description: 'Design your own Fakemon: stats, moves, abilities, evolutions, art and more.' },
    community: { title: 'Community Hub', description: 'Fakemon made by the Woogidex community. Browse, react, comment and share your own.' },
    events: { title: 'Events and contests', description: 'Fakemon design contests from the Woogidex community.' },
    battle: { title: 'Battle', description: 'Battle your Fakemon against friends or a bot in a 3D simulator.' },
    updates: { title: 'Updates', description: 'What’s new on Woogidex.' },
    messages: { title: 'Messages', description: 'Private, end-to-end encrypted chats on Woogidex.' },
    privacy: { title: 'Privacy Policy', description: 'How Woogidex handles your data.' },
    terms: { title: 'Terms of Service', description: 'The rules for using Woogidex.' }
};

async function rpc(name, args) {
    const res = await fetch(`${SUPABASE_ORIGIN}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(args),
        cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!res.ok) return null;
    return res.json();
}

function clip(text, n = 200) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

/** What a link to this path should look like when pasted somewhere. */
async function previewFor(url) {
    const [first = '', second = ''] = url.pathname.replace(/^\/+|\/+$/g, '').split('/').map(decodeURIComponent);
    const absolute = path => new URL(path, url.origin).toString();

    if (first === 'community' && second) {
        const mon = await rpc('link_preview', { p_kind: 'mon', p_key: second });
        if (!mon) return null;
        const types = (mon.types || []).join(' / ');
        const family = mon.family > 1 ? ` · ${mon.family} forms` : '';
        return {
            title: `${mon.title} by ${mon.author}`,
            description: clip([types && `${types} type${mon.types.length > 1 ? 's' : ''}${family}.`, mon.species && `The ${mon.species}.`, mon.description].filter(Boolean).join(' ')) || 'A Fakemon on the Woogidex Community Hub.',
            image: mon.has_image ? absolute(`/og-image/${encodeURIComponent(second)}`) : absolute(DEFAULT_IMAGE),
            card: mon.has_image ? 'summary_large_image' : 'summary',
            type: 'article'
        };
    }
    if (first === 'post' && second) {
        const post = await rpc('link_preview', { p_kind: 'post', p_key: second });
        if (!post) return null;
        const mons = (post.mons || []).filter(Boolean);
        const tail = mons.length ? ` Featuring ${mons.slice(0, 4).join(', ')}${mons.length > 4 ? ` and ${mons.length - 4} more` : ''}.` : '';
        return {
            title: post.title,
            description: clip(`${post.description || ''}${tail}`) || 'A post on the Woogidex Community Hub.',
            image: post.first_mon ? absolute(`/og-image/${encodeURIComponent(post.first_mon)}`) : absolute(DEFAULT_IMAGE),
            card: post.first_mon ? 'summary_large_image' : 'summary',
            type: 'article'
        };
    }
    if (first === 'profile' && second) {
        const p = await rpc('link_preview', { p_kind: 'profile', p_key: second });
        if (!p) return null;
        const counts = `${p.mons} Fakemon · ${p.followers} follower${p.followers === 1 ? '' : 's'}`;
        return {
            title: `${p.title} (@${p.username})`,
            description: clip(p.description ? `${p.description} · ${counts}` : `${counts} on Woogidex.`),
            image: p.avatar_url || absolute(DEFAULT_IMAGE),
            card: 'summary',
            type: 'profile'
        };
    }
    const page = STATIC_PAGES[first];
    if (!page || second) return null;
    return { title: page.title === SITE_NAME ? SITE_NAME : `${page.title} · ${SITE_NAME}`, description: page.description, image: absolute(DEFAULT_IMAGE), card: 'summary', type: 'website', bare: page.title === SITE_NAME };
}

async function withLinkPreview(request, env, url) {
    // only pages; anything with a file extension is an asset
    if (/\.[a-z0-9]{2,5}$/i.test(url.pathname)) return null;
    const meta = await previewFor(url);
    if (!meta) return null;
    const page = await env.ASSETS.fetch(new Request(new URL('/', url.origin), request));
    if (!page.ok || !(page.headers.get('content-type') || '').includes('text/html')) return null;
    const title = meta.bare ? meta.title : (meta.title.endsWith(SITE_NAME) ? meta.title : `${meta.title} · ${SITE_NAME}`);
    const set = (attr, value) => ({ element(el) { el.setAttribute(attr, value); } });
    const out = new HTMLRewriter()
        .on('title', { element(el) { el.setInnerContent(title); } })
        .on('meta[name="description"]', set('content', meta.description))
        .on('meta[property="og:title"]', set('content', meta.title))
        .on('meta[property="og:description"]', set('content', meta.description))
        .on('meta[property="og:image"]', set('content', meta.image))
        .on('meta[property="og:url"]', set('content', url.origin + url.pathname))
        .on('meta[property="og:type"]', set('content', meta.type))
        .on('meta[name="twitter:card"]', set('content', meta.card))
        .on('meta[name="twitter:title"]', set('content', meta.title))
        .on('meta[name="twitter:description"]', set('content', meta.description))
        .on('meta[name="twitter:image"]', set('content', meta.image))
        .transform(page);
    const res = new Response(out.body, out);
    // a renamed Fakemon should show its new name soon, but crawlers hammer links
    res.headers.set('cache-control', 'public, max-age=300');
    return res;
}

// The card picture: the small (~160px) thumbnail every published Fakemon
// already has for the hub's cards. Never the full artwork.
async function ogImage(url) {
    const id = decodeURIComponent(url.pathname.slice('/og-image/'.length));
    if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
    const thumb = await rpc('link_preview_thumb', { p_id: id });
    const m = /^data:(image\/(?:webp|png|jpeg|gif));base64,(.+)$/.exec(String(thumb || ''));
    if (!m) return Response.redirect(new URL(DEFAULT_IMAGE, url.origin).toString(), 302);
    const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
    return new Response(bytes, { headers: { 'content-type': m[1], 'cache-control': 'public, max-age=3600' } });
}
