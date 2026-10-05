// Emails an event announcement to its followers who asked for that
// (Settings, Notifications, "Email me event announcements"). The bell
// notification went out already, from post_event_announcement() in the
// database; this is the email copy, called by the page right after posting.
//
//   1. The caller must be on the event's team with Edit (event_can, asked as
//      them), so nobody can make the site email people on their own.
//   2. Each announcement is emailed once: emailed_at is claimed before
//      anything is sent, and Resend's idempotency keys cover a retried batch.
//   3. Recipients come from event_announcement_recipients(): followers who
//      turned the email on, haven't paused notifications, and have a real
//      address. Nobody's address is ever sent back to the caller.
//
// Secrets: RESEND_API_KEY, and EMAIL_FROM (a sender on a domain verified in
// Resend, e.g. "Woogidex <events@dex.woogi.xyz>"). Without the key this
// answers 503 and nothing is sent.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { corsHeadersFor } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const EMAIL_FROM = Deno.env.get('EMAIL_FROM') ?? 'Woogidex <events@dex.woogi.xyz>';
const SITE_URL = (Deno.env.get('SITE_URL') ?? 'https://dex.woogi.xyz').replace(/\/+$/, '');
// Resend's batch endpoint takes up to 100 emails a call
const BATCH = 100;

function json(cors: Record<string, string>, body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The announcement's markdown as plain text: emphasis marks off, links as "label (url)". */
function plain(md: string): string {
    return md
        .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)')
        .replace(/(\*\*|__|~~|\|\|)(.+?)\1/g, '$2')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
        .replace(/^#{1,3}\s+/gm, '')
        .replace(/^>\s?/gm, '')
        .replace(/`([^`\n]+)`/g, '$1');
}

const when = (v: string | null) => v ? new Date(v).toUTCString().replace(/:00 GMT$/, ' UTC') : 'to be announced';

Deno.serve(async (req) => {
    const cors = corsHeadersFor(req, 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json(cors, { error: 'Method not allowed.' }, 405);

    let body: any;
    try { body = await req.json(); } catch { return json(cors, { error: 'Bad request.' }, 400); }
    const id = String(body?.announcement_id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json(cors, { error: 'Bad request.' }, 400);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: a } = await service.from('event_announcements').select('id, event_id, title, body, emailed_at').eq('id', id).maybeSingle();
    if (!a) return json(cors, { error: 'No such announcement.' }, 404);

    // asked as the caller, so their own permissions decide
    const asCaller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: allowed } = await asCaller.rpc('event_can', { p_event: a.event_id, p_perm: 'edit' });
    if (allowed !== true) return json(cors, { error: 'Only the event\'s team can send its announcements.' }, 403);

    if (a.emailed_at) return json(cors, { ok: true, sent: 0, already: true });
    if (!RESEND_API_KEY) return json(cors, { error: 'Announcement emails are not set up on this site yet.' }, 503);

    const { data: ev } = await service.from('events')
        .select('id, slug, title, phase, submissions_open_at, submissions_close_at, voting_open_at, voting_close_at, results_at')
        .eq('id', a.event_id).maybeSingle();
    if (!ev || ev.phase === 'draft') return json(cors, { ok: true, sent: 0 });

    // claim it before sending: two calls at once can't both send
    const { data: claimed } = await service.from('event_announcements').update({ emailed_at: new Date().toISOString() })
        .eq('id', id).is('emailed_at', null).select('id');
    if (!claimed?.length) return json(cors, { ok: true, sent: 0, already: true });

    const { data: people, error: listError } = await service.rpc('event_announcement_recipients', { p_announcement: id });
    if (listError) return json(cors, { error: 'Could not list who to email.' }, 500);
    const recipients = (people ?? []) as Array<{ email: string; name: string }>;
    if (!recipients.length) return json(cors, { ok: true, sent: 0 });

    const link = `${SITE_URL}/events/${encodeURIComponent(ev.slug || ev.id)}`;
    const settings = `${SITE_URL}/settings`;
    // the event's own variables; the ones that need standings read on the page
    const vars: Record<string, string> = {
        event: ev.title, link, entries_open: when(ev.submissions_open_at), entries_close: when(ev.submissions_close_at),
        voting_open: when(ev.voting_open_at), voting_close: when(ev.voting_close_at), results_date: when(ev.results_at)
    };
    const filled = String(a.body || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m: string, k: string) => vars[k.toLowerCase()] ?? '(see the event page)');
    const text = plain(filled);
    const subject = `${a.title} · ${ev.title}`.slice(0, 200);
    const html = (name: string) => `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f3ef;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d2433">
<div style="max-width:560px;margin:0 auto;background:#fefdfc;border:1px solid #e6e2da;border-radius:14px;padding:28px">
<p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#7c5cff;text-transform:uppercase;letter-spacing:.04em">${escapeHtml(ev.title)}</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${escapeHtml(a.title)}</h1>
<p style="margin:0 0 12px;color:#55607a">Hi ${escapeHtml(name)},</p>
${text.split(/\n{2,}/).filter(Boolean).map(p => `<p style="margin:0 0 12px;line-height:1.6;color:#1d2433">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n')}
<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#7c5cff;color:#fff;text-decoration:none;font-weight:700">Open the event</a></p>
<p style="margin:0;font-size:12px;color:#8b94a8;line-height:1.5">You're getting this because you follow ${escapeHtml(ev.title)} on Woogidex and turned on event emails. Turn them off in <a href="${escapeHtml(settings)}" style="color:#8b94a8">Settings, Notifications</a>, or unfollow the event on its page.</p>
</div></body></html>`;

    let sent = 0;
    for (let i = 0; i < recipients.length; i += BATCH) {
        const chunk = recipients.slice(i, i + BATCH).map(r => ({
            from: EMAIL_FROM, to: [r.email], subject,
            html: html(r.name),
            text: `${a.title}\n\nHi ${r.name},\n\n${text}\n\nOpen the event: ${link}\n\nTurn these emails off in Settings, Notifications: ${settings}`,
            headers: { 'List-Unsubscribe': `<${settings}>` }
        }));
        const res = await fetch('https://api.resend.com/emails/batch', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `event-announcement-${id}-${i / BATCH}` },
            body: JSON.stringify(chunk)
        });
        if (res.ok) sent += chunk.length;
        else console.error('Resend refused a batch', res.status, await res.text().catch(() => ''));
    }
    return json(cors, { ok: true, sent });
});
