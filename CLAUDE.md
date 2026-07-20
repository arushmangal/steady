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

## Installable PWA

`public/manifest.json` + `public/sw.js` + `public/icons/icon-{192,512,180}.png`
make Steady installable (phone home screen / desktop standalone window).
The service worker is installability-only — a bare install/activate/fetch
handler, no caching strategy — since the existing `localStorage` fallback
already covers real offline data resilience; adding a caching layer on top
would be solving an already-solved problem. Icons were generated by
rendering a small HTML page (reusing the real wordmark treatment — Fraunces,
gold-on-`--bg`, the same soft text-glow as the real `<h1>`) and
screenshotting it at each target size with Playwright, since no
image-generation tool is available and there's no resize library to make
one render serve three sizes crisply. `manifest.json`/`sw.js`/icons need no
Worker changes — they're plain static files already served by the existing
`env.ASSETS.fetch(request)` fallback.

**Known, non-blocking interaction with Basic Auth**: when
`BASIC_AUTH_USER`/`PASS` are set, they gate every non-`/api/*` request,
including `manifest.json`/`sw.js`/icons — so a freshly-launched installed
PWA with no warm browser session hits the native Basic Auth prompt, same as
a fresh browser tab would. Inherent to gating the whole app this way, not a
bug in this feature.

## Trajectory insight (per-topic, plain-language)

Each topic in `GET /api/topics` carries a `trajectory_note` — a short,
rule-based sentence about its recent review history (`classifyTrajectory()`
in `worker/index.js`), e.g. "Rock solid — 5 clean reviews in a row" or
"You've struggled with this one recently." Deliberately **not** a chart or
raw EF numbers — the user asked for a plain-language read, not a technical
one — and deliberately **not** an LLM call, which would be a disproportionate
architectural addition for a pure function over an array of past 0-5
ratings. Returns `null` (renders nothing) below 3 recorded reviews, since
with 1-2 data points any trend claim is noise — same "invisible until
earned" restraint already used for category headers. Rendered in
`public/index.html` as `.topic-insight`, styled dim/italic and deliberately
**not** in Caveat — Caveat stays reserved for the one handwritten touch (the
rotating daily quote); reusing it per-topic on every row would dilute that
into a recurring decoration instead of a singular one.

**Local/offline mode does not currently compute this** — `localTopics`
entries never get a `trajectory_note`, so it silently renders nothing
offline rather than duplicating the classifier. This was a deliberate
scope cut (not an oversight): local mode's `reviewLog` only stores bare
date strings for the heatmap, with no quality value per entry, so there's
nothing to classify from today. Extending this would mean changing
`reviewLog` entries to `{date, quality}` objects going forward (with a
defensive normalizer everywhere `reviewLog` is read, so already-saved
localStorage data doesn't break) and would make `classifyTrajectory()` a
fourth hand-synced pair between the two files, alongside `nowIST()`, the
SM-2 elapsed-time correction, and the category safe-archive guard.

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
deep). Because the topic-level override wins outright, picking a project at
add-time that differs from what a topic's category resolves to (e.g.
explicitly choosing Inbox for a topic filed under a category with its own
override) always lands on the explicit choice, not the category's — the
category chain is only ever consulted when the topic has no override of
its own.

**As of 2026-07-20, this override is editable after creation, not just at
add-time** — `POST /api/topics/:id/project { todoist_project_id }` (send
`null`/omit to clear it back to inheriting from the category chain), mirrors
`/api/topics/:id/category`'s shape exactly, and unlike that route, this one
*does* have a UI trigger: clicking the small "→ ProjectName" / "Set Todoist
project override" hint under a topic's meta line (`renderProjectEdit` in
`public/index.html`) opens an inline `<select>` (reusing `projectOptionsHtml`,
the same tree-indented picker the add-topic form and category manager already
use) with Save/Cancel, following the exact click-to-edit idiom the category
manager's own name/project editing already established. Hidden entirely in
local/offline mode and before the Todoist project list has loaded — same
gating the add-topic picker itself uses — since there's nothing to resolve
an override against without a live Todoist connection.

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

**Still not built, by deliberate scope decision**: there's no UI to change
an *existing* topic's category after creation (the backend route `POST
/api/topics/:id/category` and the frontend `setTopicCategory()` exist and
work, just have no button wired to them yet) — consistent with the existing
open question below about richer topic editing in general. Categorization
is settable at creation time and via the category manager's own
rename/reparent, which covers the common case. (The equivalent gap for a
topic's Todoist project override was closed on 2026-07-20 — see above — but
that was a narrower, more requested change; category reassignment's own UI
trigger remains open.)

There are now **three** places `worker/index.js` and `public/index.html`
must be kept in sync by hand, not two: `nowIST()`/the timezone offset, the
SM-2 elapsed-time correction, and the category safe-archive guard
(`archiveCategory`'s local-mode duplicate of the server's active-children/
active-topics check).

## Todoist sync: the unified `steady`/`review` label scheme

As of 2026-07-16, both sync directions (Steady → Todoist and Todoist →
Steady) are gated by one label, replacing an earlier design that used two
separate, narrower labels (`STEADY_IMPORT_LABEL` for import requests,
`REVISION_LABEL` alone for completion matching). The user's own framing:
"anything that goes from steady to todoist, gets a steady label and
revision label on it. anything that goes from todoist to steady has to
have a steady label on it. revision label if already there, great, else
steady assigns it. just revision label doesn't mean it goes to steady."

- **`STEADY_LABEL`** (env var, default `"steady"`) is the actual sync gate
  — required on a task for it to participate in *either* direction.
- **`REVISION_LABEL`** (env var, default **`"review"`** — this is the real
  label in the user's Todoist account, not `"revision"`; an earlier default
  value was simply wrong and got corrected here) means "there is already a
  live, outstanding revision task for this topic." It co-occurs with
  `steady` on every task `pushToTodoist` creates, and gets added by the
  importer the instant it adopts a task, so the same task is never
  re-imported on a later scan.
- A task carrying `REVISION_LABEL` **without** `STEADY_LABEL` is not synced
  by either direction at all — confirmed live: tagging a task `review`-only
  and completing it is silently ignored by both `runInboundImport` and
  `runCompletionSync`.
- **As of 2026-07-20, every task `pushToTodoist` creates is priority 4** —
  Todoist's API inverts the UI's label, where priority 4 is what the UI
  shows as "P1" (highest) and 1 is "P4" (default/lowest), so a hardcoded
  `4` in the request body is the highest priority Todoist has, not the
  lowest a naive reading of the number might suggest. Not configurable via
  an env var (unlike the labels) — there was no request for anything other
  than "always P1," so this doesn't invent a knob nothing asked for.
  Confirmed live by pushing a disposable test topic and reading the
  created task straight back from the real API: `"priority":4`. (A user
  report that pushed tasks "aren't P1" turned out to be a downstream
  symptom of the deleted-task bug documented below, not a problem with
  this value itself — a topic whose old task was silently never re-pushed
  obviously never got a fresh, correctly-prioritized one either.)

### Inbound import (Todoist → Steady)

`runInboundImport` scans `GET /tasks?label=STEADY_LABEL` (searched
globally, not by project/section — the real account is 50 projects deep,
several levels each, too varied for "watch one project" to be meaningful).
For each returned task:
- Already carries `REVISION_LABEL` → already tracked, skipped outright
  (`continue`, not counted toward `succeeded`/`failed` — a no-op, not
  a failure).
- Doesn't carry it → fresh import candidate. Dedup-guarded via
  `topics.source_todoist_task_id` (permanent, write-once provenance for
  the *original capture task* — a partial unique index backstops this at
  the DB level too). Inserts a new topic with `next_due` = tomorrow (IST;
  an immediate same-day bounce-back for something just captured seconds
  ago would read as noise, not a considered schedule — it only matters if
  the task sits uncompleted, since a real review recomputes `next_due` via
  SM-2 regardless), `source_todoist_task_id = task.id`, **and
  `todoist_task_id = task.id`** — the task is *adopted* as the topic's own
  currently-outstanding revision task rather than left `NULL`. This is
  required for "any and all tasks linked to steady can be completed from
  todoist" to hold on a topic's very first cycle — without it, the exact
  task the user tagged could never itself register a completion. Then
  `REVISION_LABEL` is added to the task via the same `POST /tasks/{id}`
  labels-update call the old scheme used.

**Fixed 2026-07-20** (previously an accepted, documented limitation here):
if a pushed or adopted task was deleted in Todoist without ever being
completed, `topics.todoist_task_id` stayed pointing at a task that no
longer existed, and nothing detected or cleared it — the topic silently
stopped being push-eligible forever. This risk applied to every
normally-pushed task, not just adopted import candidates.

`pushToTodoist` now checks the existing task before trusting the "already
pushed" guard (real bug report: "push now doesn't push every task... if
that task gets deleted in todoist, [it] doesn't register that the task was
deleted and doesn't re push it"). **The check is not a plain
`GET /tasks/{id}` status code check** — confirmed live by actually
deleting a real test task and inspecting the response: Todoist soft-deletes
tasks, so `GET /tasks/{id}` on a deleted task returns `200 OK` with
`is_deleted: true` in the body, not a 404. A naive `res.ok` check would have
silently kept this exact bug alive (an early version of this fix,
written before live-testing, did exactly that and would have shipped
broken). The real check: `res.ok` **and** `!body.is_deleted` means the
task is genuinely still there (skip, as before); a 404 *or* `is_deleted:
true` both mean it's gone — clear `todoist_task_id` to `NULL` and fall
through to push a fresh task; any other non-OK response (network blip,
transient 5xx) is treated as a failed push rather than a guess either way,
so it's retried next run instead of risking a duplicate task. Verified
live end-to-end: pushed a disposable test topic, deleted its task via the
real API, ran push-now again, confirmed a *new* task id was assigned (and
carried the correct P1 priority — see below), then confirmed a second
push-now against the still-live replacement task does *not* create a
third one.

**Another inherent limitation, also not solved here**: `GET /tasks?label=X`
only returns *active* tasks. If a task is tagged `steady` and completed
before the daily cron ever runs, import never sees it (excluded from the
active-task query) and no topic gets created — completion sync can't help
either, since no topic exists yet to match against.

### Completion sync (Todoist → Steady, closing the review loop)

`runCompletionSync` finds completed tasks carrying `STEADY_LABEL` (**not**
`REVISION_LABEL` — "just revision label doesn't mean it goes to steady")
in a trailing 3-day window, and matches them against topics via
`todoist_task_id` equality (unchanged from the original design).

**Quality comes from the task's most recent comment, parsed for a bare 0–5
digit** (`/\b[0-5]\b/`) — 0 meaning "didn't remember a single thing," 5
meaning "remembered everything," the same scale Steady's own quality
buttons already use.

**No digit found → no SM-2 update at all.** This replaced an earlier
default-to-quality-3 behavior entirely, per explicit direction: "todoist
tasks that will sync to steady have to have a number frm 0 to 5 mentioned
in comments to that task before completion to be counted toward the actual
SM-2 revision cycle data." Instead: the *same* task is reopened in place
(`reopenTodoistTask` — `POST /tasks/{id}/reopen`, confirmed empirically to
return `204`) and its due date reset to today (`POST /tasks/{id}` with
`due_string: "today"`), and `topics.unconfirmed_completion_at` is set to a
timestamp so the frontend can say a completion arrived with no confidence
rating (see below). Considered and rejected: creating a *new* replacement
task instead of reopening — the user was explicit that it should reappear
"wherever it was, that same instant," and reopening the same task keeps it
in its original project/section for free, with no duplicate-task clutter
across repeated skipped cycles. This is self-correcting: a reopened task
no longer appears in the completed-tasks endpoint on the next run, so
there's no risk of ever reprocessing it before the user completes it
again for real — confirmed live (a second `runCompletionSync` run against
a just-reopened task returns `{succeeded: 0, failed: 0}`, not a repeat).

**A `*Xhrs Ymins` line in the task's description is read back as
`minutes_spent`** — the reverse direction of `appendTimeToTodoistTask`'s
own one-way write (last match wins if more than one such line exists).
Confirmed empirically that the completed-tasks endpoint's response
includes the full `description` field per item, not just summary fields.

**Digit found → `applyReview(env, topic.id, quality, minutesSpent)`** — the
same shared code path the `/review` route uses. No separate
`todoist_task_id` clear is needed here anymore; see `applyReview` below.

**The completed-tasks endpoint's own `label` query parameter does not
actually filter** — confirmed empirically: a request with a label param
still returned unrelated completed tasks with empty `labels: []`. Labels
are filtered client-side in JS instead. The endpoint also requires **both**
`since` and `until` (a lone `since` 400s), and wraps its response in
`{items: [...]}` — a different key than the `{results: [...]}` wrapping
every other list endpoint in this file uses. `GET /comments?task_id=X`
follows the usual `{results: [...], next_cursor}` shape, each comment
carrying `content` and `posted_at`; comments are sorted explicitly by
`posted_at` in JS rather than trusting the API's implicit ordering.

### `applyReview` closes the Todoist task and clears state — for *every*
### trigger, not just completion sync

Asked directly whether reviewing a topic from Steady's own UI also
completes the corresponding Todoist task, the honest answer used to be
**no** — `applyReview` only ever appended the time-spent note; it never
closed the task and never cleared `topics.todoist_task_id`. That meant a
topic reviewed from Steady's UI could never be pushed a second time
(`pushToTodoist`'s "already pushed, skip" guard checked that column
forever) — the exact same class of bug already fixed for the
completion-sync trigger specifically, just never fixed for the manual one.

Fixed by centralizing in `applyReview` itself: its `UPDATE topics SET ...`
now unconditionally also sets `todoist_task_id = NULL,
unconfirmed_completion_at = NULL` (clearing an already-`NULL` column is
harmless), and — best-effort, wrapped in try/catch, never blocking the
SM-2 write itself — appends time-spent (unchanged) then calls
`closeTodoistTask` (`POST /tasks/{id}/close`) if the topic had a live
`todoist_task_id`. Completing an already-completed task (the
completion-sync trigger, where the user closed it in Todoist themselves)
is a harmless no-op — confirmed empirically by calling `/close` twice in a
row on the same task (`204` both times). Net effect: `runCompletionSync`'s
"digit found" branch no longer needs its own explicit clearing step —
`applyReview` does it, one source of truth regardless of trigger.

### Verification

Every piece above (`/close`, `/reopen`, the completed-tasks endpoint's
`description` field, the full unified label flow, the reopen-in-place
no-digit path, and the `applyReview` Todoist-closing fix) was verified
live against the real Todoist account and real production D1 — via
disposable test tasks/topics created, exercised, and deleted/archived
immediately after, and a temporary debug route fully reverted afterward
(confirmed via `grep -i debug worker/index.js` returning nothing) — not
assumed from the REST v2 conventions seen elsewhere in this file.

### Manual push-now + on-task completion instructions (2026-07-20)

Two smaller additions on top of the scheme above, both aimed at making the
push side more usable/self-explanatory without touching the label scheme
itself:

- **`POST /api/push-now`** runs just `runDailyPush` immediately (through
  the same `runOperation` wrapper the cron uses, so it still produces a
  real `sync_log` row — a manual push that fails shouldn't be any less
  visible than a cron-driven one). Deliberately scoped to push only, not a
  full three-operation sync — import/completion-sync still only run on the
  cron's own schedule. Surfaced as a small "Push now" button next to the
  "Last sync" line (`#pushNowBtn` / `pushNow()` in `public/index.html`),
  disabled with a "Pushing…" label for the duration of the request — worth
  knowing this can take several real seconds in practice (each due topic's
  `pushToTodoist` call is a real, sequential outbound fetch, not
  parallelized), not a hang. Hidden in local/offline mode and whenever the
  sync-status fetch itself couldn't reach the API, the same reachability
  signal `renderSyncStatus` already existed to compute.
- **Every task `pushToTodoist` creates now carries a `description`**
  (`COMPLETION_INSTRUCTIONS` in `worker/index.js`) spelling out the actual
  completion contract on the task itself — comment a bare 0-5 digit before
  completing, or completing with no digit just reopens the same task due
  today rather than recording a review. This was previously only
  documented in this file, invisible from inside Todoist itself. Confirmed
  compatible with `appendTimeToTodoistTask`'s existing behavior: that
  function fetches the current description and appends a new `\n`-joined
  line rather than overwriting it (already true before this change, per
  the time-tracking section below), so the instructions text and a later
  `*Xhrs Ymins` line coexist without stepping on each other. Deliberately
  **not** applied to tasks `runInboundImport` adopts — those are the
  user's own pre-existing capture notes, and rewriting their description
  out from under them would be presumptuous in a way creating a brand-new
  task never is.

## Per-topic review history (time spent + confidence, on the frontend)

Steady already asked for and stored time-spent per review; the gap was
pure display — no review history reached the frontend at all before this,
online or offline. `GET /api/topics` now extends its existing
reviews-join query (already there for `trajectory_note`) to also select
`minutes_spent, reviewed_at`, attaching per topic:
- `recent_reviews`: the last 6 reviews, newest-first, each
  `{quality, minutes_spent, reviewed_at}`.
- `total_minutes_spent`: summed across *all* of that topic's reviews (not
  just the last 6) — left at `0` (falsy) if no review ever logged time,
  so it stays invisible until earned, the same restraint already used for
  `trajectory_note`.

Rendered in `public/index.html` as a `.review-history` strip of small
`.review-dot` circles (one per `recent_reviews` entry, color-coded by
quality using only existing palette tokens — `--danger` low / `--accent-dim`
mid / `--accent` high, no new colors), each with a `title` tooltip like
"Jul 12 · Q4 · 25m". `total_minutes_spent`, when nonzero, joins the
existing `metaBits` line (same place EF/review-count/project-name already
render) as e.g. "3h 20m total".

**Deliberately not extended to local/offline mode** — `localTopics`'
`reviewLog` stays bare ISO-date strings (heatmap only); `recent_reviews`/
`total_minutes_spent` are simply `undefined` there, so the rendering
functions return `''`/skip silently. This is the same scope cut already
made and documented for `trajectory_note`, not a new one — extending
`reviewLog` to `{date, quality, minutes}` objects would make this a
**fourth** hand-synced pair between the two files (alongside `nowIST()`,
the SM-2 elapsed-time correction, and the category safe-archive guard),
for a feature that's explicitly presentational.

## Time-tracking on review

After picking a quality rating (by click or keyboard), a small inline
prompt ("Time spent? [hrs] [mins] Log / Skip") asks how long the revision
took before the review is actually recorded — skippable, since not every
review is worth timing. `reviews.minutes_spent` is nullable for exactly
this reason. When a value is given and the topic has a live
`todoist_task_id`, `appendTimeToTodoistTask` appends `*Xhrs Ymins` as a new
line on that Todoist task's description — **appended, not overwritten**,
since the task may carry notes the user added by hand (confirmed
empirically: reviewing the same still-open task twice produced two
distinct `*Xhrs Ymins` lines, not one overwriting the other). The zero
case isn't special-cased — 40 minutes reads as `*0hrs 40mins`, following
the literal format asked for rather than adding cleverness to omit the
zero. This Todoist call is wrapped in try/catch and never blocks the
review itself (the SM-2 update) from succeeding — annotating Todoist is a
nice-to-have, the schedule update is not. As of the unified label scheme
above, this same value is also read back from Todoist's side (a
`*Xhrs Ymins` line in a task's description) when completion sync applies a
review, so time-tracking now flows in both directions, not just one.

Local/offline mode does not currently send `minutes_spent` to Todoist
(there's no Todoist to annotate offline anyway) — same "best effort,
skip gracefully" posture already used for sync-status and the trajectory
note.

## Mobile: a real overflow bug, not just "needs polish"

As of 2026-07-17, the frontend had a genuine layout bug on phone-width
viewports, found by actually loading it at 375px/320px via Playwright
rather than guessing from the CSS: `.cal-day` (`aspect-ratio: 1.6`, itself
`display: flex`) sat inside `.cal-grid`'s `repeat(7, 1fr)` CSS Grid, and
that specific combination — a grid item that is *both* a flex container
*and* has `aspect-ratio` set — breaks Chromium's grid track shrinking.
Each column locked at a fixed ~80px regardless of the actual viewport,
which is why the entire page was 254px wider than a 375px phone screen
(confirmed via `document.documentElement.scrollWidth -
document.documentElement.clientWidth`) — plain `aspect-ratio: 1` on a
non-flex item (the heatmap's `.heat-cell`) shrinks correctly, so this is
specifically a flex+aspect-ratio-in-a-grid interaction, not aspect-ratio
alone. **Fix: `min-width: 0` on `.cal-day`** — grid items default to
`min-width: auto`, which lets their content's intrinsic minimum size block
shrinking below it; `min-width: 0` overrides that. If any *other*
aspect-ratio'd flex item is ever added inside a CSS Grid in this file, it
needs the same explicit `min-width: 0` (and `min-height: 0` if the grid is
row-constrained) — this isn't a one-off fix, it's a pattern to repeat.

A second, narrower overflow existed in the calendar's day-detail panel
(`.cal-detail-topic`): a plain flex row with a title on one side and up to
six `.qbtn` quality buttons on the other, no wrap allowed, so on a ~320px
phone the button group had nowhere to go but past the right edge. Fixed
with `flex-wrap: wrap` on `.cal-detail-topic` and `.cal-detail-quality` —
the buttons now drop to their own line under the title when there isn't
room, matching the existing topic-row pattern where `.quality-row` already
renders below the title rather than beside it.

Also bumped two touch targets that were uncomfortably small on a phone:
`.cal-nav` (28px → 36px) and `.archive-btn` (enlarged the tappable padding
via `padding: 8px; margin: -8px`, a negative-margin trick that grows the
hit area without changing the visible glyph's size or shifting surrounding
layout). `.qbtn` (30px) was deliberately left alone — six of them in a row
already reads as compact-but-intentional, and enlarging to a full 44px
touch target risks reintroducing overflow on the smallest phones (320px)
for exactly the same reason the calendar just broke.

Verified via Playwright at 320px and 375px (both the initial load and with
the time-prompt/quality-row/calendar-detail all open at once, since fixed-
position elements and dynamically-inserted content are exactly where a
regression would hide) and re-verified at 1280px to confirm none of this
changed anything for desktop, since none of the fixes are behind a media
query — they're corrections to rules that were always wrong, not
mobile-specific overrides.

## Deployment

Live as a single Cloudflare Worker (D1-backed, static assets served from
`/public`). Real database and Todoist project IDs live only in the user's
own `wrangler.toml`/Cloudflare account, not in this repo's history — treat
`wrangler.toml` placeholders as needing real values filled in locally before
deploy, and don't hardcode live resource IDs back into this file.

Redeploy with `wrangler deploy` any time after code changes.

## Open decisions / things to ask about, don't assume

- Whether topics need richer editing beyond archiving (currently DELETE just
  sets `archived = 1`). `POST /api/topics/:id/category` narrowly answers
  "can a topic's category be changed after creation" (yes, via the API) but
  deliberately doesn't touch this broader question — general title/notes
  editing and a UI trigger for the category route are still both open. (A
  topic's Todoist project override *does* now have both, as of 2026-07-20 —
  see the Categories section — so this gap is specifically about title/notes
  and category, not project override anymore.)
- The original v1 design (navy/amber, GitHub-aesthetic) exists conceptually
  but was superseded by v2 — no need to resurrect it unless asked.
