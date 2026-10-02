# How the Community Hub feed works

The Community Hub's **Feed** tab mixes two kinds of things:

- **Fakémon** people publish (each one shows as a big picture card, Instagram style), and
- **posts**: text (with markdown, `#tags` and `:emojis:`) that can also show off up to 12 of the poster's published Fakémon, Tumblr style.

There are three ways to read it:

| Tab | What it shows | Order |
| --- | --- | --- |
| **For you** | everything recent, plus extra from people you follow | ranked by the algorithm below |
| **Following** | only people you follow (and you) | newest first |
| **Latest** | everything | newest first |

Following and Latest are plain, so there's always a way to see the feed without any ranking.

The code lives in:

- `supabase/migrations/20261002000000_social_feed_and_profiles.sql`, function `community_feed()`: picks the candidates.
- `js/features/feed-algorithm.ts`: scores and orders them. Pure functions, no network.
- `js/features/social.ts`: fetches, remembers what you've seen, calls the ranking.

---

## Step 0: where the ranking runs, and what it knows about you

Ranking runs **in your browser**, not on the server. The server sends a pool of candidates (step 1); your browser orders them.

Some of what it uses is about you, and it **stays on your device** (in `localStorage`). It's never uploaded:

- **seen**: how many times each card has been on your screen (counted when 60% of a card is visible for about a second, once per visit),
- **opened**: which Fakémon and posts you clicked into,
- **creator affinity**: a small score per creator that goes up when you like, react to, comment on or open their stuff, and slowly fades (every new interaction shrinks all the old ones by 2%),
- **your own types**: what share of *your own* Fakémon have each type (read from your collection, which is already on your device).

Who you follow is the one input that is on the server (it has to be, since other people can see your followers).

## Step 1: the candidate pool (server)

`community_feed()` returns, minus anyone you've blocked or who blocked you:

1. the **100 most recently active** published Fakémon ("active" means published, liked or commented on),
2. the **100 most recently active** posts,
3. up to **40 Fakémon and 40 posts from people you follow** from the last 30 days, even if they weren't in 1 or 2.

For "For you" it asks for 120 of each instead of 100. Each row comes with its counts already attached (likes, comments, views, reactions, and whether you liked/reacted), so ranking needs no more requests.

Why the pool is small: the hub is a few hundred items, and sending a slim row for each is cheap (no images; pictures load only as cards scroll into view). If the hub grows a lot, the pool stays the same size and just covers a shorter, more recent window.

## Step 2: a quality score, with diminishing returns

Every item gets an **engagement** number:

```
engagement = likes × 1 + reactions × 1 + comments × 3 + views × 0.02
```

Comments count triple because writing one takes more effort than tapping a heart. Views count very little because opening something isn't the same as liking it.

Then:

```
quality = (1 + engagement) ^ 0.8
```

The `^ 0.8` means each extra like is worth a bit less than the one before. Going from 0 to 10 likes matters a lot; going from 200 to 210 barely does. That stops one viral post from burying everything else.

## Step 3: age (gravity)

Newer things should be higher, but a great post from yesterday should still beat a dull one from a minute ago. So quality is divided by age, the way Hacker News does it:

```
decayed = quality / (age_in_hours + 2) ^ 1.4
```

- The `+ 2` stops a brand new item from being divided by almost nothing (which would rocket everything new to the top).
- `1.4` is the "gravity". Higher means the feed churns faster.

Rough feel for it: something posted a day ago needs about **3× the engagement** of something posted 12 hours ago to rank level with it, brand new things get a strong head start for their first few hours, and things older than a few days sink unless people are still talking about them...

**...which is the "revived" bonus.** If an older item got a comment or reaction recently, it gets a boost that halves every 12 hours since that activity:

```
revived = 0.35 × quality × 0.5 ^ (hours_since_activity / 12) / 26 ^ 1.4
```

So a conversation can bring an older post back up for a while, without it taking over.

```
base_score = decayed + revived
```

## Step 4: personal multipliers

`base_score` is the same for everybody. Then it's multiplied by things about you:

| Signal | Multiplier | Why |
| --- | --- | --- |
| you follow the creator | × 1.8 | you asked to see them |
| it's your own | × 0.6 | you know what you posted; it still shows, just lower |
| creator affinity | × (1 + 0.15 per interaction), max × 1.8 | you keep engaging with them |
| a Fakémon in types you make a lot | up to × 1.3 | if half your collection is Fire, Fire Fakémon get the full boost |
| a post that shows off Fakémon | × 1.15 | the hub is about Fakémon |
| a text-only post under 20 characters | × 0.8 | "lol" shouldn't outrank someone's region reveal |
| already seen it *n* times | × 0.75ⁿ, never below × 0.25 | so the feed changes as you scroll it day to day |
| you already opened it | × 0.5 | you've seen it properly |
| "new voice": the creator's only item in the pool, under 2 days old | × 1.25 | gives newcomers a chance to be noticed |
| a little randomness | × 0.9 to × 1.1 | see below |

**The randomness** is seeded by *you + the date + the item*, so:

- refreshing the page doesn't reshuffle everything (same seed all day),
- two people see slightly different orders,
- tomorrow the order shifts a little, which gives items near the cut-off a turn at the top.

## Step 5: variety

Sorting by score alone can put five things from one prolific creator in a row. So the final order is picked one item at a time, greedily, always taking the best item **after** these penalties:

- **same creator again**: × 0.65 for each item by them already among the last 12 picked,
- **third in a row of the same kind**: × 0.85 if the last two were both Fakémon (or both posts).

Nothing is removed by this step; it only changes the order. The order is worked out once per load and then kept while you scroll, so cards never jump around under your thumb.

## Step 6: scrolling

The feed shows 12 cards at a time and adds 12 more as you near the bottom. At the end of "For you" there's a **"You're all caught up!"** with a button to pull in older items, which are ranked among themselves and added below. Following and Latest just keep loading older items as you scroll.

---

## The numbers, in one place

All of them are in `WEIGHTS` at the top of `js/features/feed-algorithm.ts`:

| Name | Value | Meaning |
| --- | --- | --- |
| `like`, `reaction` | 1 | engagement per like / reaction |
| `comment` | 3 | engagement per comment |
| `view` | 0.02 | engagement per view |
| `engagementPower` | 0.8 | diminishing returns |
| `gravity` | 1.4 | how fast age pulls scores down |
| `ageOffsetHours` | 2 | keeps brand-new items from exploding |
| `activityBoost` | 0.35 | strength of the "revived" bonus |
| `activityHalfLifeHours` | 12 | how fast that bonus fades |
| `followed` | 1.8 | people you follow |
| `ownPost` | 0.6 | your own things |
| `affinityPerInteraction` / `affinityCap` | 0.15 / 0.8 | creator affinity |
| `typeMatch` | 0.3 | max boost for types you make |
| `seenDecay` / `seenFloor` | 0.75 / 0.25 | already-seen penalty |
| `opened` | 0.5 | already-opened penalty |
| `withMons` | 1.15 | posts with Fakémon attached |
| `tinyText` | 0.8 | very short text-only posts |
| `newVoice` | 1.25 | newcomer boost |
| `jitter` | 0.1 | ±10% randomness |
| `authorRepeat` | 0.65 | variety: same creator again |
| `kindStreak` | 0.85 | variety: three of a kind in a row |
| `diversityWindow` | 12 | how far back "again" looks |

## Tuning tips

- **Feed feels stale?** Raise `gravity` (try 1.6) or lower `seenDecay` (try 0.6).
- **Big creators dominate?** Lower `engagementPower` (try 0.7) or `authorRepeat` (try 0.5).
- **Following matters too little?** Raise `followed`.
- **Too random?** Lower `jitter`. At 0 the feed is fully deterministic.

Because everything is in one pure function, `rankFeed(items, viewer)` can be run on a saved pool in a test or the browser console to see how a change would reorder things. `explainFeedItem(item)` in `js/features/social.ts` returns the breakdown (`quality`, `ageHours`, `followed`, `seen`, `jitter`...) for a single item.

## What it deliberately doesn't do

- **No hidden server-side profile of you.** The personal parts live on your device and you can wipe them by clearing the site's data.
- **No hiding things for being unpopular.** Low scores sink, but everything in the pool still appears, and Latest shows everything in order.
- **No paid or promoted placement.**
