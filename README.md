# Steady

A personal spaced-repetition tool. Log what you studied, and Steady tells
you when to revise it again — using the SM-2 algorithm — and pushes the
due-today revisions into Todoist so you actually get notified.

## Stack

- **Cloudflare Workers** — single Worker serves both the API (`/api/*`) and
  the static frontend (everything else, from `/public`)
- **Cloudflare D1** — SQLite database, four tables: `topics`, `reviews`
  (each review keeps a full pre-review snapshot, so a rating can be
  undone), `categories` (an optional, arbitrary-depth tree topics can
  belong to), and `sync_log` (one row per cron-driven Todoist operation,
  so a failure is visible in the UI, not just the Worker's own logs)
- **Todoist API v1** (`api.todoist.com/api/v1`) — daily cron (23:30 UTC /
  5:00 AM IST) runs three operations, each independently logged so a
  failure in one doesn't hide the others: (1) pushes topics due today or
  overdue into Todoist as P1 tasks, tagged with both a `review` label (an
  outstanding revision task) and a `steady` label (the actual sync gate —
  required, both directions, for a task to be Steady's business at all) —
  each topic can target its own Todoist project (picked from a dropdown in
  the UI — shown indented by Todoist's real project/sub-project hierarchy,
  backed by `GET /api/todoist/projects` — and editable after creation too,
  via a small "→ ProjectName" control under the topic), failing that its
  category's own override, then the nearest ancestor category's override,
  then the default `TODOIST_PROJECT_ID` project; pushed tasks also carry a
  description spelling out the completion contract (comment a 0–5 digit
  before completing, or it just reopens) right on the task itself; (2)
  imports any `steady`-tagged
  task that doesn't yet carry `review` as a new Steady topic, adopting
  that same task as its first outstanding revision task; (3) syncs
  completed `steady`-tagged tasks back into Steady as reviews — a bare 0–5
  confidence rating parsed from the task's latest comment (0 = didn't
  remember a thing, 5 = remembered everything) is required for it to count
  toward the actual SM-2 schedule; without one, the task just reopens and
  re-dues today instead, and the topic list says so. Completing a review
  either way — a Todoist checkbox or Steady's own quality buttons — closes
  the same task and clears it for the next cycle, so it can only ever be
  reviewed once per cycle regardless of which side triggered it. A
  "Last sync: N pushed, N failed" line in the UI surfaces the cron's own
  health, next to a "Push now" button that runs just the push operation
  immediately instead of waiting for the daily cron
- A forward-looking, clickable calendar (review directly from a due day)
  and a 28-day activity heatmap, alongside the flat/grouped topic list
- Each topic gets a short, plain-language read on its recent review
  history once it has 3+ reviews (e.g. "Rock solid — 5 clean reviews in a
  row"), plus a compact strip of colored dots showing its last 6 reviews'
  confidence and time spent at a glance (hover for the exact date/rating/
  duration), and a running total of time spent once any review has logged
  minutes. A rated review can be undone for a few seconds after
  ("Rated 3 · Undo") in case of a mis-tap
- Keyboard shortcuts: `0`–`5` rates whichever topic's quality row is open,
  `/` focuses the add-topic input, `←`/`→` move the calendar a month
- Installable as its own app (phone home screen / desktop standalone
  window) via a manifest + service worker
- No build step, no frontend framework — `public/index.html` is plain
  HTML/CSS/JS and also works standalone via `localStorage` if the API isn't
  reachable

## Repo layout

```
worker/index.js       Worker: API routes, SM-2 scheduling, Todoist cron push
public/index.html     Frontend (served as static assets by the same Worker)
schema.sql            D1 schema
wrangler.toml.example Worker config template — copy to wrangler.toml and fill in
CLAUDE.md             Full context/decisions brief, for Claude Code
```

`wrangler.toml` itself is gitignored, since it holds account-specific
resource IDs — copy `wrangler.toml.example` to `wrangler.toml` and fill it
in as you go through Setup below.

## Setup

```
cp wrangler.toml.example wrangler.toml
```

**1. Create the D1 database**

```
wrangler d1 create steady
```

Paste the returned `database_id` into `wrangler.toml`.

**2. Load the schema**

```
wrangler d1 execute steady --remote --file=./schema.sql
```

There's no migrations mechanism here — `schema.sql` only ever runs as
`CREATE TABLE/INDEX IF NOT EXISTS`, so it won't retrofit a column onto a
table that already exists. If a future change adds a column to an existing
table (like `topics.category_id` did), that needs a one-off manual
`ALTER TABLE`, documented in `CLAUDE.md` at the time it happens — check
there before assuming re-running `schema.sql` alone is enough.

**3. Set your Todoist project**

Create (or pick) a Todoist project for revision tasks to land in, and put
its project ID into `wrangler.toml` in place of
`REPLACE_WITH_TODOIST_PROJECT_ID`.

**4. Set your Todoist API token as a secret**

Get a token from Todoist (Settings → Integrations → Developer), then:

```
wrangler secret put TODOIST_API_TOKEN
```

This keeps it out of the repo and out of `wrangler.toml` entirely. Until
it's set, everything works except the daily Todoist push
(`/api/todoist/projects` returns 503, and each push attempt fails — caught
per-topic so one failure doesn't block the rest of the batch, and counted
in the "Last sync" line in the UI rather than only ever logged).

**5. (Optional) Gate the app behind Basic Auth**

This app has no other access control, so if you deploy it to a public
`workers.dev` URL, set these two secrets to require a login:

```
wrangler secret put BASIC_AUTH_USER
wrangler secret put BASIC_AUTH_PASS
```

The check (in `worker/index.js`) is skipped entirely if `BASIC_AUTH_USER`
isn't set, so this is opt-in.

**6. Deploy**

```
wrangler deploy
```

## Local development

```
wrangler dev
```

Runs the Worker locally with a local D1 instance. The frontend will hit
`/api/*` on the same local origin.

## How the scheduling works

Each topic tracks an easiness factor (EF, starts at 2.5), an interval in
days, and a repetition count. After each review you rate recall 0–5:

- Below 3: treated as a lapse. Repetitions reset, next review is tomorrow.
- 3 and above: repetitions increase, and the interval grows (1 day → 6 days
  → `interval × EF` from then on). EF itself shifts up or down slightly
  based on how easy or hard that recall felt.

See `CLAUDE.md` for the exact formula and where it's implemented.

## Status

Deployed and in daily real use: topic creation, SM-2 review scoring
(verified against the spec's reference EF/interval values), review undo,
archiving, categories, the calendar/heatmap, per-topic review history, and
all three Todoist cron operations (push, inbound import, completion sync)
have all been exercised against a real D1 database and a real Todoist
account, not just a first draft. A "Last sync" line in the UI surfaces the
daily cron's own health, so a failure in any of the three is visible
instead of only sitting in the Worker's logs. The Todoist loop runs both
directions under one unified `steady`/`review` label scheme: push a due
topic out as a task, tag any task `steady` to pull it in as a new topic
(immediately completable from Todoist, not just from its next real due
date), and complete a tagged task with a 0–5 confidence comment to log its
review automatically — no comment means no schedule change, just a
reopened task and a visible note on the topic. Reviewing from Steady's own
UI closes the Todoist side too, so either direction can start or finish a
review cycle. Pushed tasks also spell out that completion contract right
on the task's own description, and a "Push now" button runs the push
operation on demand instead of waiting for the daily cron — useful right
after changing a topic's Todoist project override, which is itself now
editable after creation (not just at add-time) from a small control under
each topic. A pushed task that's deleted in Todoist (not completed, just
deleted) is detected on the next push and gets a fresh one, rather than
the topic silently going stuck forever. See `CLAUDE.md` for the full
design and the real-API quirks (undocumented, found by testing) each one
turned up — including the fact that Todoist soft-deletes tasks, so
`GET /tasks/{id}` on a deleted task returns `200` with `is_deleted: true`
instead of a 404.
