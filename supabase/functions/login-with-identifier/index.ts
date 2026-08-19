import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isEmailIdentifier, GENERIC_INVALID_MESSAGE, RATE_LIMITED_MESSAGE } from './logic.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const RATE_LIMIT_WINDOW_MINUTES = 5;
const RATE_LIMIT_MAX_ATTEMPTS = 10;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

    let body: { identifier?: string; password?: string };
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ ok: false, error: GENERIC_INVALID_MESSAGE });
    }

    const identifier = (body.identifier ?? '').trim();
    const password = body.password ?? '';
    if (!identifier || !password) {
        return jsonResponse({ ok: false, error: GENERIC_INVALID_MESSAGE });
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // per-IP rate limit - this is the check the old RPC could never do,
    // since it ran behind the connection pooler and couldn't see real IPs.
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60_000).toISOString();
    const { count: recentAttempts } = await serviceClient
        .from('login_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('ip', ip)
        .gte('attempted_at', windowStart);

    if ((recentAttempts ?? 0) >= RATE_LIMIT_MAX_ATTEMPTS) {
        return jsonResponse({ ok: false, error: RATE_LIMITED_MESSAGE });
    }

    await serviceClient.from('login_attempts').insert({ ip });
    // best-effort cleanup so this table doesn't grow forever; failure here
    // must never block a login attempt.
    serviceClient
        .from('login_attempts')
        .delete()
        .lt('attempted_at', new Date(Date.now() - 24 * 60 * 60_000).toISOString())
        .then(() => {}, () => {});

    // resolve identifier -> email, server-side only. this value is never
    // included in any response below.
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

    if (!email) return jsonResponse({ ok: false, error: GENERIC_INVALID_MESSAGE });

    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: signInData, error: signInError } = await anonClient.auth.signInWithPassword({ email, password });

    if (signInError || !signInData.session) {
        return jsonResponse({ ok: false, error: GENERIC_INVALID_MESSAGE });
    }

    return jsonResponse({
        ok: true,
        session: {
            access_token: signInData.session.access_token,
            refresh_token: signInData.session.refresh_token,
        },
    });
});
