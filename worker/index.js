/**
 * Steady — Cloudflare Worker
 *
 * Routes:
 *   GET    /api/topics              list active topics, ordered by next_due
 *   POST   /api/topics              create a topic { title, notes? }
 *   POST   /api/topics/:id/review   record a review { quality: 0-5 } -> runs SM-2, returns updated topic
 *   DELETE /api/topics/:id          archive a topic
 *   GET    /api/stats               28-day review counts, for the activity heatmap
 *   GET    /api/calendar            due-topic counts/titles by day, for a given month
 *   GET    /api/todoist/projects    list Todoist projects (for the destination picker)
 *
 * Anything else falls through to the static assets binding (the frontend in /public).
 *
 * Scheduled (cron, see wrangler.toml): once a day, finds topics due today or overdue
 * and pushes a matching Todoist task for each, labelled with REVISION_LABEL.
 */

// This app is single-user and that user is on IST (UTC+5:30, no DST) — see
// CLAUDE.md. Every "what day is it" calculation anchors on IST, not raw UTC,
// otherwise the app thinks it's still yesterday until 5:30am IST. If the
// user's timezone ever changes, this constant is the one place to update.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);
const todayISO = () => nowIST().toISOString().slice(0, 10);

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });
}

/**
 * SM-2 scheduling, with an elapsed-time correction on 3rd+ successful
 * reviews (see CLAUDE.md for full derivation/sourcing). Given current
 * state, a 0-5 quality rating, and the real elapsed days since the last
 * review, returns the next { ef, interval_days, repetitions, next_due }.
 */
function sm2(prev, quality, elapsedDays) {
  let { ef, interval_days, repetitions } = prev;

  if (quality < 3) {
    // Failed recall: reset repetitions, review again tomorrow.
    repetitions = 0;
    interval_days = 1;
  } else {
    repetitions += 1;
    if (repetitions === 1) {
      interval_days = 1;
    } else if (repetitions === 2) {
      interval_days = 6;
    } else {
      // SM-2's own prediction — also SuperMemo SM-4's matrix seed value
      // OI(n,EF) = OI(n-1,EF)*EF, i.e. what OI defaults to before any
      // real-observation refinement.
      const naive = interval_days * ef;
      // SuperMemo SM-4's published per-observation formula (Wozniak,
      // super-memory.com/english/ol/sm4.htm), applied directly against
      // this topic's own state rather than a shared cross-item matrix —
      // see CLAUDE.md for why the matrix layer itself isn't used.
      const oiPrime = elapsedDays + (elapsedDays * (1 - 1 / ef)) / 2 * (0.25 * quality - 1);
      // FRACTION: Wozniak's own blending weight, left as "any number
      // between 0 and 1" with no published default — chosen conservatively
      // here since a single review has no cross-item pooling to smooth it.
      const FRACTION = 0.3;
      const blended = (1 - FRACTION) * naive + FRACTION * oiPrime;
      // A successful review must never shrink the interval below what's
      // already scheduled (verified failure mode on early/same-day reviews
      // without this floor — see CLAUDE.md).
      interval_days = Math.max(interval_days, Math.round(blended));
    }
  }

  // EF always updates, even on failure, per the original SM-2 spec.
  ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (ef < 1.3) ef = 1.3;

  const next = nowIST();
  next.setUTCDate(next.getUTCDate() + interval_days);

  return {
    ef,
    interval_days,
    repetitions,
    next_due: next.toISOString().slice(0, 10),
  };
}

async function handleApi(request, env, url) {
  const method = request.method;
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "topics", ...]

  // GET /api/topics
  if (method === "GET" && parts.length === 2 && parts[1] === "topics") {
    const { results } = await env.DB.prepare(
      `SELECT * FROM topics WHERE archived = 0 ORDER BY next_due ASC`
    ).all();
    return jsonResponse(results);
  }

  // POST /api/topics
  if (method === "POST" && parts.length === 2 && parts[1] === "topics") {
    const body = await request.json();
    if (!body.title || typeof body.title !== "string") {
      return jsonResponse({ error: "title is required" }, { status: 400 });
    }
    const due = todayISO();
    const { meta } = await env.DB.prepare(
      `INSERT INTO topics (title, notes, next_due, todoist_project_id) VALUES (?, ?, ?, ?)`
    )
      .bind(body.title, body.notes ?? null, due, body.todoist_project_id ?? null)
      .run();
    const topic = await env.DB.prepare(`SELECT * FROM topics WHERE id = ?`)
      .bind(meta.last_row_id)
      .first();
    return jsonResponse(topic, { status: 201 });
  }

  // GET /api/todoist/projects — proxies Todoist's project list so the
  // frontend can offer a destination picker without holding the token itself.
  if (method === "GET" && parts.length === 3 && parts[1] === "todoist" && parts[2] === "projects") {
    if (!env.TODOIST_API_TOKEN) {
      return jsonResponse({ error: "TODOIST_API_TOKEN not configured" }, { status: 503 });
    }
    const res = await fetch("https://api.todoist.com/rest/v2/projects", {
      headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
    });
    if (!res.ok) {
      return jsonResponse({ error: "failed to fetch Todoist projects" }, { status: 502 });
    }
    const projects = await res.json();
    return jsonResponse(projects.map((p) => ({ id: p.id, name: p.name })));
  }

  // POST /api/topics/:id/review
  if (method === "POST" && parts.length === 4 && parts[1] === "topics" && parts[3] === "review") {
    const id = Number(parts[2]);
    const body = await request.json();
    const quality = Number(body.quality);
    if (!Number.isInteger(quality) || quality < 0 || quality > 5) {
      return jsonResponse({ error: "quality must be an integer 0-5" }, { status: 400 });
    }

    const topic = await env.DB.prepare(`SELECT * FROM topics WHERE id = ?`).bind(id).first();
    if (!topic) return jsonResponse({ error: "not found" }, { status: 404 });

    const elapsedDays = topic.last_reviewed
      ? Math.round((Date.parse(todayISO()) - Date.parse(topic.last_reviewed)) / 86400000)
      : 0;

    const before = { ef: topic.ef, interval_days: topic.interval_days, repetitions: topic.repetitions };
    const after = sm2(before, quality, elapsedDays);

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE topics SET ef = ?, interval_days = ?, repetitions = ?, next_due = ?, last_reviewed = ? WHERE id = ?`
      ).bind(after.ef, after.interval_days, after.repetitions, after.next_due, todayISO(), id),
      env.DB.prepare(
        `INSERT INTO reviews (topic_id, quality, ef_before, ef_after, interval_before, interval_after)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, quality, before.ef, after.ef, before.interval_days, after.interval_days),
    ]);

    const updated = await env.DB.prepare(`SELECT * FROM topics WHERE id = ?`).bind(id).first();
    return jsonResponse(updated);
  }

  // DELETE /api/topics/:id
  if (method === "DELETE" && parts.length === 3 && parts[1] === "topics") {
    const id = Number(parts[2]);
    await env.DB.prepare(`UPDATE topics SET archived = 1 WHERE id = ?`).bind(id).run();
    return jsonResponse({ ok: true });
  }

  // GET /api/stats — review counts for the last 28 days, oldest first.
  // SQLite's date() has no timezone concept, so it must be shifted by the
  // same IST offset as nowIST() above — otherwise a review made in the late
  // UTC evening (which is already tomorrow in IST) gets grouped under the
  // wrong day, out of step with the IST-anchored day list below.
  if (method === "GET" && parts.length === 2 && parts[1] === "stats") {
    const { results } = await env.DB.prepare(
      `SELECT date(reviewed_at, '+330 minutes') AS day, COUNT(*) AS count
       FROM reviews
       WHERE reviewed_at >= datetime('now', '-28 days', '+330 minutes')
       GROUP BY day
       ORDER BY day ASC`
    ).all();

    // Fill in zero-count days so the frontend always gets 28 points.
    const counts = Object.fromEntries(results.map((r) => [r.day, r.count]));
    const days = [];
    for (let i = 27; i >= 0; i--) {
      const d = nowIST();
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push({ day: key, count: counts[key] ?? 0 });
    }
    return jsonResponse(days);
  }

  // GET /api/calendar?month=YYYY-MM — due topics grouped by day, for the
  // forward-looking calendar view. Defaults to the current month.
  if (method === "GET" && parts.length === 2 && parts[1] === "calendar") {
    const monthParam = url.searchParams.get("month");
    const month = /^\d{4}-\d{2}$/.test(monthParam || "") ? monthParam : todayISO().slice(0, 7);
    const [y, m] = month.split("-").map(Number);
    const first = `${month}-01`;
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // day 0 of next month = last day of this month

    const { results } = await env.DB.prepare(
      `SELECT id, title, next_due FROM topics WHERE archived = 0 AND next_due BETWEEN ? AND ? ORDER BY next_due ASC`
    )
      .bind(first, last)
      .all();

    const days = {};
    for (const r of results) {
      (days[r.next_due] ||= []).push({ id: r.id, title: r.title });
    }
    return jsonResponse({ month, days });
  }

  return jsonResponse({ error: "not found" }, { status: 404 });
}

/**
 * Creates the Todoist task for a due topic, if one doesn't already exist.
 * Requires env.TODOIST_API_TOKEN (secret) and env.TODOIST_PROJECT_ID (var).
 */
async function pushToTodoist(env, topic) {
  if (topic.todoist_task_id) {
    // Already pushed. Steady doesn't try to re-sync completion state here —
    // the user checks the task off in Todoist, which is the whole point.
    return;
  }

  const res = await fetch("https://api.todoist.com/rest/v2/tasks", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: `Review: ${topic.title}`,
      project_id: topic.todoist_project_id || env.TODOIST_PROJECT_ID,
      labels: [env.REVISION_LABEL || "revision"],
      due_string: "today",
    }),
  });

  if (!res.ok) {
    console.error(`Todoist push failed for topic ${topic.id}: ${res.status} ${await res.text()}`);
    return;
  }

  const task = await res.json();
  await env.DB.prepare(`UPDATE topics SET todoist_task_id = ? WHERE id = ?`)
    .bind(task.id, topic.id)
    .run();
}

async function runDailyPush(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM topics WHERE archived = 0 AND next_due <= ?`
  )
    .bind(todayISO())
    .all();

  for (const topic of results) {
    try {
      await pushToTodoist(env, topic);
    } catch (err) {
      // One bad topic (network blip, bad project id, etc.) shouldn't stop
      // the rest of today's batch from reaching Todoist.
      console.error(`pushToTodoist threw for topic ${topic.id}: ${err}`);
    }
  }
}

/**
 * Constant-time string comparison via HMAC: both sides are hashed to a
 * fixed-length 32-byte digest before comparing, so neither the loop nor the
 * digest lengths leak anything about where (or whether) the strings differ.
 */
async function timingSafeEqual(a, b) {
  const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const enc = new TextEncoder();
  const [macA, macB] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  const bytesA = new Uint8Array(macA);
  const bytesB = new Uint8Array(macB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}

/**
 * This is a single-user personal tool sitting on a public workers.dev URL,
 * so every request (frontend and API) is gated behind HTTP Basic Auth.
 * Requires env.BASIC_AUTH_USER / env.BASIC_AUTH_PASS (secrets — see README).
 * If they aren't set — e.g. local `wrangler dev` without `.dev.vars` — auth
 * is skipped, since that's only reachable from localhost anyway.
 */
async function checkAuth(request, env) {
  if (!env.BASIC_AUTH_USER) return true;
  const header = request.headers.get("Authorization") || "";
  const expected = "Basic " + btoa(`${env.BASIC_AUTH_USER}:${env.BASIC_AUTH_PASS}`);
  return timingSafeEqual(header, expected);
}

export default {
  async fetch(request, env) {
    if (!(await checkAuth(request, env))) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Steady"' },
      });
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return jsonResponse({ error: String(err) }, { status: 500 });
      }
    }
    // Static frontend (see /public and the [assets] binding in wrangler.toml).
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyPush(env));
  },
};
