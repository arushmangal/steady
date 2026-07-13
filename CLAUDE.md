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
- **Todoist REST API v2**, called directly from the Worker's `scheduled`
  handler (daily cron), not through a middleman. The Worker needs its own
  `TODOIST_API_TOKEN` secret, set via `wrangler secret put TODOIST_API_TOKEN`
  — an AI agent should never handle or type a live API token (or any other
  credential/secret) on someone's behalf, so don't offer to do this part for
  the user even if asked. Same principle applies to Basic Auth credentials
  (see below): generate/suggest values if helpful, but the user runs
  `wrangler secret put` themselves.

## Current state of this repo

Deployed and working: topic CRUD, SM-2 review scoring, archiving, stats,
and the Todoist push have all been exercised against a real D1 instance and
a real Todoist project (not just a first draft anymore).

- `worker/index.js` — routes for topics (CRUD-ish) and reviews, SM-2+
  scheduling math, a `GET /api/calendar?month=YYYY-MM` route (due topics
  grouped by day, for the calendar view), a `scheduled()` handler that
  pushes due topics to Todoist (per-topic `pushToTodoist` failures are
  caught individually so one bad topic doesn't stop the rest of the daily
  batch), and a Basic Auth gate (`checkAuth`, constant-time comparison via
  HMAC) in front of every route. The auth gate is inert until
  `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` secrets are set.
- `schema.sql` — two tables, `topics` (includes `todoist_project_id` for
  per-topic destination overrides) and `reviews`.
- `public/index.html` — single-file frontend (vanilla JS, no build step).
  Near-black background (`#111110`), sage green accent (`#7eb89a`),
  `DM Serif Display` for the wordmark, a 28-day "pulse" histogram of review
  activity, a forward-looking calendar panel (gradient backdrop, tiered
  color-pop fills by due-count, glowing "today" ring — deliberately more
  vibrant than the rest of the app's flatter panels), a Todoist project
  picker in the add-topic form, an archive button per topic, and a "pushed
  to Todoist" indicator dot. Works standalone via `localStorage` if
  `/api/*` calls fail.
- `wrangler.toml` — cron is `30 23 * * *` (23:30 UTC), tuned for the user's
  timezone so revisions land in Todoist before their day starts, not at
  midday. Don't assume this offset is right if the user's timezone changes.

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
  sets `archived = 1`).
- The original v1 design (navy/amber, GitHub-aesthetic) exists conceptually
  but was superseded by v2 — no need to resurrect it unless asked.
