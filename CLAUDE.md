# Steady — context brief for Claude Code

This file exists so you (Claude Code, working in this repo locally) don't have
to rediscover any of the decisions already made. Read this fully before
touching code.

## What Steady is

A personal spaced-repetition tool. The user logs topics they've studied;
Steady schedules when to revise them next using the SM-2 algorithm, and
pushes the due-today revisions into Todoist so notifications actually work
(their previous tracking approach had unreliable notifications — Todoist is
the fix, since they already live in it daily).

## Why this stack

- **Cloudflare Workers + D1**: the user already runs another project on
  Cloudflare, so this stays in a stack they know.
- **Single Worker serving both frontend and API**: originally the plan was
  Cloudflare Pages (frontend) + a separate Worker (API), wired together via
  GitHub auto-deploy. That was simplified to one Worker with a static assets
  binding (`[assets]` in `wrangler.toml`, serving `/public`) plus `/api/*`
  routes in the same `fetch` handler. Reasons: fewer moving parts, no GitHub
  App / Pages project to configure, still one `wrangler deploy` away from
  live. Pages + git auto-deploy is a valid follow-up, not a correction of a
  mistake.
- **Todoist API** (`https://api.todoist.com/api/v1/`), called directly from
  the Worker's `scheduled` handler (daily cron), not through a middleman.
  **This was `/rest/v2/` until 2026-07-14** — Todoist fully decommissioned
  REST v2 (confirmed: it now returns `410 Gone`), which meant the entire
  Todoist integration had been silently broken from the moment
  `TODOIST_API_TOKEN` was first set, since `pushToTodoist` **used to**
  swallow failures into a `console.error` rather than surfacing them (fixed
  the same day the `sync_log`/health-check system below was built —
  `pushToTodoist` now throws on a non-OK Todoist response instead of
  swallowing it, specifically so this exact failure mode gets caught by the
  health-check rather than repeating itself silently). Found by actually
  triggering a real push against the real API with the real token — this is
  exactly the kind of failure that stays invisible until someone tests the
  real thing, not just the code around it. The migration also **silently
  changed the projects-list response shape** from a bare array to
  `{ results: [...] }` (pagination wrapper) — task creation's response was
  *not* similarly wrapped, so don't assume every endpoint moved the same
  way if this needs touching again; verify each shape directly.
  The Worker needs its own `TODOIST_API_TOKEN` secret, set via
  `wrangler secret put TODOIST_API_TOKEN` — an AI agent should never handle
  or type a live API token (or any other credential/secret) on someone's
  behalf, so don't offer to do this part for the user even if asked. Same
  principle applies to Basic Auth credentials
  (see below): generate/suggest values if helpful, but the user runs
  `wrangler secret put` themselves.

## Current state of this repo

Deployed and working: topic CRUD, SM-2 review scoring, archiving, stats,
and the Todoist push have all been exercised against a real D1 instance and
a real Todoist project (not just a first draft anymore).

- `worker/index.js` — routes for topics (CRUD-ish) and reviews, SM-2+
  scheduling math, a hierarchical **categories** system (see "Categories"
  below), a `GET /api/calendar?month=YYYY-MM` route (due topics grouped by
  day, for the calendar view), a `scheduled()` handler that pushes due
  topics to Todoist (per-topic `pushToTodoist` failures are caught
  individually so one bad topic doesn't stop the rest of the daily batch),
  a **sync health-check** (`sync_log` table + `runOperation` wrapper +
  `GET /api/sync-status`, surfaced in the UI as a "Last sync: N pushed, N
  failed" line) so a cron-side failure shows up somewhere a human will
  actually see it instead of only in the Worker's own logs — this is a
  direct response to the REST v2 incident above, which was invisible for
  an unknown stretch of time for exactly this reason. Every cron-driven
  Todoist operation (the daily push, and any future ones) must call
  through `runOperation` so it always produces exactly one `sync_log` row,
  success or failure — a cron function that doesn't do this is invisible
  again by construction. `runDailyPush` itself no longer swallows anything;
  it returns `{succeeded, failed}` and `pushToTodoist` throws on failure
  rather than logging-and-returning, so a failed push is actually counted,
  not silently treated as a success by the caller's `try/catch`. Also a
  Basic Auth gate (`checkAuth`, constant-time comparison via HMAC) in front
  of every route. The auth gate is inert until
  `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` secrets are set.
- `schema.sql` — four tables: `topics` (includes `todoist_project_id` for
  per-topic Todoist destination overrides, and `category_id`), `reviews`
  (also carries `repetitions_before`/`next_due_before`/`last_reviewed_before`,
  nullable — a full pre-review snapshot that makes `POST
  /api/topics/:id/undo-review` a mechanical restore-and-delete rather than
  a recomputation; `NULL` on a row means "recorded before undo support
  existed," which the undo route uses to 400 cleanly on old reviews rather
  than guessing), `categories` (self-referential `parent_id`, arbitrary
  depth), and `sync_log` (one row per cron-driven Todoist operation per
  run — see the health-check note above).
- `public/index.html` — single-file frontend (vanilla JS, no build step).
  **"Gold Leaf" aesthetic** (as of 2026-07-14, replacing an earlier
  sage-green/gold/`DM Serif Display` theme that the user found generic
  despite being vibrant — see [[feedback-aesthetic-not-bleak]] for why
  "vibrant" alone wasn't the fix): warm near-black background (`#150f04`),
  a rich saturated gold accent (`#f0b429`), `Fraunces` for the wordmark
  (soft, glowing, not gradient-clipped), `Manrope` for body text. The
  governing rule is **glow is earned, not blanket** — panels are flat
  (`var(--panel)`, no per-panel gradients), and emphasis is spent only on
  what's actually due: a topic due **today** gets a whole-row gold glow: a
  topic that's **overdue** gets a whole-row glow in the danger hue (coral
  `#e8623f`) *plus* its due-badge becomes a glowing ringed circle showing a
  signed day-count (`−3d`, not the word "overdue"); **upcoming** topics stay
  plain with a dim `+Nd` badge. The same "wide range, glow only at the top"
  idea drives the 28-day activity **heatmap** and the calendar's due-count
  tiers. The wordmark has a blinking block cursor (`Steady▊`, borrowed from
  a terminal-styled direction that was explored and dropped in favor of
  this one), and a **rotating motivational line** renders under the heatmap
  — one of 30 aphorisms about the nature of revision/memory itself (never
  addressed at the user directly, never "don't break it" framing; see
  `REVISION_QUOTES` + `dailyQuote()`), picked deterministically by hashing
  `todayISO()` so it's stable all day and changes tomorrow. Also: a
  **clickable** forward-looking calendar panel (clicking a due day opens an
  inline detail panel listing what's due, with quality-rating buttons to
  review directly from the calendar for today/overdue days), a Todoist
  project picker and category picker in the add-topic form — both now
  showing Todoist's real project/sub-project hierarchy indented by depth,
  not a flat API-order list (`buildProjectTree`/`projectOptionsHtml`,
  mirroring `buildCategoryTree`'s pre-order-with-depth shape) — a
  collapsed-by-default category manager panel, a topic list grouped by
  category when any category exists (exact flat list otherwise — zero
  visible change for anyone who hasn't used the feature), an archive
  button, and a "pushed to Todoist" indicator dot. Every design decision
  here (including the four palette variants considered before landing on
  Gold Leaf, and the four other full directions explored and rejected —
  a nautical-instrument theme, a terminal/monospace theme, a graph-paper
  notebook theme, and a brutalist poster theme) was reviewed by the user
  against real rendered mockups, not descriptions — text descriptions of a
  palette aren't sufficient for a design decision like this one. Works
  standalone via `localStorage` if `/api/*` calls fail.
- `wrangler.toml` — cron is `30 23 * * *` (23:30 UTC), tuned for the user's
  timezone so revisions land in Todoist before their day starts, not at
  midday. Don't assume this offset is right if the user's timezone changes.

## Timezone handling — read this before touching any date logic

This is a single-user app and that user is on **IST (UTC+5:30, no DST)**.
Nothing in this app should ever compute "today" from raw UTC — between
midnight and 5:30am IST, raw UTC is still on *yesterday's* date, which was
a real, user-reported bug (the app didn't realize it was already a new day).
The fix touches **two different layers**, both of which matter:

- **JS**: use `nowIST()` (`new Date(Date.now() + 5.5*60*60*1000)`), never
  bare `new Date()`, anywhere "today" or date arithmetic is computed. Both
  `worker/index.js` and `public/index.html` have their own copy of this
  helper (same dual-implementation pattern as the scheduling math).
- **SQL**: SQLite's `date()`/`datetime()` functions have no timezone
  concept — `date(reviewed_at)` extracts the *raw UTC* calendar date from a
  stored timestamp. This bit us in `GET /api/stats`: reviews genuinely done
  in the early hours of IST "tomorrow" were grouped under UTC "today"
  instead, silently out of step with the IST-anchored day list right next
  to it. Fix: `date(reviewed_at, '+330 minutes')` (330 minutes = 5.5 hours).
  Any new SQL that buckets rows by calendar day needs this same adjustment
  — it's easy to add a query later and forget, since the JS-side fix alone
  looks complete.

If the user's timezone ever changes, the offset constant needs updating in
three places: the JS `IST_OFFSET_MS`/`nowIST()` in both files, any SQL
`+330 minutes` literals, and the cron schedule in `wrangler.toml`.

## SM-2 as implemented (+ elapsed-time correction on 3rd+ reviews)

Standard SM-2, 0–5 quality rating per review:

- `quality < 3` → repetitions reset to 0, interval → 1 day (review again
  tomorrow), but EF still updates (per the original SM-2 spec, failures
  still adjust easiness).
- `quality >= 3` → repetitions += 1. First rep → interval 1 day. Second rep
  → interval 6 days.
- `EF = EF + (0.1 - (5-q)*(0.08+(5-q)*0.02))`, floored at 1.3.

**Third-plus successful review is not pure SM-2.** Plain SM-2 assumes every
review happens exactly on schedule — reviewing early or late has zero
effect, which was the whole reason this changed. FSRS was considered and
rejected (it needs large, same-distribution review data to calibrate;
Steady's low-volume, topic-level usage will never look like the
flashcard-drilling corpus FSRS's defaults were fit on). SuperMemo SM-5 was
also considered — its core mechanism is real and sourced, but the
cross-item pooling matrix it needs (E-Factor bucket boundaries, a
convergence `fraction`, matrix dimensions) was never published by Wozniak
anywhere accessible (checked SM-5's own page, the cross-version algorithm
overview, the OF-matrix-introduction blog post, SuperMemopedia, and an
attempt at the original 1994 paper — genuine dead end, not a gap in
searching).

The resolution: SuperMemo **SM-4**'s per-observation formula is fully
published on its own with no missing constants —
`OI' = interval + interval*(1-1/EF)/2*(0.25*q-1)` (Wozniak,
super-memory.com/english/ol/sm4.htm) — where `interval` is the *actual*
elapsed days since the last review. What's unsourceable is only the
cross-item matrix SM-5 layers on top to smooth that formula's output across
many items; SM-4's own spec says that matrix's seed value is
`OI(n,EF) = OI(n-1,EF)*EF`, which is exactly vanilla SM-2's own growth
formula. So: apply SM-4's real formula directly against each topic's own
prior state (no shared matrix, no bucket boundaries needed), blended with
SM-2's own prediction via Wozniak's own published blending structure
(`(1-fraction)*old + fraction*new`):

```js
const naive = interval_days * ef;                              // SM-2's own prediction / SM-4's matrix seed
const oiPrime = elapsedDays + elapsedDays*(1-1/ef)/2*(0.25*quality-1); // SM-4's formula, verbatim
const FRACTION = 0.3; // Wozniak leaves this in (0,1) with no published default — chosen
                       // conservatively since a single review has no cross-item pooling to smooth it
const blended = (1 - FRACTION) * naive + FRACTION * oiPrime;
interval_days = Math.max(interval_days, Math.round(blended)); // success must never shrink the schedule
```

The `Math.max` floor is load-bearing, not decorative — without it, a
same-day repeat review can blend to *below* the currently-scheduled
interval even on success (verified by hand: prev interval 6, EF 1.3,
elapsed 0 → blended ≈5.46, which would regress the schedule). Hand-verified
reference (prev interval 6, EF 1.3, quality 3): on-time (elapsed=6) → 7
days; early (elapsed=3) → 6 days; late (elapsed=12) → 9 days.

This lives in both `worker/index.js` (server-side, source of truth) and
duplicated in `public/index.html` (client-side, only used in the
localStorage fallback mode). If you change the algorithm — or the
`FRACTION` constant — change it in both places or note the drift.

## Categories (hierarchical structure)

Topics can optionally belong to a `categories` tree — **arbitrary depth**
via a self-referential `parent_id`, not a fixed Project/Subject/Subsection
schema, because the user's real Todoist organization goes 4+ levels deep
and irregularly (e.g. "Studying" > "Block A (60 mins)" > "Coding and DSA" >
"Bari C++ — Part 1"). Categorization is **opt-in per topic** — a topic
with no `category_id` behaves exactly as it did before this feature
existed, and the topic list renders as a plain flat list (no stray
"Uncategorized" header) until at least one category is ever created.

**Todoist project resolution** (in `pushToTodoist` via
`resolveTodoistProjectId`) walks up the category chain: a topic's own
`todoist_project_id` override wins outright; otherwise its category's own
override; otherwise the nearest ancestor category with one set; otherwise
the global `env.TODOIST_PROJECT_ID` default. This is a plain JS loop over
`parent_id` (bounded by a `seen` set), not a recursive SQL CTE — this
codebase consistently picks the boring/verifiable option over the clever
one (see the SM-2 derivation above and the constant-time auth compare), and
the performance case for one-query-instead-of-N doesn't matter at this
app's scale (once per due topic, once per day, against a tree a few levels
deep).

**Category deletion is a safe, blocked archive, never a cascade** —
`DELETE /api/categories/:id` returns 400 if the category still has active
child categories or active topics, naming whichever is nonzero. This
mirrors topics' own never-hard-delete posture. A **cycle guard**
(`wouldCreateCycle`, same bounded-walk idiom as Todoist resolution) blocks
reparenting a category into its own subtree — required regardless of D1's
FK enforcement, since foreign keys check existence, not acyclicity.

**Migration gotcha**: this repo has no migrations mechanism —
`schema.sql` is only ever applied as `CREATE TABLE/INDEX IF NOT EXISTS`, so
adding `topics.category_id` to an already-live database needs a one-off,
manual sequence, in this exact order (categories table must exist first,
since the new column's `REFERENCES` target must already exist):
```
wrangler d1 execute steady --local  --file=./schema.sql
wrangler d1 execute steady --local  --command "ALTER TABLE topics ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;"
wrangler d1 execute steady --local  --command "CREATE INDEX IF NOT EXISTS idx_topics_category_id ON topics(category_id);"
```
...then the same three with `--remote`. D1 enforces SQLite foreign keys by
default (confirmed empirically: `PRAGMA foreign_keys` returns `1`, and an
insert with a bogus `category_id` is rejected) — worth remembering before
any future schema change that isn't a simple `ADD COLUMN`.

**Not built in this pass, by deliberate scope decision**: there's no UI to
change an *existing* topic's category after creation (the backend route
`POST /api/topics/:id/category` and the frontend `setTopicCategory()` exist
and work, just have no button wired to them yet) — consistent with the
existing open question below about richer topic editing in general.
Categorization is settable at creation time and via the category
manager's own rename/reparent, which covers the common case.

There are now **three** places `worker/index.js` and `public/index.html`
must be kept in sync by hand, not two: `nowIST()`/the timezone offset, the
SM-2 elapsed-time correction, and the category safe-archive guard
(`archiveCategory`'s local-mode duplicate of the server's active-children/
active-topics check).

## Deployment

Live as a single Cloudflare Worker (D1-backed, static assets served from
`/public`). Real database and Todoist project IDs live only in the user's
own `wrangler.toml`/Cloudflare account, not in this repo's history — treat
`wrangler.toml` placeholders as needing real values filled in locally before
deploy, and don't hardcode live resource IDs back into this file.

Redeploy with `wrangler deploy` any time after code changes.

## Open decisions / things to ask about, don't assume

- Whether the `revision` label is the one the user wants, or if they already
  have a naming convention in Todoist for this kind of thing.
- Whether topics need richer editing beyond archiving (currently DELETE just
  sets `archived = 1`). `POST /api/topics/:id/category` narrowly answers
  "can a topic's category be changed after creation" (yes, via the API) but
  deliberately doesn't touch this broader question — general title/notes
  editing and a UI trigger for the category route are still both open.
- The original v1 design (navy/amber, GitHub-aesthetic) exists conceptually
  but was superseded by v2 — no need to resurrect it unless asked.
