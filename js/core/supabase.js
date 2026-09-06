// Leaf module (no imports) so admin.html and the main site can share one copy
// instead of duplicating the project URL/key across files.
// The anon/publishable key is public by design; access is enforced by RLS server-side.
export const SUPABASE_PROJECT_URL = 'https://qstbascfeolkyxtrqqwv.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_B4jEJ--w0XFsgXDmQeJREA_xH1GRBsf';

// Routing API calls through /sb on our own origin (proxied by worker/index.js,
// see vite.config.js for local dev) puts requests behind the same WAF/rate
// limiting as the static site and avoids a CORS preflight. Only flip this on
// once the worker proxy is confirmed live, or every request 404s at once.
const USE_SAME_ORIGIN_PROXY = true;

export const SUPABASE_URL = USE_SAME_ORIGIN_PROXY && typeof window !== 'undefined'
    ? `${window.location.origin}/sb`
    : SUPABASE_PROJECT_URL;

let supabase = null;

export async function getClient() {
    if (supabase) return supabase;
    const { createClient } = await import('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true }
    });
    return supabase;
}
