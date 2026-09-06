// Records where an account was created from. Sign-in already gets its own
// auth_events row from login-with-identifier; sign-up goes straight to GoTrue
// from the browser, so the client calls this right after with its fresh
// token instead.
//
// Address comes from the request's own headers, never the client; identity
// comes from the verified JWT, so nobody can write a row for someone else.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { corsHeadersFor } from '../_shared/cors.ts';
import { clientIp } from '../_shared/client-ip.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// dedupe window: more than one row per user/kind/minute is a client bug
const DEDUPE_WINDOW_MS = 60_000;

function jsonResponse(cors: Record<string, string>, body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
    });
}

Deno.serve(async (req) => {
    const cors = corsHeadersFor(req, 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return jsonResponse(cors, { ok: false }, 405);

    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) return jsonResponse(cors, { ok: false }, 401);

    // caller identity from their own token, never from the request body
    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userError } = await authClient.auth.getUser();
    const user = userData?.user;
    if (userError || !user) return jsonResponse(cors, { ok: false }, 401);

    let kind = 'signup';
    try {
        const body = await req.json();
        if (body?.kind === 'login') kind = 'login';
    } catch { /* default stands */ }

    const ip = clientIp(req);
    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
    const { count } = await service
        .from('auth_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('kind', kind)
        .gte('created_at', since);
    if ((count ?? 0) > 0) return jsonResponse(cors, { ok: true, deduped: true });

    await service.from('auth_events').insert({
        user_id: user.id,
        kind,
        ip,
        user_agent: (req.headers.get('user-agent') ?? '').slice(0, 400),
    });

    return jsonResponse(cors, { ok: true });
});
