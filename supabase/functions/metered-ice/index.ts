// Hands an authenticated battler short-lived Metered.ca TURN/STUN credentials.
// Only place the Metered API key is read -- it stays in env secrets and never
// reaches the browser. verify_jwt = true (in supabase/config.toml) restricts
// this to signed-in users.
//
// Configure via `supabase secrets set`:
//   METERED_DOMAIN, METERED_API_KEY

import { corsHeadersFor } from '../_shared/cors.ts';

const METERED_DOMAIN = Deno.env.get('METERED_DOMAIN');
const METERED_API_KEY = Deno.env.get('METERED_API_KEY');

// fallback so a battle can still connect if Metered is unreachable
const STUN_FALLBACK = [{ urls: 'stun:stun.l.google.com:19302' }];

function jsonResponse(cors: Record<string, string>, body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
    });
}

Deno.serve(async (req) => {
    const cors = corsHeadersFor(req, 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (!METERED_DOMAIN || !METERED_API_KEY) {
        // misconfigured, not the caller's fault -- degrade to STUN-only
        return jsonResponse(cors, { iceServers: STUN_FALLBACK, warning: 'Metered credentials not configured' });
    }

    try {
        const res = await fetch(
            `https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`
        );
        if (!res.ok) throw new Error(`Metered API responded ${res.status}`);
        const iceServers = await res.json();
        return jsonResponse(cors, { iceServers: Array.isArray(iceServers) && iceServers.length ? iceServers : STUN_FALLBACK });
    } catch (e) {
        return jsonResponse(cors, { iceServers: STUN_FALLBACK, warning: String(e) });
    }
});
