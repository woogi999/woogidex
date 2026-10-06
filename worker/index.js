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
// 2. /community/<id>, /post/<id>, /profile/<name>, /events/<id or link>, and the top-level pages --
//    link previews. Discord, iMessage, X and friends fetch a pasted link
//    without running any JavaScript, so the single-page app always looked
//    like the home page to them. Here the page's own HTML is served with its
//    title, description and picture filled in for whatever the link points
//    at. Ordinary visitors get the same HTML; the app ignores these tags.
//
//    The same HTML carries what search engines read: a canonical address,
//    robots rules (pages yes, artwork no, unless its author made a Fakemon
//    open), structured data (schema.org), and a real 404 status for a
//    Fakemon, post, profile or event that isn't there. /sitemap.xml lists
//    every page worth a result.
//
// 3. /sheets/<token>.csv -- an event's responses as CSV, for the team's
//    Google Sheet (=IMPORTDATA). The token is the key; the database decides
//    what it shows (event_sheet_data).

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
        if (url.pathname.startsWith('/og-event/')) return ogEventImage(url);
        if (url.pathname.startsWith('/sheets/')) return eventSheet(url);
        if (url.pathname === '/sitemap.xml') return sitemap(url);
        if (url.pathname === '/turn-credentials') return turnCredentials(request, env);
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

// ==================== link previews and search engines ====================
// what event_phase() says, as an event's page shows it
const EVENT_STAGES = { upcoming: 'Opening soon', open: 'Taking entries', closed: 'Entries closed', voting: 'Voting open', tallying: 'Results soon', ended: 'Ended' };

// What search engines may do. Everything may be indexed and followed; the
// artwork may not (noimageindex, and no image thumbnails in results), except
// on a Fakemon its author made open. AI training crawlers are refused here
// and, in full, in public/robots.txt.
const ROBOTS = 'index, follow, max-snippet:-1, max-image-preview:none, noimageindex, noai, noimageai';
const ROBOTS_OPEN = 'index, follow, max-snippet:-1, max-image-preview:large, noai';
// signed-in-only pages: fine to follow their links, not worth a search result
const ROBOTS_PRIVATE = 'noindex, follow, noai, noimageai';

const STATIC_PAGES = {
    '': { title: SITE_NAME, description: 'Woogidex is a free fan-made Fakémon creator: design your own Pokémon with stats, moves, abilities, evolutions and art, publish them to the Community Hub, enter design contests, and battle them in a 3D simulator.' },
    collection: { title: 'Fakémon Creator', description: 'Design your own Fakémon: base stats, types, abilities, learnsets, evolutions, Pokédex entries and artwork, with analysis and exports for Showdown and Essentials.' },
    community: { title: 'Community Hub', description: 'Browse Fakémon made by the Woogidex community: react, comment, follow your favourite creators and share your own designs.' },
    events: { title: 'Fakémon Contests and Events', description: 'Fakémon design contests from the Woogidex community: enter your designs, vote on others, and see the winners.' },
    battle: { title: 'Fakémon Battle Simulator', description: 'Battle your Fakémon against friends or a bot in a 3D simulator, with real Pokémon battle mechanics.' },
    updates: { title: 'Updates', description: 'What’s new on Woogidex: new features, fixes and improvements to the Fakémon creator.' },
    privacy: { title: 'Privacy Policy', description: 'How Woogidex handles your data.' },
    terms: { title: 'Terms of Service', description: 'The rules for using Woogidex.' },
    // signed-in pages: a title, but no place in search results
    messages: { title: 'Messages', description: 'Private, end-to-end encrypted chats on Woogidex.', robots: ROBOTS_PRIVATE }
};
// pages that only mean something to the person signed in (their settings,
// their own Fakemon in the editor, a search): never a search result
const PRIVATE_PREFIXES = ['messages', 'settings', 'search', 'editor', 'ability-editor'];

/** A call to the database: { ok, data }. ok is false when it couldn't be asked (so "not found" isn't mistaken for "down"). */
async function rpcCall(name, args, cacheTtl = 300) {
    try {
        const res = await fetch(`${SUPABASE_ORIGIN}/rest/v1/rpc/${name}`, {
            method: 'POST',
            headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' },
            body: JSON.stringify(args),
            cf: { cacheTtl, cacheEverything: true }
        });
        if (!res.ok) return { ok: false, data: null, status: res.status };
        return { ok: true, data: await res.json() };
    } catch {
        return { ok: false, data: null };
    }
}

async function rpc(name, args) {
    const r = await rpcCall(name, args);
    return r.ok ? r.data : null;
}

function clip(text, n = 200) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

const listOf = (items) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** A Fakemon's page, from seo_mon (or link_preview before that migration is in). */
async function monPreview(id, absolute) {
    let r = await rpcCall('seo_mon', { p_id: id });
    let mon = r.ok ? r.data : null;
    if (!r.ok && r.status === 404) {
        // seo_mon not there yet: the older, smaller preview
        const old = await rpcCall('link_preview', { p_kind: 'mon', p_key: id });
        if (!old.ok) return null;
        mon = old.data && { ...old.data, name: old.data.title, dex1: old.data.description, abilities: [], stats: null, is_open: false };
        r = old;
    }
    if (!r.ok) return null;                 // couldn't ask: the plain page, not a 404
    if (!mon) return { notFound: true };
    const types = (mon.types || []).filter(Boolean);
    const typeText = types.length ? `${types.join('/')}-type` : '';
    const stats = mon.stats && typeof mon.stats === 'object' ? mon.stats : null;
    const bst = stats ? ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].reduce((n, k) => n + (Number(stats[k]) || 0), 0) : 0;
    const abilities = (mon.abilities || []).filter(Boolean);
    const lead = `${mon.name} is a ${typeText ? `${typeText} ` : ''}Fakémon${mon.species ? `, the ${mon.species},` : ''} by ${mon.author}.`;
    const extra = [abilities.length && `Abilities: ${listOf(abilities.slice(0, 3))}.`, bst && `Base stat total ${bst}.`, mon.family > 1 && `${mon.family} evolution stages and forms.`].filter(Boolean).join(' ');
    const description = clip(`${lead} ${mon.dex1 || ''} ${extra}`, 240);
    const canonical = absolute(`/community/${String(mon.id || id).toLowerCase()}`);
    const image = mon.has_image ? absolute(`/og-image/${encodeURIComponent(id)}`) : absolute(DEFAULT_IMAGE);
    const ld = [{
        '@context': 'https://schema.org',
        '@type': 'CreativeWork',
        name: mon.name,
        alternateName: mon.species ? `The ${mon.species}` : undefined,
        description: clip(`${mon.dex1 || ''} ${mon.dex2 || ''}`, 500) || description,
        genre: 'Fakémon',
        keywords: [...types, 'Fakémon', 'Fakemon', 'fan-made Pokémon'].join(', '),
        author: { '@type': 'Person', name: mon.author, url: mon.username ? absolute(`/profile/${encodeURIComponent(mon.username)}`) : undefined },
        datePublished: mon.published_at || undefined,
        dateModified: mon.updated_at || undefined,
        url: canonical,
        // the artwork only when its author made it open
        image: mon.is_open && mon.has_image ? image : undefined,
        isAccessibleForFree: true,
        isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: absolute('/') }
    }, breadcrumbs(absolute, [['Community Hub', '/community'], [mon.name, `/community/${id}`]])];
    return {
        title: `${mon.name}${typeText ? ` (${types.join('/')} Fakémon)` : ' (Fakémon)'} by ${mon.author}`,
        description,
        image,
        card: mon.has_image ? 'summary_large_image' : 'summary',
        type: 'article',
        canonical,
        robots: mon.is_open ? ROBOTS_OPEN : ROBOTS,
        ld
    };
}

function breadcrumbs(absolute, trail) {
    return {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [['Woogidex', '/'], ...trail].map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: absolute(path) }))
    };
}

/** What a page should say in a pasted link and a search result, or { notFound } for one that isn't there. */
async function previewFor(url) {
    const [first = '', second = ''] = url.pathname.replace(/^\/+|\/+$/g, '').split('/').map(decodeURIComponent);
    const absolute = path => new URL(path, url.origin).toString();

    if (first === 'community' && second) {
        if (!/^[0-9a-f-]{36}$/i.test(second)) return { notFound: true };
        return monPreview(second, absolute);
    }
    if (first === 'post' && second) {
        const r = await rpcCall('link_preview', { p_kind: 'post', p_key: second });
        if (!r.ok) return null;
        const post = r.data;
        if (!post) return { notFound: true };
        const mons = (post.mons || []).filter(Boolean);
        const tail = mons.length ? ` Featuring ${mons.slice(0, 4).join(', ')}${mons.length > 4 ? ` and ${mons.length - 4} more` : ''}.` : '';
        return {
            title: post.title,
            description: clip(`${post.description || ''}${tail}`) || 'A post on the Woogidex Community Hub.',
            image: post.first_mon ? absolute(`/og-image/${encodeURIComponent(post.first_mon)}`) : absolute(DEFAULT_IMAGE),
            card: post.first_mon ? 'summary_large_image' : 'summary',
            type: 'article',
            canonical: absolute(`/post/${second.toLowerCase()}`),
            // a post reads only signed in: shared links preview, search results don't
            robots: ROBOTS_PRIVATE
        };
    }
    if (first === 'profile' && second) {
        const r = await rpcCall('link_preview', { p_kind: 'profile', p_key: second });
        if (!r.ok) return null;
        const p = r.data;
        if (!p) return { notFound: true };
        const counts = `${p.mons} Fakémon · ${p.followers} follower${p.followers === 1 ? '' : 's'}`;
        const canonical = absolute(`/profile/${encodeURIComponent(p.username)}`);
        return {
            title: `${p.title} (@${p.username}) · Fakémon creator`,
            description: clip(p.description ? `${p.description} · ${counts} on Woogidex.` : `${p.title} makes Fakémon on Woogidex: ${counts}.`),
            image: p.avatar_url || absolute(DEFAULT_IMAGE),
            card: 'summary',
            type: 'profile',
            canonical,
            // a profile reads only signed in, so a search engine would see an
            // empty page: previews yes, results no (its links are still followed,
            // which is how its Fakemon get found)
            robots: ROBOTS_PRIVATE,
            ld: [{
                '@context': 'https://schema.org', '@type': 'ProfilePage', url: canonical,
                mainEntity: { '@type': 'Person', name: p.title, alternateName: `@${p.username}`, description: p.description || undefined, url: canonical }
            }]
        };
    }
    if (first === 'events' && second && second !== 'new') {
        const r = await rpcCall('link_preview_event', { p_key: second });
        if (!r.ok) return null;
        const ev = r.data;
        if (!ev) return { notFound: true };
        const stage = EVENT_STAGES[ev.stage] || '';
        const lead = [ev.category, stage].filter(Boolean).join(' · ');
        const canonical = absolute(`/events/${encodeURIComponent(ev.slug || ev.id)}`);
        const description = clip([lead && `${lead}.`, ev.tagline, ev.description].filter(Boolean).join(' ')) || `A Fakémon event by ${ev.organizer} on Woogidex.`;
        return {
            title: `${ev.title}${ev.category ? ` · ${ev.category}` : ''}`,
            description,
            image: ev.has_cover ? absolute(`/og-event/${ev.id}`) : absolute(DEFAULT_IMAGE),
            card: ev.has_cover ? 'summary_large_image' : 'summary',
            type: 'website',
            canonical,
            robots: ROBOTS,
            ld: [ev.starts_at ? {
                '@context': 'https://schema.org', '@type': 'Event', name: ev.title, description,
                startDate: ev.starts_at, endDate: ev.ends_at || undefined,
                eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
                eventStatus: 'https://schema.org/EventScheduled',
                location: { '@type': 'VirtualLocation', url: canonical },
                organizer: { '@type': 'Person', name: ev.organizer },
                isAccessibleForFree: true, url: canonical
            } : null, breadcrumbs(absolute, [['Events', '/events'], [ev.title, `/events/${ev.slug || ev.id}`]])].filter(Boolean)
        };
    }
    if (PRIVATE_PREFIXES.includes(first) || (first === 'collection' && second)) {
        // someone's own editor, settings or search: a plain page that asks not to be listed
        return { title: SITE_NAME, description: STATIC_PAGES[''].description, image: absolute(DEFAULT_IMAGE), card: 'summary', type: 'website', bare: true, canonical: absolute(`/${first}`), robots: ROBOTS_PRIVATE };
    }
    const page = STATIC_PAGES[first];
    if (!page || second) return null;
    const canonical = absolute(first ? `/${first}` : '/');
    return {
        title: page.title === SITE_NAME ? `${SITE_NAME}: free Fakémon creator and community` : page.title,
        description: page.description, image: absolute(DEFAULT_IMAGE), card: 'summary', type: 'website', bare: page.title === SITE_NAME,
        canonical, robots: page.robots || ROBOTS,
        ld: first ? [breadcrumbs(absolute, [[page.title, `/${first}`]])] : [{
            '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: canonical,
            description: page.description, inLanguage: 'en'
        }, {
            '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: SITE_NAME, url: canonical,
            applicationCategory: 'DesignApplication', operatingSystem: 'Web', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            description: page.description
        }]
    };
}

const NOT_FOUND_META = { title: 'Page not found', description: 'This page doesn’t exist on Woogidex, or it was removed.', card: 'summary', type: 'website', robots: 'noindex, nofollow' };

/** JSON for a <script> tag: nothing in it can close the tag. */
const ldJson = (data) => JSON.stringify(data, (k, v) => v === undefined ? undefined : v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

async function withLinkPreview(request, env, url) {
    // only pages; anything with a file extension is an asset
    if (/\.[a-z0-9]{2,5}$/i.test(url.pathname)) return null;
    // one address per page: /community/abc/ is /community/abc
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
        const to = new URL(url);
        to.pathname = url.pathname.replace(/\/+$/, '');
        return Response.redirect(to.toString(), 301);
    }
    const found = await previewFor(url);
    if (!found) return null;
    const notFound = !!found.notFound;
    const meta = notFound ? { ...NOT_FOUND_META, image: new URL(DEFAULT_IMAGE, url.origin).toString() } : found;
    const page = await env.ASSETS.fetch(new Request(new URL('/', url.origin), request));
    if (!page.ok || !(page.headers.get('content-type') || '').includes('text/html')) return null;
    const title = meta.bare ? meta.title : (meta.title.endsWith(SITE_NAME) ? meta.title : `${meta.title} · ${SITE_NAME}`);
    const set = (attrName, value) => ({ element(el) { el.setAttribute(attrName, value); } });
    const canonical = meta.canonical || (url.origin + url.pathname);
    let head = notFound ? '' : `<link rel="canonical" href="${attr(canonical)}">`;
    for (const block of meta.ld || []) head += `<script type="application/ld+json">${ldJson(block)}</script>`;
    const out = new HTMLRewriter()
        .on('title', { element(el) { el.setInnerContent(title); } })
        .on('meta[name="description"]', set('content', meta.description))
        .on('meta[name="robots"]', set('content', meta.robots || ROBOTS))
        .on('meta[property="og:title"]', set('content', meta.title))
        .on('meta[property="og:description"]', set('content', meta.description))
        .on('meta[property="og:image"]', set('content', meta.image))
        .on('meta[property="og:url"]', set('content', canonical))
        .on('meta[property="og:type"]', set('content', meta.type))
        .on('meta[name="twitter:card"]', set('content', meta.card))
        .on('meta[name="twitter:title"]', set('content', meta.title))
        .on('meta[name="twitter:description"]', set('content', meta.description))
        .on('meta[name="twitter:image"]', set('content', meta.image))
        .on('head', { element(el) { if (head) el.append(head, { html: true }); } })
        .transform(page);
    // a Fakemon, post, profile or event that isn't there is a real 404 (the
    // app still loads and says so), not a page that says "not found" with a
    // 200, which search engines report as a soft 404
    const res = new Response(out.body, { status: notFound ? 404 : 200, headers: out.headers });
    // the rewrite changes the page's length, so the original's size and tag
    // would cut the HTML short: the browser would stop before the <script>
    // at the bottom and the app would never start
    res.headers.delete('content-length');
    res.headers.delete('etag');
    // a renamed Fakemon should show its new name soon, but crawlers hammer links
    res.headers.set('cache-control', notFound ? 'public, max-age=60' : 'public, max-age=300');
    if (meta.robots && meta.robots.startsWith('noindex')) res.headers.set('x-robots-tag', meta.robots);
    // built here, so public/_headers may not reach it: the same protections by hand
    // (no framing = no clickjacking; nosniff; no full URLs leaking to other sites)
    res.headers.set('x-frame-options', 'DENY');
    res.headers.set('content-security-policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    res.headers.set('x-content-type-options', 'nosniff');
    res.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    res.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
    return res;
}

// ==================== the sitemap ====================
// Every page worth a search result: the main pages, every published Fakemon,
// and the live events. Addresses and dates only (sitemap_entries). Never a
// page marked noindex (profiles, posts): search engines report those as
// errors. Rebuilt at most once an hour.
async function sitemap(url) {
    const absolute = path => new URL(path, url.origin).toString();
    const r = await rpcCall('sitemap_entries', {}, 3600);
    const rows = r.ok && Array.isArray(r.data) ? r.data : [];
    const day = (d) => d ? String(d).slice(0, 10) : '';
    const entries = [
        ['/', 'daily', '1.0', ''], ['/community', 'hourly', '0.9', ''], ['/events', 'daily', '0.8', ''],
        ['/collection', 'weekly', '0.8', ''], ['/battle', 'monthly', '0.5', ''], ['/updates', 'weekly', '0.4', ''],
        ['/privacy', 'yearly', '0.1', ''], ['/terms', 'yearly', '0.1', '']
    ];
    for (const row of rows) {
        if (row.kind === 'mon') entries.push([`/community/${row.key}`, 'weekly', '0.7', day(row.updated_at)]);
        else if (row.kind === 'event') entries.push([`/events/${encodeURIComponent(row.key)}`, 'daily', '0.6', day(row.updated_at)]);
    }
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + entries.map(([path, freq, prio, mod]) => `  <url><loc>${attr(absolute(path))}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ''}<changefreq>${freq}</changefreq><priority>${prio}</priority></url>`).join('\n')
        + '\n</urlset>\n';
    return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}

// The card picture: the small (~160px) thumbnail every published Fakemon
// already has for the hub's cards. Never the full artwork.
async function ogImage(url) {
    const id = decodeURIComponent(url.pathname.slice('/og-image/'.length));
    if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
    const [thumb, seo] = await Promise.all([rpc('link_preview_thumb', { p_id: id }), rpc('seo_mon', { p_id: id })]);
    const m = /^data:(image\/(?:webp|png|jpeg|gif));base64,(.+)$/.exec(String(thumb || ''));
    if (!m) return Response.redirect(new URL(DEFAULT_IMAGE, url.origin).toString(), 302);
    const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
    const headers = { 'content-type': m[1], 'cache-control': 'public, max-age=3600' };
    // for link previews (Discord and friends), not for image search: someone's
    // artwork stays out of it unless they made the Fakemon open
    if (!seo?.is_open) headers['x-robots-tag'] = 'noindex, noimageindex, noai, noimageai';
    return new Response(bytes, { headers });
}

// An event's cover, for its link preview. Drafts have none (the function checks).
async function ogEventImage(url) {
    const id = decodeURIComponent(url.pathname.slice('/og-event/'.length));
    if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
    const cover = await rpc('link_preview_event_cover', { p_id: id });
    const m = /^data:(image\/(?:webp|png|jpeg|gif));base64,(.+)$/.exec(String(cover || ''));
    if (!m) return Response.redirect(new URL(DEFAULT_IMAGE, url.origin).toString(), 302);
    const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
    // a cover is often someone's drawing too: previews yes, image search no
    return new Response(bytes, { headers: { 'content-type': m[1], 'cache-control': 'public, max-age=3600', 'x-robots-tag': 'noindex, noimageindex, noai, noimageai' } });
}

// ==================== an event's responses, for Google Sheets ====================
// Never cached by Cloudflare: a new response should show up on the next pull,
// and a retired link must stop working at once.
async function eventSheet(url) {
    const token = decodeURIComponent(url.pathname.slice('/sheets/'.length)).replace(/\.csv$/, '');
    const notFound = () => new Response('This sheet link is not valid. Ask the event\'s team for a new one.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    if (!/^[0-9a-f]{64}$/.test(token)) return notFound();
    const res = await fetch(`${SUPABASE_ORIGIN}/rest/v1/rpc/event_sheet_data`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ p_token: token }),
        cf: { cacheTtl: 0, cacheEverything: false }
    });
    const data = res.ok ? await res.json().catch(() => null) : null;
    if (!data) return notFound();
    // =, +, -, @ would run as a formula in the sheet (same rule as exportEntriesCsv)
    const cell = v => {
        const s = v == null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? (v.name || '') : String(v);
        return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
    };
    const questions = data.questions || [];
    let rows;
    if (data.kind === 'votes') {
        // the event's scoring criteria (criteriaOf in js/features/events.ts), or
        // when it has none set, whatever was scored, in the order first seen
        const votes = data.votes || [];
        let criteria = (data.criteria || []).map(c => typeof c === 'string' ? { name: c, max: 10 } : { name: c?.name || '', max: Number(c?.max) || 10 }).filter(c => c.name);
        if (!criteria.length) {
            const seen = [];
            for (const v of votes) for (const k of Object.keys(v.scores || {})) if (!seen.includes(k)) seen.push(k);
            criteria = seen.map(name => ({ name, max: 10 }));
        }
        rows = [
            ['When', 'Voter', 'Entry', 'Entrant', 'Total', ...criteria.map(c => `${c.name} (of ${c.max})`), ...questions.map(q => q.label), 'Remarks'],
            ...votes.map(v => [v.created_at, v.voter, v.entry, v.entrant, v.total, ...criteria.map(c => v.scores?.[c.name] ?? ''), ...questions.map(q => v.answers?.[q.id]), v.remarks])
        ];
    } else {
        rows = [
            ['Submitted', 'Entrant', 'Placement', ...questions.map(q => q.label)],
            ...(data.entries || []).map(en => [en.created_at, en.entrant, en.placement ?? '', ...questions.map(q => en.answers?.[q.id])])
        ];
    }
    return new Response(rows.map(r => r.map(cell).join(',')).join('\r\n'), {
        headers: {
            'content-type': 'text/csv; charset=utf-8',
            'cache-control': 'no-store',
            'x-robots-tag': 'noindex, nofollow',
            'referrer-policy': 'no-referrer'
        }
    });
}

// ==================== TURN relay credentials ====================
// Short-lived Cloudflare TURN credentials for a battle, minted with the
// TURN_KEY_ID / TURN_API_TOKEN worker secrets (wrangler secret put; never in
// this repo, never sent to the browser). Signed-in players only, and only a
// few a minute each (TURN_LIMITER in wrangler.jsonc).
const TURN_TTL_SECONDS = 4 * 3600;

async function turnCredentials(request, env) {
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
        status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
    if (request.method !== 'POST') return json({ iceServers: [] }, 405);
    if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return json({ iceServers: [], warning: 'TURN secrets not set' }, 503);

    // who is asking: Supabase checks the token, so a forged one gets nothing
    const auth = request.headers.get('authorization') || '';
    if (!/^Bearer \S+$/.test(auth)) return json({ iceServers: [] }, 401);
    const who = await fetch(`${SUPABASE_ORIGIN}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, authorization: auth } });
    const user = who.ok ? await who.json().catch(() => null) : null;
    if (!user?.id) return json({ iceServers: [] }, 401);
    if (env.TURN_LIMITER && !(await env.TURN_LIMITER.limit({ key: user.id })).success) {
        return json({ iceServers: [], warning: 'Too many relay requests; try again in a minute.' }, 429);
    }

    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.TURN_API_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS })
    });
    if (!res.ok) return json({ iceServers: [], warning: `TURN service answered ${res.status}` }, 502);
    const data = await res.json();
    // port 53 is blocked by browsers and only adds a timeout (Cloudflare's own advice)
    const iceServers = (data.iceServers || []).map(s => ({
        ...s, urls: [].concat(s.urls || []).filter(u => !/:53(\?|$)/.test(u))
    })).filter(s => s.urls.length);
    return json({ iceServers });
}
