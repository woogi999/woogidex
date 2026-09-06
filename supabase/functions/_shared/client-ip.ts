// Resolves the real client IP. Requests come through a Cloudflare Worker proxy,
// and X-Forwarded-For gets rewritten on that hop (Cloudflare replaces it with
// its own peer address whenever *.supabase.co is fronted by Cloudflare too),
// which previously collapsed every visitor onto one shared rate-limit bucket.
// The Worker now also sends the address in a signed header of our own that
// survives the hop.
//
// The header must be signed -- these functions are still directly reachable,
// so an unsigned header could be spoofed to dodge rate limiting.
// Set the same value in both places:
//     npx wrangler secret put PROXY_SHARED_SECRET
//     npx supabase secrets set PROXY_SHARED_SECRET=...
// Falls back to X-Forwarded-For until both are set.

const PROXY_SECRET = Deno.env.get('PROXY_SHARED_SECRET') ?? '';

export const CLIENT_IP_HEADER = 'x-woogi-client-ip';
export const PROXY_KEY_HEADER = 'x-woogi-proxy-key';

// Length is allowed to leak; the contents are not. A plain === would let a
// caller recover the secret a character at a time from response timings.
function secretMatches(given: string): boolean {
    if (!PROXY_SECRET || given.length !== PROXY_SECRET.length) return false;
    let diff = 0;
    for (let i = 0; i < given.length; i++) {
        diff |= given.charCodeAt(i) ^ PROXY_SECRET.charCodeAt(i);
    }
    return diff === 0;
}

export function clientIp(req: Request): string {
    const claimed = req.headers.get(CLIENT_IP_HEADER)?.trim();
    if (claimed && secretMatches(req.headers.get(PROXY_KEY_HEADER) ?? '')) {
        return claimed;
    }
    // Direct hit on *.supabase.co, or the secret is not configured yet.
    return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
}
