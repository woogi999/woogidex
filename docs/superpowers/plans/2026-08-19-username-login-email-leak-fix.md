# Username-Login Email Leak Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `email_for_username` from ever returning a real user's email to an unauthenticated caller, by moving username→email lookup and the login call itself into a Supabase Edge Function, so the email address never appears in any browser-visible response.

**Architecture:** A new Deno-based Supabase Edge Function (`login-with-identifier`) takes `{identifier, password}`, resolves username→email server-side using a service-role key (never sent to the caller), then performs the actual `signInWithPassword` call itself and returns only a session token or a generic failure message. `js/auth.js` and `js/admin.js` are updated to call this function instead of the old two-step (public RPC lookup, then client-side sign-in) for username logins; email-based logins are unaffected. The old `email_for_username` RPC's public grants are revoked only *after* the new path is deployed and verified working, to avoid any login downtime.

**Tech Stack:** Supabase Edge Functions (Deno + TypeScript), `@supabase/supabase-js` (same package already used client-side), Deno's built-in test runner for the one pure-logic unit.

**Spec:** [docs/superpowers/specs/2026-08-19-username-login-email-leak-fix.md](../specs/2026-08-19-username-login-email-leak-fix.md)

## Global Constraints

- No response reachable by an unauthenticated caller may ever contain a real user email address.
- Username-based login must keep working, unchanged, from both the main site and the admin panel UI.
- A failed attempt (bad username OR bad password) returns the identical generic message/shape — no enumeration via response content.
- Login attempts are rate-limited per source IP, not just globally.
- `email_for_username`'s public grants are revoked only after the new path is confirmed working — never before, to avoid a login outage.
- **No command in this plan may run automatically against the live database.** Every SQL statement that touches the live Supabase project is pasted into the Supabase dashboard's SQL editor and run by the user themselves, by hand, after reading it — never via `supabase db push`, `db reset`, or any other CLI-to-database command. This is a hard constraint from the project owner given the site already has real user accounts.
- The only Supabase CLI command used against the live project at all is `supabase functions deploy`, which uploads code only and cannot read, write, or reset any table.

---

## File Structure

- Create: `supabase/config.toml`, `supabase/.gitignore`, `supabase/functions/`, `supabase/migrations/` — scaffolded by `supabase init` (Task 1), local-only, no live-project interaction.
- Create: `supabase/migrations/20260819000000_login_attempts_table.sql` — new rate-limit table. Kept in the repo for history; **applied by the user pasting it into the SQL editor**, not by CLI push.
- Create: `supabase/migrations/20260819000100_revoke_email_for_username.sql` — the actual fix's closing step (revokes public access to the old leaky RPC). Applied the same manual way, but only in Task 7, after the new path is proven live.
- Create: `supabase/functions/login-with-identifier/logic.ts` — pure, dependency-free helper functions (identifier-is-email check, shared message strings). No Supabase/network calls — this is the only piece with an automated test.
- Create: `supabase/functions/login-with-identifier/logic.test.ts` — `deno test` covering `logic.ts`.
- Create: `supabase/functions/login-with-identifier/index.ts` — the actual HTTP handler: rate limiting, username→email lookup, sign-in call, response shaping.
- Modify: `js/auth.js:198-210` (`signIn`) — route username logins through the new Edge Function.
- Modify: `js/admin.js:68-78` (`signIn`) — same change, mirrored (admin.js is deliberately standalone and doesn't import from auth.js — see its own header comment — so this is intentionally duplicated, matching existing project convention).

---

### Task 1: Scaffold the local Supabase project structure

**Files:**
- Create: `supabase/config.toml`, `supabase/.gitignore`, `supabase/functions/.gitkeep`, `supabase/migrations/.gitkeep` (via CLI, not by hand)

**Interfaces:**
- Produces: the `supabase/` directory structure that every later task writes files into.

- [ ] **Step 1: Run the scaffold command**

```bash
npx supabase init
```

This only writes local files. It does not prompt for login and does not contact any live project.

- [ ] **Step 2: Verify the structure was created**

```bash
ls supabase
```

Expected: `config.toml`, `functions/`, `migrations/`, and a `.gitignore` supabase itself created (it excludes local CLI scratch state like `.branches`/`.temp` — leave it as the CLI wrote it).

- [ ] **Step 3: Commit**

```bash
git add supabase/config.toml supabase/.gitignore
git commit -m "chore: scaffold local supabase project structure"
```

---

### Task 2: Create the rate-limit table migration (create-only, safe to run immediately)

**Files:**
- Create: `supabase/migrations/20260819000000_login_attempts_table.sql`

**Interfaces:**
- Produces: `public.login_attempts(id, ip, attempted_at)` — the table Task 4's Edge Function reads and writes via its service-role key.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260819000000_login_attempts_table.sql
create table if not exists public.login_attempts (
    id bigint generated always as identity primary key,
    ip text not null,
    attempted_at timestamptz not null default now()
);

create index if not exists idx_login_attempts_ip_time
    on public.login_attempts (ip, attempted_at);
```

This only creates a brand-new table. It does not alter, drop, or read any existing table or row. If this project's `rls_auto_enable()` event trigger fires on it (per the earlier linter findings, it appears to auto-enable RLS on new tables), that's fine and expected here — with no policies added, that just means only the service-role key (used exclusively by the Edge Function in Task 4) can touch it, which is exactly what's wanted; no ordinary client should read or write this table directly.

- [ ] **Step 2: Run it yourself in the Supabase dashboard**

Open your Supabase project → SQL Editor → paste the exact contents of the file above → Run.

Expected: "Success. No rows returned." Confirm by running:

```sql
select * from public.login_attempts limit 1;
```

Expected: an empty result (table exists, zero rows) — no error.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260819000000_login_attempts_table.sql
git commit -m "feat: add login_attempts rate-limit table migration"
```

---

### Task 3: Pure logic helpers with a real test

**Files:**
- Create: `supabase/functions/login-with-identifier/logic.ts`
- Test: `supabase/functions/login-with-identifier/logic.test.ts`

**Interfaces:**
- Produces: `isEmailIdentifier(identifier: string): boolean`, `GENERIC_INVALID_MESSAGE: string`, `RATE_LIMITED_MESSAGE: string` — all three imported by Task 4's `index.ts` and this task's own test.

- [ ] **Step 1: Write the failing test**

```typescript
// supabase/functions/login-with-identifier/logic.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isEmailIdentifier } from './logic.ts';

Deno.test('isEmailIdentifier - true for a string containing @', () => {
    assertEquals(isEmailIdentifier('someone@example.com'), true);
});

Deno.test('isEmailIdentifier - false for a plain username', () => {
    assertEquals(isEmailIdentifier('woogi999'), false);
});

Deno.test('isEmailIdentifier - false for an empty string', () => {
    assertEquals(isEmailIdentifier(''), false);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx supabase functions serve --no-verify-jwt --env-file /dev/null > /dev/null 2>&1 &
deno test supabase/functions/login-with-identifier/logic.test.ts
```

If `deno` isn't installed locally, install it first (https://deno.land/#installation) or run via the Supabase CLI's bundled Deno:

```bash
npx supabase --version
```

confirms the CLI (and its bundled Deno) is available; then:

```bash
deno test supabase/functions/login-with-identifier/logic.test.ts
```

Expected: FAIL — `logic.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Write the minimal implementation**

```typescript
// supabase/functions/login-with-identifier/logic.ts
export function isEmailIdentifier(identifier: string): boolean {
    return identifier.includes('@');
}

export const GENERIC_INVALID_MESSAGE = 'Invalid username or password.';
export const RATE_LIMITED_MESSAGE = 'Too many attempts. Please try again in a few minutes.';
```

- [ ] **Step 4: Run the test again and confirm it passes**

```bash
deno test supabase/functions/login-with-identifier/logic.test.ts
```

Expected: `ok | 3 passed | 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/login-with-identifier/logic.ts supabase/functions/login-with-identifier/logic.test.ts
git commit -m "feat: add pure identifier-classification logic with tests"
```

---

### Task 4: The Edge Function handler

**Files:**
- Create: `supabase/functions/login-with-identifier/index.ts`

**Interfaces:**
- Consumes: `isEmailIdentifier`, `GENERIC_INVALID_MESSAGE`, `RATE_LIMITED_MESSAGE` from `./logic.ts` (Task 3); reads `public.login_attempts` (Task 2); reads `public.profiles` and calls Supabase Auth Admin API (both already exist live).
- Produces: an HTTP endpoint responding to `POST` with `{identifier: string, password: string}`, always returning HTTP 200 with body `{ok: boolean, error?: string, session?: {access_token: string, refresh_token: string}}` (except for non-POST/non-OPTIONS methods, which return 405) — this exact shape is what Task 5 and Task 6's client code parse.

- [ ] **Step 1: Write the handler**

```typescript
// supabase/functions/login-with-identifier/index.ts
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

    // per-IP rate limit — this is the check the old RPC could never do,
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
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/login-with-identifier/index.ts
git commit -m "feat: add login-with-identifier edge function"
```

(Deployment and live verification happen together in Task 7, after the client code in Tasks 5-6 is ready to call it — deploying it alone first is harmless since nothing calls it yet, but there's no reason to verify it in isolation when Task 7's end-to-end check covers it.)

---

### Task 5: Wire `js/auth.js` to the new function

**Files:**
- Modify: `js/auth.js:198-210`

**Interfaces:**
- Consumes: Supabase Edge Function `login-with-identifier` (Task 4) via `client.functions.invoke('login-with-identifier', {body})`, returning `{ok, error, session}` as defined in Task 4.

- [ ] **Step 1: Replace the `signIn` function**

Current code (`js/auth.js:194-210`):

```javascript
// resolves a username to its account's email via a security-definer RPC
// (profiles.username is public, but auth.users.email is not - the RPC is the
// one narrow, deliberate exception). falls back to treating the identifier
// as an email directly if it contains "@".
async function signIn(identifier, password) {
    const client = await getClient();
    let email = identifier.trim();
    if (!email.includes('@')) {
        const { data: resolvedEmail, error: rpcError } = await client.rpc('email_for_username', { input_username: email });
        if (rpcError) { log.error('AUTH', 'Username lookup failed', rpcError); throw new Error('Invalid username or password.'); }
        if (!resolvedEmail) throw new Error('Invalid username or password.');
        email = resolvedEmail;
    }
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) { log.error('AUTH', 'Sign in failed', error); throw new Error('Invalid username or password.'); }
    return data;
}
```

Replace with:

```javascript
// email logins go straight to Supabase as before. username logins go
// through the login-with-identifier edge function instead of the old
// email_for_username RPC - that RPC returned the real email address to
// whoever called it, with no auth check, which meant anyone could harvest
// every user's email by calling it directly with any username. the edge
// function does the username->email lookup AND the sign-in server-side and
// only ever returns a session or a generic failure - the email itself
// never appears in any response this client (or anyone else) receives.
async function signIn(identifier, password) {
    const client = await getClient();
    const trimmed = identifier.trim();

    if (trimmed.includes('@')) {
        const { data, error } = await client.auth.signInWithPassword({ email: trimmed, password });
        if (error) { log.error('AUTH', 'Sign in failed', error); throw new Error('Invalid username or password.'); }
        return data;
    }

    const { data: result, error: fnError } = await client.functions.invoke('login-with-identifier', {
        body: { identifier: trimmed, password }
    });
    if (fnError || !result?.ok || !result?.session) {
        log.error('AUTH', 'Sign in failed', fnError || result);
        throw new Error(result?.error || 'Invalid username or password.');
    }

    const { data, error: setError } = await client.auth.setSession({
        access_token: result.session.access_token,
        refresh_token: result.session.refresh_token,
    });
    if (setError) { log.error('AUTH', 'Session hydration failed', setError); throw new Error('Invalid username or password.'); }
    return data;
}
```

- [ ] **Step 2: Manually verify in the browser (no automated test harness exists in this repo)**

1. Open the site locally or on the deployed version.
2. Open DevTools → Network tab, filter to `login-with-identifier`.
3. Log in with a **username** (not email) and correct password.
4. Confirm: login succeeds, you land signed in.
5. Inspect the `login-with-identifier` response body in the Network tab — confirm it contains only `{ok, session: {access_token, refresh_token}}` and **no `email` field anywhere**.
6. Log in with a valid username and a **wrong** password — confirm you get "Invalid username or password."
7. Log in with a **nonexistent** username — confirm you get the exact same "Invalid username or password." message (proving the response doesn't distinguish the two cases).
8. Log in with an **email** address directly — confirm this still works exactly as before (this path is unchanged).

- [ ] **Step 3: Commit**

```bash
git add js/auth.js
git commit -m "fix: route username login through login-with-identifier edge function"
```

---

### Task 6: Wire `js/admin.js` to the new function

**Files:**
- Modify: `js/admin.js:68-78`

**Interfaces:**
- Consumes: same `login-with-identifier` function and response shape as Task 5.

- [ ] **Step 1: Replace the `signIn` function**

Current code (`js/admin.js:67-78`):

```javascript
// ==================== SIGN IN / OUT ====================
async function signIn(identifier, password) {
    const client = await getClient();
    let email = identifier.trim();
    if (!email.includes('@')) {
        const { data: resolvedEmail, error: rpcError } = await client.rpc('email_for_username', { input_username: email });
        if (rpcError || !resolvedEmail) throw new Error('Invalid username or password.');
        email = resolvedEmail;
    }
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error('Invalid username or password.');
}
```

Replace with:

```javascript
// ==================== SIGN IN / OUT ====================
// see js/auth.js's signIn for why this no longer calls email_for_username
// directly - same fix, duplicated here since this file is deliberately
// standalone (see header comment above).
async function signIn(identifier, password) {
    const client = await getClient();
    const trimmed = identifier.trim();

    if (trimmed.includes('@')) {
        const { error } = await client.auth.signInWithPassword({ email: trimmed, password });
        if (error) throw new Error('Invalid username or password.');
        return;
    }

    const { data: result, error: fnError } = await client.functions.invoke('login-with-identifier', {
        body: { identifier: trimmed, password }
    });
    if (fnError || !result?.ok || !result?.session) {
        throw new Error(result?.error || 'Invalid username or password.');
    }

    const { error: setError } = await client.auth.setSession({
        access_token: result.session.access_token,
        refresh_token: result.session.refresh_token,
    });
    if (setError) throw new Error('Invalid username or password.');
}
```

- [ ] **Step 2: Manually verify in the browser**

Same checklist as Task 5 Step 2, but against `admin.html`'s sign-in form.

- [ ] **Step 3: Commit**

```bash
git add js/admin.js
git commit -m "fix: route admin panel username login through login-with-identifier edge function"
```

---

### Task 7: Deploy, verify end-to-end on the live site, then close the old hole

This is the only task that touches the live project, and it's ordered specifically so login is never broken: deploy the new path first, prove it works on the real site, only then revoke the old RPC's access.

**Files:**
- Create: `supabase/migrations/20260819000100_revoke_email_for_username.sql`

- [ ] **Step 1: Deploy the Edge Function's code**

This is the one CLI command in this whole plan that talks to your live project — and it only uploads code, the same way pushing to GitHub Pages uploads code. It cannot read, write, or reset any table.

```bash
npx supabase login
npx supabase functions deploy login-with-identifier --project-ref <your-project-ref>
```

(Your project ref is in the Supabase dashboard URL: `https://supabase.com/dashboard/project/<project-ref>`.)

Expected output: a success message with the function's URL.

- [ ] **Step 2: Push the client code changes (Tasks 5 & 6) so the live site uses the new function**

```bash
git push
```

Wait for the GitHub Pages Action (`.github/workflows/static.yml`) to finish deploying — check the Actions tab.

- [ ] **Step 3: Run the full manual verification checklist from Task 5 Step 2 against the live deployed site**

All 8 checks (username login works, response has no `email` field, wrong password fails generically, nonexistent username fails identically, email login still works).

- [ ] **Step 4: Confirm rate limiting works**

Attempt to log in with an invalid username 11 times in under 5 minutes (e.g., paste a throwaway script into the browser console calling the login form's submit handler, or just click submit rapidly). Expected: after the 10th attempt, the response switches from "Invalid username or password." to "Too many attempts. Please try again in a few minutes."

- [ ] **Step 5: Only once Steps 1-4 all pass — write the revoke migration**

```sql
-- supabase/migrations/20260819000100_revoke_email_for_username.sql
revoke execute on function public.email_for_username(text) from anon, authenticated;
```

- [ ] **Step 6: Run it yourself in the Supabase dashboard SQL editor**

Paste and run the statement above.

- [ ] **Step 7: Confirm the old hole is actually closed**

Run this in the SQL editor:

```sql
select grantee, privilege_type
from information_schema.routine_privileges
where routine_name = 'email_for_username';
```

Expected: no row for `anon` or `authenticated` anymore (a row for e.g. `postgres`/`service_role`/the function owner is fine and expected).

Then, from outside the dashboard (e.g. curl, or your browser console on any page), confirm the RPC itself now refuses the call:

```bash
curl -X POST 'https://<your-project-ref>.supabase.co/rest/v1/rpc/email_for_username' \
  -H "apikey: <your-anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"input_username": "any_username_here"}'
```

Expected: a permission-denied error, not an email address.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260819000100_revoke_email_for_username.sql
git commit -m "fix: revoke public access to email_for_username now that the safe login path is live"
```

---

## Self-Review Notes

- **Spec coverage:** Requirement 1 (no email in any response) → Task 4's response shape + Task 5/6 Step 2 checks. Requirement 2 (login UX unchanged) → Task 5/6 verification checklists. Requirement 3 (identical generic failure message) → Task 4's `GENERIC_INVALID_MESSAGE` used for both the "no such username" and "wrong password" branches, verified in Task 5/6 Step 2 items 6-7. Requirement 4 (per-IP rate limit) → Task 4's `login_attempts` check, verified in Task 7 Step 4. Requirement 5 (revoke only after cutover) → Task 7's explicit ordering. Requirement 6 (SQL under version control) → Tasks 2 and 7 both add migration files to the repo.
- **No-CLI-touches-data constraint:** every SQL statement in this plan is applied by the user pasting it into the dashboard SQL editor (Tasks 2 and 7); the only CLI-to-live-project command anywhere in the plan is the code-only `functions deploy` in Task 7 Step 1.
