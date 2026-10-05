// A guest's entry to a public event (no Woogidex account). The only way one
// gets in: the browser can't call submit_event_entry_guest itself.
//
//   1. Turnstile: the caller has to pass Cloudflare's challenge, one token per
//      entry (tokens are single-use, so a script can't replay one).
//   2. The caller's real address (signed by our proxy, see client-ip.ts) is
//      handed to the database, which rate limits per address, per event and
//      per address across events (submit_event_entry_guest).
//
// The secret is the TURNSTILE_SECRET_KEY function secret (Cloudflare widget
// "Woogidex guest event entries"); the matching public site key is in
// js/app/components/EventsPanel.tsx. Without the secret this refuses
// everything, so guests can't enter.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { corsHeadersFor } from '../_shared/cors.ts';
import { clientIp } from '../_shared/client-ip.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TURNSTILE_SECRET = Deno.env.get('TURNSTILE_SECRET_KEY') ?? '';

// a 6 MB entry is the database's own cap; anything bigger is refused before parsing
const MAX_BODY_BYTES = 7_000_000;

function json(cors: Record<string, string>, body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

async function turnstileOk(token: string, ip: string): Promise<boolean> {
    const form = new FormData();
    form.append('secret', TURNSTILE_SECRET);
    form.append('response', token);
    if (ip !== 'unknown') form.append('remoteip', ip);
    try {
        const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
        const out = await res.json();
        return out?.success === true;
    } catch {
        return false;
    }
}

Deno.serve(async (req) => {
    const cors = corsHeadersFor(req, 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json(cors, { error: 'Method not allowed.' }, 405);
    if (!TURNSTILE_SECRET) return json(cors, { error: 'Guest entries are not set up on this site yet.' }, 503);

    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(cors, { error: 'That entry is too large. Use smaller images.' }, 413);
    let body: any;
    try {
        const text = await req.text();
        if (text.length > MAX_BODY_BYTES) return json(cors, { error: 'That entry is too large. Use smaller images.' }, 413);
        body = JSON.parse(text);
    } catch {
        return json(cors, { error: 'Bad request.' }, 400);
    }
    const eventId = String(body?.event_id ?? '');
    const token = String(body?.token ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(eventId) || !token || typeof body?.answers !== 'object' || body.answers === null || Array.isArray(body.answers)) {
        return json(cors, { error: 'Bad request.' }, 400);
    }

    const ip = clientIp(req);
    if (!(await turnstileOk(token, ip))) return json(cors, { error: 'The anti-spam check failed. Please try again.' }, 403);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await service.rpc('submit_event_entry_guest', { p_event: eventId, p_answers: body.answers, p_ip: ip });
    // the database's messages are written for people ("Please answer: Email")
    if (error) return json(cors, { error: error.message }, 400);
    return json(cors, { ok: true, entry_id: data });
});
