// CORS allowlist. Previously every function reflected '*', letting any site
// read these responses in a visitor's browser. Auth here doesn't rely on
// cookies, so this isn't closing an auth bypass -- just removing pointless
// exposure.
const ALLOWED_ORIGINS = new Set([
    'https://dex.woogi.xyz',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
]);

export function corsHeadersFor(req: Request, methods: string): Record<string, string> {
    const origin = req.headers.get('Origin');
    const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://dex.woogi.xyz';
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': methods,
        // varies per request, so caches must not mix up visitors' responses
        'Vary': 'Origin',
    };
}
