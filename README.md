<img width="1019" height="343" alt="woogidex_icon" src="https://github.com/user-attachments/assets/babf850a-8043-41d5-aece-380676c3a56e" />

A browser-based toolkit for making, sharing, and battling with Fakemon.

I started this because I wanted one place to actually **design a Fakemon from start to finish**, instead of bouncing between a bunch of different tools. It's grown a fair bit since then.

## What is Woogidex?

Woogidex is a Fakemon editor, Pokédex builder, and community hub.

You make a Pokémon: stats, typing, abilities, moves, Dex entries, artwork, the works. It gets turned into a Pokédex-style board you can export or share. From there you can publish it to the Community Hub, connect it into an evolution line, or even battle it against someone else's team in real time.

It's primarily something I made to help organize my own Fakemon work and Pokeathlon contest submissions, but it's meant to be a general-purpose tool for anyone making Fakemon.

## Features

**Editor**
- Stats, BST, typing, abilities, egg groups, gender ratios, height and weight
- Learnset editor with move recommendations
- Custom moves, abilities, and items, including a visual (Scratch-style) block editor for writing their actual battle effects
- Evolution lines, with methods and connected learnsets
- Sample competitive set generator
- Type matchup / bulk comparison analysis tab
- Shiny artwork, cries, and art credit
- PNG, plain text, JSON, Pokémon Showdown, and Pokémon Essentials export
- A name generator for when you're stuck

**Community**
- Publish Fakemon (and whole evolution families) to a public Community Hub
- Likes, comments, and view counts
- Public profiles with their own comment wall
- Events and contests, with staff-run voting
- A moderation system: banned-word filtering, warnings, mutes, and staff tools

**Battle**
- A real Pokémon-style battle simulator, including a fair amount of Showdown's move/ability/item data
- Battle a bot, or battle another player live over the Community Hub's lobby

**Accounts**
- Free account, needed for the Community Hub and battling
- Your Fakemon collection itself stays local to your browser (IndexedDB) either way

## Sample Set Generator

Woogidex looks at a Fakemon's actual data and tries to build a sensible competitive set for it; base stats, typing, abilities, available moves, STAB, coverage, setup, recovery, priority, hazards, and so on, then scores it against roles like Physical Sweeper, Wallbreaker, Bulky Attacker, Support, Pivot, Hazard Setter, and builds a set around whichever fits best.

It's not perfect, but it's a genuinely useful starting point.

## Local-first Collection, Optional Account

Your Fakemon collection lives in your browser via IndexedDB; no account needed just to design and export Fakemon. You can also export as JSON or plain text to back things up or move them elsewhere.

An account is only needed once you want to publish to the Community Hub, comment, or battle other players.

## Tech

Currently built with:

- HTML / CSS / JavaScript, mostly vanilla
- Vite for bundling, and Node for the build and the test suite
- React, for individual pieces of UI rather than the whole app (see below)
- IndexedDB for local storage
- Supabase for accounts, the Community Hub, and multiplayer battles
- html2canvas for PNG export, JSZip for zipped exports, three.js for the 3D battle field

There is no server of our own. Supabase is the backend, and the site itself is
static files on GitHub Pages.

### Running it

    npm install
    npm run dev         # dev server with hot reload
    npm test            # the whole suite
    npm run test:smoke  # builds, then loads the site in a real browser
    npm run build       # writes dist/

**`npm run dev` is the only way to run it locally now.** There is a build step,
so the two things that used to work no longer can:

- opening `index.html` off disk
- serving the repo folder with a plain static server (Live Server,
  `python -m http.server`, and so on)

Both leave you with an unstyled shell, because the code imports packages by
name and something has to resolve them. If it happens anyway, the page will
tell you so rather than sitting there blank.

### Layout

    index.html      the shell: header, sidebar, modals, and one empty
                    placeholder div per page
    public/         copied to the root of the build as-is
      views/        one HTML fragment per page (editor, collection,
                    community, events, battle, profile). Fetched at boot,
                    parsed into the DOM before anything reads it.
                    See js/core/views.js.
      assets/       images
      updates.txt   the Updates tab reads this at runtime
    css/            one stylesheet per area, linked from index.html in
                    cascade order. That order is load-bearing: the theme-*
                    files at the end restyle classes defined above them.
                    Pinned by js/css-order.test.mjs.
    js/             ES modules. Most assign their exports onto window,
                    which is what lets the inline onclick handlers in the
                    HTML keep working.
      react/        React components and the code that mounts them.
    dist/           the build output. Not in git; CI rebuilds it.

### React, a piece at a time

The site is ~35,000 lines of vanilla modules that own the DOM directly, plus a
few hundred inline `onclick` handlers in the HTML. Rewriting all of that at once
would mean re-testing the battle sim, the editor and the Community Hub
simultaneously, so React is going in as **islands**: one self-contained piece of
UI at a time gets a React root, everything around it stays as it was, and the
two talk through the same globals as before.

The rules that keep that safe are in js/react/island.jsx. The short version:

- an island owns its subtree and nothing outside React may write into it
- pages are mounted by assigning innerHTML, so an island inside a page has to
  mount through `onViewMounted()`, not at import time
- icons inside React go through `<Icon>`, never `lucide.createIcons()` -- that
  function *replaces* the element it finds, which is not something to do to a
  node React believes it owns

Converted so far, in the order they were done:

| Island | What it replaced |
|---|---|
| Updates panel | an inline copy of the updates system in index.html |
| Ability block palette + board | five mutually recursive string builders, ~2,300 lines |
| Community Hub feed and comments | one template literal per card, re-observed on every render |
| Moderation panel | the densest `innerHTML` in the repo, showing untrusted text to staff |
| Profile gallery, comments, badges, hover card | hand-escaped rows and hand-written skeletons |
| Editor abilities + learnset | index-in-attribute handlers, and one unescaped move name |
| Battle controls | a chain of early returns that also built HTML |

A pattern runs through all of them: the part of each renderer that was a
*decision* rather than markup came out into a plain module beside it -- which
events a palette offers, how the hub sorts, which moderation buttons a rank
allows, which ability slot is Hidden, which pane the battle controls show. Those
are the files ending in `-model.js`, and they are where most of the new tests
live, because they can be checked without rendering anything at all.

The battle controls were left until last on purpose. The 3D field sits beside
them, and a repaint that reaches too far tears down its canvas -- so that island
is mounted into `#battle-controls` and nothing else.

### URLs

Pages have real paths -- `/community/12`, `/profile/woogi`, `/editor/abc` --
rather than `#hashes`. Two pieces make that work on a static host: a generated
`404.html`, which GitHub Pages serves for any path that is not a file, and an
inline script in index.html that fixes up `<base href>` before anything relative
loads, so URLs still resolve when the document is served from a deeper path than
the one it lives at. Old `#hash` links are rewritten to their new path on
arrival, so anything shared before the change still opens. See js/core/router.js.

`404.html` is emitted by the build as a copy of the *built* index.html, so the
two cannot drift. Nothing to run by hand.

`npm test` runs the whole suite, including the checks that keep the css/ and
views/ manifests honest, the 404 fallback wired up, and every library a pinned
dependency rather than a CDN URL.

### The Supabase proxy

`worker/index.js` forwards `dex.woogi.xyz/sb/*` to the Supabase project, and
`js/core/supabase.js` can point the client at that path instead of the project
host. The reason is that Cloudflare can only inspect traffic that reaches
Cloudflare: a browser talking to `*.supabase.co` directly never passes through
this zone's WAF, bot rules or rate limiting rules, so those rules were only ever
guarding the static files -- the one part of the site nobody can abuse.

It is off until the Worker is confirmed live (`USE_SAME_ORIGIN_PROXY` in
js/core/supabase.js). `vite.config.js` proxies `/sb` in both dev and preview, so
the switch behaves the same locally as it does deployed.

`run_worker_first` in wrangler.jsonc keeps the Worker on `/sb/*` only; every
other path is served straight from the asset store without running a Worker.

### Applying the RLS init-plan migration

`supabase/migrations/20260901000002_perf_rls_initplan.sql` is the one migration
in this repo that has not been applied. It rewrites 50 row-level security
policies, which is the kind of change worth running by hand and watching.

It is a performance change only. Every expression in it was generated from
`pg_policies` and is the policy that is already in place, with `auth.uid()` and
the staff helpers hoisted into scalar subqueries so Postgres evaluates them once
per statement instead of once per row. Nothing in it grants or revokes access.

Before running it, note the count you expect to go to zero. Postgres re-renders
a stored policy as `( SELECT auth.uid() AS uid)` -- uppercase `SELECT`, a space
after the paren, an added alias -- so the check has to be case-insensitive
(`!~*`), not a literal match of what you pasted in:

```sql
select count(*) from pg_policies
where schemaname = 'public'
  and (coalesce(qual,'') || coalesce(with_check,'')) ~ 'auth\.uid\(\)'
  and (coalesce(qual,'') || coalesce(with_check,'')) !~* '\(\s*select\s+auth\.uid';
-- 50 before, 0 after
```

Paste the file into the Supabase SQL Editor and run it. It is a single
transaction; either all 54 `ALTER POLICY` statements land or none do.

Afterwards, check the count above is 0, then check the policies still say what
they used to. This compares every policy against the pre-change snapshot with
the subquery wrappers stripped back out, and should return no rows:

```sql
select b.tablename, b.policyname
from perf_backup.rls_before_20260901 b
join pg_policies p
  on p.schemaname = 'public'
 and p.tablename = b.tablename
 and p.policyname = b.policyname
where replace(replace(coalesce(p.qual,''), '(select ', ''), '))', ')')
      is distinct from replace(replace(coalesce(b.qual,''), '(select ', ''), '))', ')')
   or replace(replace(coalesce(p.with_check,''), '(select ', ''), '))', ')')
      is distinct from replace(replace(coalesce(b.with_check,''), '(select ', ''), '))', ')');
```

That is a rough normalisation, so a row coming back is a prompt to read that
policy rather than proof of a problem. The real test is the site: sign in, open
the Community Hub, like something, comment, open a profile. If a policy had been
narrowed by mistake, rows would vanish from the hub immediately.

**Rollback.** `perf_backup.rls_before_20260901` holds all 56 policies as they
stood beforehand. To restore one:

```sql
select format('alter policy %I on public.%I%s%s;', policyname, tablename,
              case when qual is not null then ' using (' || qual || ')' else '' end,
              case when with_check is not null then ' with check (' || with_check || ')' else '' end)
from perf_backup.rls_before_20260901
where policyname = '...';
```

Run what that prints. Drop the whole backup schema once the change has been
running happily for a while: `drop schema perf_backup cascade;`

### The `collections` table

17 MB across 8 rows, and nothing in this repo reads or writes it. It is the old
cloud-sync store from before the collection became local-first (IndexedDB, see
js/core/storage.js). It is pure storage cost today, but it is also the only
server-side copy of those eight collections, so it has deliberately not been
dropped.

## Status

Still very much a **work in progress**. Things will probably break, things will probably get redesigned, some systems (looking at you, battle sim) are still being actively fought with.

I'm mostly building this because it's fun, but it's up on GitHub in case anyone else finds it useful or wants to poke around the code.

## Contributing

Found something broken, or have an idea? Open an issue or a PR.

Have fun making weird Pokémon. :3
