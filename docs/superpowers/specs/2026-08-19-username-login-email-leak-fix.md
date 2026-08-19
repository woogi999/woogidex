# Username-Login Email Leak — Spec

## Problem

`public.email_for_username(input_username text)` is a `SECURITY DEFINER` Postgres
function, callable directly by the `anon` role via
`/rest/v1/rpc/email_for_username`, that returns a user's real account email
given only their username. It has no internal authorization check and no
rate limit.

It exists because Supabase Auth only understands email/password, but this
site's login form accepts a username. [js/auth.js](../../../js/auth.js)
(`signIn`, around line 198) and [js/admin.js](../../../js/admin.js)
(`signIn`, around line 68) both call this RPC directly from the browser to
translate a typed username into the email `signInWithPassword` needs, then
call `signInWithPassword` themselves.

Because the RPC's response (the raw email) is sent to whatever called it,
and the `anon` public API key required to call it is already embedded in
the shipped JS, anyone can call this endpoint directly — bypassing the
website UI entirely — with any username string, at any rate, and harvest
the real email address behind every account on the site. Usernames are
public (visible in profiles, comments, dex credits), so the attack requires
no special knowledge.

Rate-limiting the RPC only slows this down — Postgres functions invoked
through Supabase's PostgREST layer sit behind a connection pooler and
cannot see the caller's real IP address (`inet_client_addr()` returns the
pooler's IP), so they can only throttle *total* traffic, not a specific
abuser. The response would still, eventually, hand back a real email to
anyone who asks.

## Fix

Stop ever sending the email address to the browser at all. Move the
username→email translation *and* the login call into a single trusted
server-side hop — a Supabase Edge Function — that the browser calls with
`{identifier, password}` and gets back only a session (on success) or a
generic failure message (on any kind of failure). The email value never
appears in any response body a browser — or an attacker calling the API
directly — ever receives.

Edge Functions run outside the PostgREST/pooler path and *do* see the real
caller IP (via `x-forwarded-for`), so this is also where real per-IP rate
limiting becomes possible, unlike inside a raw SQL function.

## Requirements

1. No response reachable by an unauthenticated caller may ever contain a
   real user email address.
2. Username-based login keeps working, unchanged, from the existing UI on
   both the main site and the admin panel.
3. A failed attempt returns the *same* generic message/shape regardless of
   whether the username didn't exist or the password was wrong — no
   enumeration via response content.
4. Login attempts are rate-limited per source IP (not just globally).
5. Once the new path is live and verified, `email_for_username` must no
   longer be callable by `anon` or `authenticated` — close the direct RPC
   hole, don't just add a parallel safe path next to it.
6. All new SQL (the rate-limit table, the `REVOKE`) ships as a versioned
   migration file in the repo — this repo currently has **no** Supabase
   schema under version control at all (confirmed: no `supabase/`
   directory exists), so this is also the first step of fixing that.

## Explicitly out of scope

The separate `profiles.role` vs. `profile_badges`/`badges` dual-authorization
inconsistency (RLS's `is_staff()` reads the legacy `profiles.role` column;
the current admin UI only ever writes `profile_badges`) is a real, separate
problem, tracked independently — not part of this fix.

## Constraints

- Edge Function runtime is **Deno**, not Node (confirmed direction: Supabase
  Edge Functions, hosted by Supabase — no separate server to stand up,
  fitting the GitHub Pages static-hosting setup this site already uses).
- Reuse the existing `@supabase/supabase-js` client pattern already used in
  [js/auth.js](../../../js/auth.js) (loaded via `esm.sh` import) — Edge
  Functions use the same package, imported the same way, just from Deno.
- Repo has no test framework and no CI test step today. Pure logic gets a
  real `deno test`. Anything that needs a live Supabase project (the DB
  lookup, the actual sign-in call, the deployed function) is verified
  manually against the real project, since the agent implementing this has
  no credentials for that project — those steps are explicitly the user's
  to run, with exact commands and expected output given.
- `client.functions.invoke()` (the supabase-js helper) is used from the
  browser rather than raw `fetch`, for consistent auth-header handling.
- Response shape from the Edge Function is always HTTP 200 with
  `{ ok: boolean, error?: string, session?: {access_token, refresh_token} }`
  — deliberately avoiding non-2xx status codes for expected failure cases
  (invalid credentials, rate limited), since supabase-js's
  `functions.invoke()` does not surface a non-2xx response body through
  `data` the way a 200 body is surfaced, which would otherwise make error
  messages awkward to read on the client.
