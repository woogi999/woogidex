import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { isEmailIdentifier, GENERIC_INVALID_MESSAGE, RATE_LIMITED_MESSAGE } from './logic.ts';
import { corsHeadersFor } from '../_shared/cors.ts';
import { clientIp } from '../_shared/client-ip.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function jsonResponse(cors: Record<string, string>, body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
    });
}

Deno.serve(async (req) => {
    const cors = corsHeadersFor(req, 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return jsonResponse(cors, { ok: false, error: 'Method not allowed' }, 405);

    let body: { identifier?: string; password?: string };
    try {
        body = await req.json();
    } catch {
        return jsonResponse(cors, { ok: false, error: GENERIC_INVALID_MESSAGE });
    }

    const identifier = (body.identifier ?? '').trim();
    const password = body.password ?? '';
    if (!identifier || !password) {
        return jsonResponse(cors, { ok: false, error: GENERIC_INVALID_MESSAGE });
    }

    const ip = clientIp(req);
    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Rate limit decision lives in Postgres (auth_rate_ok) so it's atomic
    // across concurrent requests, and buckets IPv6 by /64. Also keys a second
    // bucket on the identifier, so password guessing is limited even from
    // many addresses. Fails closed if the limiter can't be consulted.
    const { data: allowed, error: limitError } = await serviceClient
        .rpc('auth_rate_ok', { p_ip: ip, p_identifier: identifier });
    if (limitError || allowed === false) {
        return jsonResponse(cors, { ok: false, error: RATE_LIMITED_MESSAGE });
    }

    // resolve identifier -> email server-side only; never returned to caller
    let email: string | null = null;
    if (isEmailIdentifier(identifier)) {
        email = identifier;
    } else {
        const { data: profile } = await serviceClient
            .from('profiles')
            .select('id')
            .eq('username', identifier)
            .maybeSingle();
        if (profile) {
            const { data: userData } = await serviceClient.auth.admin.getUserById(profile.id);
            email = userData?.user?.email ?? null;
        }
    }

    if (!email) return jsonResponse(cors, { ok: false, error: GENERIC_INVALID_MESSAGE });

    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: signInData, error: signInError } = await anonClient.auth.signInWithPassword({ email, password });

    if (signInError || !signInData.session) {
        return jsonResponse(cors, { ok: false, error: GENERIC_INVALID_MESSAGE });
    }

    // successful attempt shouldn't count against the shared-address bucket,
    // or a NAT'd office/carrier could lock itself out via the rate limiter
    await serviceClient.rpc('auth_rate_clear', { p_ip: ip, p_identifier: identifier });

    // best-effort audit record; must never fail the login itself
    try {
        await serviceClient.from('auth_events').insert({
            user_id: signInData.user?.id ?? signInData.session.user?.id ?? null,
            kind: 'login',
            ip,
            user_agent: (req.headers.get('user-agent') ?? '').slice(0, 400),
        });
    } catch (_) { /* ignore */ }

    return jsonResponse(cors, {
        ok: true,
        session: {
            access_token: signInData.session.access_token,
            refresh_token: signInData.session.refresh_token,
        },
    });
});
