# Steady

A personal spaced-repetition tool. Log what you studied, and Steady tells
you when to revise it again — using the SM-2 algorithm — and pushes the
due-today revisions into Todoist so you actually get notified.

## Stack

- **Cloudflare Workers** — single Worker serves both the API (`/api/*`) and
  the static frontend (everything else, from `/public`)
- **Cloudflare D1** — SQLite database, three tables: `topics`, `reviews`,
  and `categories` (an optional, arbitrary-depth tree topics can belong to)
- **Todoist REST API v2** — daily cron (23:30 UTC / 5:00 AM IST) pushes
  topics due today or overdue into Todoist as tasks. Each topic can target
  its own Todoist project (picked from a dropdown in the UI, backed by
  `GET /api/todoist/projects`); failing that, its category's own override,
  then the nearest ancestor category's override, then the default
  `TODOIST_PROJECT_ID` project
- A forward-looking, clickable calendar (review directly from a due day)
  and a 28-day activity heatmap, alongside the flat/grouped topic list
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
(`/api/todoist/projects` returns 503, and the cron job silently skips
pushing — each failure is logged individually and doesn't block the rest of
the batch).

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

Deployed and smoke-tested: topic creation, SM-2 review scoring (verified
against the spec's reference EF/interval values), archiving, and stats all
work against a real D1 database. The one untested leg is the Todoist push
itself, which needs `TODOIST_API_TOKEN` set (see Setup) — once that's in,
watch the next cron run, or use `wrangler tail` to confirm tasks land in
the right Todoist project.
