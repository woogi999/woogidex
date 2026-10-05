var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/index.js
var SUPABASE_ORIGIN = "https://qstbascfeolkyxtrqqwv.supabase.co";
var SUPABASE_ANON_KEY = "sb_publishable_B4jEJ--w0XFsgXDmQeJREA_xH1GRBsf";
var PREFIX = "/sb";
var SITE_NAME = "Woogidex";
var DEFAULT_IMAGE = "/assets/woogidex_icon.png";
var DEFAULT_DESCRIPTION = "A fan-made Fakemon creator. Design custom Fakemon, publish them to the Community Hub, and battle them out in a simulator.";
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === PREFIX || url.pathname.startsWith(PREFIX + "/")) return proxy(request, env, url);
    if (url.pathname.startsWith("/og-image/")) return ogImage(url);
    if (url.pathname.startsWith("/og-event/")) return ogEventImage(url);
    if (url.pathname.startsWith("/sheets/")) return eventSheet(url);
    if (url.pathname === "/turn-credentials") return turnCredentials(request, env);
    if (request.method === "GET" || request.method === "HEAD") {
      const preview = await withLinkPreview(request, env, url).catch(() => null);
      if (preview) return preview;
    }
    return env.ASSETS.fetch(request);
  }
};
async function proxy(request, env, url) {
  const target = new URL(SUPABASE_ORIGIN);
  target.pathname = url.pathname.slice(PREFIX.length) || "/";
  target.search = url.search;
  const headers = new Headers(request.headers);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) {
    headers.set("x-forwarded-for", ip);
    headers.set("x-real-ip", ip);
    if (env.PROXY_SHARED_SECRET) {
      headers.set("x-woogi-client-ip", ip);
      headers.set("x-woogi-proxy-key", env.PROXY_SHARED_SECRET);
    }
  }
  if (!ip || !env.PROXY_SHARED_SECRET) {
    headers.delete("x-woogi-client-ip");
    headers.delete("x-woogi-proxy-key");
  }
  headers.delete("cookie");
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", "https");
  if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") {
    return fetch(new Request(target, { method: request.method, headers }));
  }
  const upstream = new Request(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual"
  });
  const response = await fetch(upstream, {
    cf: { cacheTtl: 0, cacheEverything: false }
  });
  const out = new Response(response.body, response);
  out.headers.set("cache-control", "no-store");
  return out;
}
__name(proxy, "proxy");
var EVENT_STAGES = { upcoming: "Opening soon", open: "Taking entries", closed: "Entries closed", voting: "Voting open", tallying: "Results soon", ended: "Ended" };
var STATIC_PAGES = {
  "": { title: SITE_NAME, description: DEFAULT_DESCRIPTION },
  collection: { title: "My Collection", description: "Design your own Fakemon: stats, moves, abilities, evolutions, art and more." },
  community: { title: "Community Hub", description: "Fakemon made by the Woogidex community. Browse, react, comment and share your own." },
  events: { title: "Events and contests", description: "Fakemon design contests from the Woogidex community." },
  battle: { title: "Battle", description: "Battle your Fakemon against friends or a bot in a 3D simulator." },
  updates: { title: "Updates", description: "What\u2019s new on Woogidex." },
  messages: { title: "Messages", description: "Private, end-to-end encrypted chats on Woogidex." },
  privacy: { title: "Privacy Policy", description: "How Woogidex handles your data." },
  terms: { title: "Terms of Service", description: "The rules for using Woogidex." }
};
async function rpc(name, args) {
  const res = await fetch(`${SUPABASE_ORIGIN}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(args),
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!res.ok) return null;
  return res.json();
}
__name(rpc, "rpc");
function clip(text, n = 200) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "\u2026" : s;
}
__name(clip, "clip");
async function previewFor(url) {
  const [first = "", second = ""] = url.pathname.replace(/^\/+|\/+$/g, "").split("/").map(decodeURIComponent);
  const absolute = /* @__PURE__ */ __name((path) => new URL(path, url.origin).toString(), "absolute");
  if (first === "community" && second) {
    const mon = await rpc("link_preview", { p_kind: "mon", p_key: second });
    if (!mon) return null;
    const types = (mon.types || []).join(" / ");
    const family = mon.family > 1 ? ` \xB7 ${mon.family} forms` : "";
    return {
      title: `${mon.title} by ${mon.author}`,
      description: clip([types && `${types} type${mon.types.length > 1 ? "s" : ""}${family}.`, mon.species && `The ${mon.species}.`, mon.description].filter(Boolean).join(" ")) || "A Fakemon on the Woogidex Community Hub.",
      image: mon.has_image ? absolute(`/og-image/${encodeURIComponent(second)}`) : absolute(DEFAULT_IMAGE),
      card: mon.has_image ? "summary_large_image" : "summary",
      type: "article"
    };
  }
  if (first === "post" && second) {
    const post = await rpc("link_preview", { p_kind: "post", p_key: second });
    if (!post) return null;
    const mons = (post.mons || []).filter(Boolean);
    const tail = mons.length ? ` Featuring ${mons.slice(0, 4).join(", ")}${mons.length > 4 ? ` and ${mons.length - 4} more` : ""}.` : "";
    return {
      title: post.title,
      description: clip(`${post.description || ""}${tail}`) || "A post on the Woogidex Community Hub.",
      image: post.first_mon ? absolute(`/og-image/${encodeURIComponent(post.first_mon)}`) : absolute(DEFAULT_IMAGE),
      card: post.first_mon ? "summary_large_image" : "summary",
      type: "article"
    };
  }
  if (first === "profile" && second) {
    const p = await rpc("link_preview", { p_kind: "profile", p_key: second });
    if (!p) return null;
    const counts = `${p.mons} Fakemon \xB7 ${p.followers} follower${p.followers === 1 ? "" : "s"}`;
    return {
      title: `${p.title} (@${p.username})`,
      description: clip(p.description ? `${p.description} \xB7 ${counts}` : `${counts} on Woogidex.`),
      image: p.avatar_url || absolute(DEFAULT_IMAGE),
      card: "summary",
      type: "profile"
    };
  }
  if (first === "events" && second && second !== "new") {
    const ev = await rpc("link_preview_event", { p_key: second });
    if (!ev) return null;
    const stage = EVENT_STAGES[ev.stage] || "";
    const lead = [ev.category, stage].filter(Boolean).join(" \xB7 ");
    return {
      title: ev.title,
      description: clip([lead && `${lead}.`, ev.tagline, ev.description].filter(Boolean).join(" ")) || `An event by ${ev.organizer} on Woogidex.`,
      image: ev.has_cover ? absolute(`/og-event/${ev.id}`) : absolute(DEFAULT_IMAGE),
      card: ev.has_cover ? "summary_large_image" : "summary",
      type: "website"
    };
  }
  const page = STATIC_PAGES[first];
  if (!page || second) return null;
  return { title: page.title === SITE_NAME ? SITE_NAME : `${page.title} \xB7 ${SITE_NAME}`, description: page.description, image: absolute(DEFAULT_IMAGE), card: "summary", type: "website", bare: page.title === SITE_NAME };
}
__name(previewFor, "previewFor");
async function withLinkPreview(request, env, url) {
  if (/\.[a-z0-9]{2,5}$/i.test(url.pathname)) return null;
  const meta = await previewFor(url);
  if (!meta) return null;
  const page = await env.ASSETS.fetch(new Request(new URL("/", url.origin), request));
  if (!page.ok || !(page.headers.get("content-type") || "").includes("text/html")) return null;
  const title = meta.bare ? meta.title : meta.title.endsWith(SITE_NAME) ? meta.title : `${meta.title} \xB7 ${SITE_NAME}`;
  const set = /* @__PURE__ */ __name((attr, value) => ({ element(el) {
    el.setAttribute(attr, value);
  } }), "set");
  const out = new HTMLRewriter().on("title", { element(el) {
    el.setInnerContent(title);
  } }).on('meta[name="description"]', set("content", meta.description)).on('meta[property="og:title"]', set("content", meta.title)).on('meta[property="og:description"]', set("content", meta.description)).on('meta[property="og:image"]', set("content", meta.image)).on('meta[property="og:url"]', set("content", url.origin + url.pathname)).on('meta[property="og:type"]', set("content", meta.type)).on('meta[name="twitter:card"]', set("content", meta.card)).on('meta[name="twitter:title"]', set("content", meta.title)).on('meta[name="twitter:description"]', set("content", meta.description)).on('meta[name="twitter:image"]', set("content", meta.image)).transform(page);
  const res = new Response(out.body, out);
  res.headers.delete("content-length");
  res.headers.delete("etag");
  res.headers.set("cache-control", "public, max-age=300");
  res.headers.set("x-frame-options", "DENY");
  res.headers.set("content-security-policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  res.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains; preload");
  return res;
}
__name(withLinkPreview, "withLinkPreview");
async function ogImage(url) {
  const id = decodeURIComponent(url.pathname.slice("/og-image/".length));
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const thumb = await rpc("link_preview_thumb", { p_id: id });
  const m = /^data:(image\/(?:webp|png|jpeg|gif));base64,(.+)$/.exec(String(thumb || ""));
  if (!m) return Response.redirect(new URL(DEFAULT_IMAGE, url.origin).toString(), 302);
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": m[1], "cache-control": "public, max-age=3600" } });
}
__name(ogImage, "ogImage");
async function ogEventImage(url) {
  const id = decodeURIComponent(url.pathname.slice("/og-event/".length));
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const cover = await rpc("link_preview_event_cover", { p_id: id });
  const m = /^data:(image\/(?:webp|png|jpeg|gif));base64,(.+)$/.exec(String(cover || ""));
  if (!m) return Response.redirect(new URL(DEFAULT_IMAGE, url.origin).toString(), 302);
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": m[1], "cache-control": "public, max-age=3600" } });
}
__name(ogEventImage, "ogEventImage");
async function eventSheet(url) {
  const token = decodeURIComponent(url.pathname.slice("/sheets/".length)).replace(/\.csv$/, "");
  const notFound = /* @__PURE__ */ __name(() => new Response("This sheet link is not valid. Ask the event's team for a new one.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }), "notFound");
  if (!/^[0-9a-f]{64}$/.test(token)) return notFound();
  const res = await fetch(`${SUPABASE_ORIGIN}/rest/v1/rpc/event_sheet_data`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ p_token: token }),
    cf: { cacheTtl: 0, cacheEverything: false }
  });
  const data = res.ok ? await res.json().catch(() => null) : null;
  if (!data) return notFound();
  const cell = /* @__PURE__ */ __name((v) => {
    const s = v == null ? "" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? v.name || "" : String(v);
    return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  }, "cell");
  const questions = data.questions || [];
  const rows = [
    ["Submitted", "Entrant", "Placement", ...questions.map((q) => q.label)],
    ...(data.entries || []).map((en) => [en.created_at, en.entrant, en.placement ?? "", ...questions.map((q) => en.answers?.[q.id])])
  ];
  return new Response(rows.map((r) => r.map(cell).join(",")).join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer"
    }
  });
}
__name(eventSheet, "eventSheet");
var TURN_TTL_SECONDS = 4 * 3600;
async function turnCredentials(request, env) {
  const json = /* @__PURE__ */ __name((body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  }), "json");
  if (request.method !== "POST") return json({ iceServers: [] }, 405);
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return json({ iceServers: [], warning: "TURN secrets not set" }, 503);
  const auth = request.headers.get("authorization") || "";
  if (!/^Bearer \S+$/.test(auth)) return json({ iceServers: [] }, 401);
  const who = await fetch(`${SUPABASE_ORIGIN}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, authorization: auth } });
  const user = who.ok ? await who.json().catch(() => null) : null;
  if (!user?.id) return json({ iceServers: [] }, 401);
  if (env.TURN_LIMITER && !(await env.TURN_LIMITER.limit({ key: user.id })).success) {
    return json({ iceServers: [], warning: "Too many relay requests; try again in a minute." }, 429);
  }
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.TURN_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl: TURN_TTL_SECONDS })
  });
  if (!res.ok) return json({ iceServers: [], warning: `TURN service answered ${res.status}` }, 502);
  const data = await res.json();
  const iceServers = (data.iceServers || []).map((s) => ({
    ...s,
    urls: [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u))
  })).filter((s) => s.urls.length);
  return json({ iceServers });
}
__name(turnCredentials, "turnCredentials");

// C:/Users/maste/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// C:/Users/maste/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-flyWMb/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// C:/Users/maste/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-flyWMb/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
