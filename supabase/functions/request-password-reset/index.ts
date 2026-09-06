// Resolves a username to its email server-side and sends a password reset,
// so a client-side lookup can't be used to harvest emails by username. Email
// identifiers skip this and call resetPasswordForEmail() straight from the
// browser instead.
//
// Always responds { ok: true } once past validation/rate-limit -- a different
// response for "no such user" would itself leak which usernames exist.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { corsHeadersFor } from '../_shared/cors.ts';
import { clientIp } from '../_shared/client-ip.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const PLACEHOLDER_EMAIL_SUFFIXES = ['@users.woogidex.invalid', '@no-email.woogidex.com'];

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

    let body: { identifier?: string; redirectTo?: string };
    try {
        body = await req.json();
    } catch {
        return jsonResponse(cors, { ok: false, error: 'Invalid request.' });
    }

    const identifier = (body.identifier ?? '').trim();
    if (!identifier) return jsonResponse(cors, { ok: false, error: 'Enter your username or email.' });

    // GoTrue only honours this if it matches the configured Redirect URLs
    // allowlist, so it can't be used to point reset links at another site.
    const redirectTo = typeof body.redirectTo === 'string' && /^https?:\/\//.test(body.redirectTo)
        ? body.redirectTo
        : undefined;

    const ip = clientIp(req);
    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Shared limiter with login-with-identifier: atomic, IPv6-/64-aware, and
    // buckets per identifier as well as per address -- without the identifier
    // bucket, an attacker spread across many addresses could spam one person
    // with reset emails.
    const { data: allowed, error: limitError } = await serviceClient
        .rpc('auth_rate_ok', { p_ip: ip, p_identifier: identifier });
    if (limitError || allowed === false) {
        return jsonResponse(cors, { ok: false, error: 'Too many attempts. Please try again in a few minutes.' });
    }

    const { data: profile } = await serviceClient
        .from('profiles')
        .select('id')
        .eq('username', identifier)
        .maybeSingle();

    if (profile) {
        const { data: userData } = await serviceClient.auth.admin.getUserById(profile.id);
        const email = userData?.user?.email ?? null;
        const hasRealEmail = !!email && !PLACEHOLDER_EMAIL_SUFFIXES.some(suffix => email.endsWith(suffix));
        if (hasRealEmail) {
            const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            await anonClient.auth.resetPasswordForEmail(email!, redirectTo ? { redirectTo } : undefined);
        }
    }

    // same response regardless of whether an emailable account was found
    return jsonResponse(cors, { ok: true });
});
