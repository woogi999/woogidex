// Resolves auth_events addresses to a rough location, on demand -- not at
// sign-in time, so a geo provider only ever sees an address when staff is
// actively investigating. Result is cached back onto the row.
//
// Access check delegates to Postgres (`view_ips` permission via the caller's
// JWT); this function never decides authorization itself.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { corsHeadersFor } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const LOOKUP_TIMEOUT_MS = 4000;
const MAX_PER_CALL = 25;

function jsonResponse(cors: Record<string, string>, body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
    });
}

// private ranges and the missing-header placeholder -- nothing to look up
function isLookupable(ip: string | null): boolean {
    if (!ip || ip === 'unknown') return false;
    if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.')) return false;
    if (ip.startsWith('192.168.') || ip.startsWith('169.254.') || ip.startsWith('fc') || ip.startsWith('fd')) return false;
    const m = ip.match(/^172\.(\d+)\./);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
    return true;
}

async function geolocate(ip: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
        const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: controller.signal });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data?.success) return null;
        return {
            country: data.country ?? null,
            region: data.region ?? null,
            city: data.city ?? null,
            org: data.connection?.org ?? data.connection?.isp ?? null,
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

Deno.serve(async (req) => {
    const cors = corsHeadersFor(req, 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return jsonResponse(cors, { ok: false }, 405);

    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return jsonResponse(cors, { ok: false, error: 'Not authorized' }, 401);

    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: perms, error: permError } = await callerClient.rpc('my_permissions');
    if (permError || !perms?.view_ips) {
        return jsonResponse(cors, { ok: false, error: 'Not authorized' }, 403);
    }

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // staff-only doesn't mean trusted not to misfire -- rate limit per caller
    // so this can't hammer the geo provider or this table without limit
    const { data: caller } = await callerClient.auth.getUser();
    const callerId = caller?.user?.id;
    if (callerId) {
        const { data: allowed } = await service.rpc('rate_limit_hit', {
            p_key: `admin-ip-lookup:${callerId}`,
            p_limit: 5,
            p_window: '1 minute',
        });
        if (allowed === false) {
            return jsonResponse(cors, { ok: false, error: 'Too many lookups. Please wait a moment and try again.' }, 429);
        }
    }

    let userId: string | null = null;
    try {
        const body = await req.json();
        userId = typeof body?.user_id === 'string' ? body.user_id : null;
    } catch { /* handled below */ }
    if (!userId) return jsonResponse(cors, { ok: false, error: 'user_id required' }, 400);

    const { data: rows } = await service
        .from('auth_events')
        .select('id, ip')
        .eq('user_id', userId)
        .is('geo_at', null)
        .order('created_at', { ascending: false })
        .limit(MAX_PER_CALL);

    if (!rows?.length) return jsonResponse(cors, { ok: true, resolved: 0 });

    // one lookup per distinct address, fan the answer back out
    const byIp = new Map<string, { id: number }[]>();
    for (const row of rows) {
        if (!isLookupable(row.ip)) continue;
        const list = byIp.get(row.ip) ?? [];
        list.push({ id: row.id });
        byIp.set(row.ip, list);
    }

    let resolved = 0;
    for (const [ip, targets] of byIp) {
        // reuse an existing answer if this address was seen before
        const { data: cached } = await service
            .from('auth_events')
            .select('country, region, city, org')
            .eq('ip', ip)
            .not('geo_at', 'is', null)
            .limit(1)
            .maybeSingle();

        const geo = cached ?? await geolocate(ip);
        if (!geo) continue;
        const ids = targets.map(t => t.id);
        await service.from('auth_events')
            .update({ ...geo, geo_at: new Date().toISOString() })
            .in('id', ids);
        resolved += ids.length;
    }

    return jsonResponse(cors, { ok: true, resolved });
});
