/**
 * Steady — Cloudflare Worker
 *
 * Routes:
 *   GET    /api/topics              list active topics, ordered by next_due
 *   POST   /api/topics              create a topic { title, notes?, category_id?, todoist_project_id? }
 *   POST   /api/topics/:id/review   record a review { quality: 0-5 } -> runs SM-2, returns updated topic
 *   POST   /api/topics/:id/undo-review  revert the topic's most recent review (400 if none, or too old to undo)
 *   POST   /api/topics/:id/category reassign a topic's category { category_id }
 *   DELETE /api/topics/:id          archive a topic
 *   GET    /api/categories          list active categories (flat; frontend builds the tree)
 *   POST   /api/categories          create a category { name, parent_id?, todoist_project_id? }
 *   POST   /api/categories/:id      update a category (rename / reparent / change Todoist override)
 *   DELETE /api/categories/:id      archive a category (blocked if it has active children/topics)
 *   GET    /api/stats               28-day review counts, for the activity heatmap
 *   GET    /api/calendar            due-topic counts/titles by day, for a given month
 *   GET    /api/todoist/projects    list Todoist projects (for the destination picker)
 *   GET    /api/sync-status         last cron-driven Todoist operation of each kind (push/import/completion_sync)
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

async function findActiveCategory(env, id) {
  return env.DB.prepare(`SELECT * FROM categories WHERE id = ? AND archived = 0`).bind(id).first();
}

/**
 * Validates an incoming category_id/parent_id from a request body.
 * Returns { ok: true, id: number|null } or { ok: false, error }.
 * Empty/null/undefined is valid and means "no category" — categorization
 * is opt-in everywhere it's used.
 */
async function resolveValidCategoryId(env, rawId) {
  if (rawId === undefined || rawId === null || rawId === "") return { ok: true, id: null };
  const id = Number(rawId);
  if (!Number.isInteger(id)) return { ok: false, error: "category_id must be an integer" };
  const category = await findActiveCategory(env, id);
  if (!category) return { ok: false, error: "category not found" };
  return { ok: true, id };
}

/**
 * True if setting `categoryId`'s parent to `proposedParentId` would create a
 * cycle. Foreign keys check existence, not acyclicity, so this guard is
 * required regardless of D1's FK enforcement. The `seen` set both detects
 * the target cycle and guarantees termination even against a pre-existing
 * corrupt one.
 */
async function wouldCreateCycle(env, categoryId, proposedParentId) {
  let current = proposedParentId;
  const seen = new Set();
  while (current !== null && current !== undefined) {
    if (current === categoryId) return true;
    if (seen.has(current)) return false; // pre-existing cycle elsewhere; not this call's problem
    seen.add(current);
    const row = await env.DB.prepare(`SELECT parent_id FROM categories WHERE id = ?`).bind(current).first();
    if (!row) return false;
    current = row.parent_id;
  }
  return false;
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
    const category = await resolveValidCategoryId(env, body.category_id);
    if (!category.ok) return jsonResponse({ error: category.error }, { status: 400 });

    const due = todayISO();
    const { meta } = await env.DB.prepare(
      `INSERT INTO topics (title, notes, next_due, todoist_project_id, category_id) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(body.title, body.notes ?? null, due, body.todoist_project_id ?? null, category.id)
      .run();
    const topic = await env.DB.prepare(`SELECT * FROM topics WHERE id = ?`)
      .bind(meta.last_row_id)
      .first();
    return jsonResponse(topic, { status: 201 });
  }

  // POST /api/topics/:id/category — reassign a topic's category. Deliberately
  // narrow (not a general topic-edit route) — richer topic editing is still
  // an open question (see CLAUDE.md), this doesn't answer it.
  if (method === "POST" && parts.length === 4 && parts[1] === "topics" && parts[3] === "category") {
    const id = Number(parts[2]);
    const topic = await env.DB.prepare(`SELECT id FROM topics WHERE id = ?`).bind(id).first();
    if (!topic) return jsonResponse({ error: "not found" }, { status: 404 });

    const body = await request.json();
    const category = await resolveValidCategoryId(env, body.category_id);
    if (!category.ok) return jsonResponse({ error: category.error }, { status: 400 });

    await env.DB.prepare(`UPDATE topics SET category_id = ? WHERE id = ?`).bind(category.id, id).run();
    const updated = await env.DB.prepare(`SELECT * FROM topics WHERE id = ?`).bind(id).first();
    return jsonResponse(updated);
  }

  // GET /api/categories — flat list; frontend builds the tree client-side.
  if (method === "GET" && parts.length === 2 && parts[1] === "categories") {
    const { results } = await env.DB.prepare(
      `SELECT * FROM categories WHERE archived = 0 ORDER BY id ASC`
    ).all();
    return jsonResponse(results);
  }

  // POST /api/categories — create { name, parent_id?, todoist_project_id? }
  if (method === "POST" && parts.length === 2 && parts[1] === "categories") {
    const body = await request.json();
    if (!body.name || typeof body.name !== "string") {
      return jsonResponse({ error: "name is required" }, { status: 400 });
    }
    const parent = await resolveValidCategoryId(env, body.parent_id);
    if (!parent.ok) return jsonResponse({ error: parent.error }, { status: 400 });

    const { meta } = await env.DB.prepare(
      `INSERT INTO categories (name, parent_id, todoist_project_id) VALUES (?, ?, ?)`
    )
      .bind(body.name, parent.id, body.todoist_project_id ?? null)
      .run();
    const category = await env.DB.prepare(`SELECT * FROM categories WHERE id = ?`)
      .bind(meta.last_row_id)
      .first();
    return jsonResponse(category, { status: 201 });
  }

  // POST /api/categories/:id — update (rename / reparent / change Todoist
  // override). One combined route + always-full UPDATE (fetch, merge in JS,
  // write every column) — this file avoids dynamic SQL construction
  // elsewhere (see the review route), so this stays consistent with that.
  if (method === "POST" && parts.length === 3 && parts[1] === "categories") {
    const id = Number(parts[2]);
    const existing = await findActiveCategory(env, id);
    if (!existing) return jsonResponse({ error: "not found" }, { status: 404 });

    const body = await request.json();
    const name = body.name !== undefined ? body.name : existing.name;
    if (!name || typeof name !== "string") {
      return jsonResponse({ error: "name is required" }, { status: 400 });
    }

    let parentId = existing.parent_id;
    if (body.parent_id !== undefined) {
      const parent = await resolveValidCategoryId(env, body.parent_id);
      if (!parent.ok) return jsonResponse({ error: parent.error }, { status: 400 });
      if (parent.id !== null && (parent.id === id || (await wouldCreateCycle(env, id, parent.id)))) {
        return jsonResponse({ error: "that would create a cycle (a category cannot be its own ancestor)" }, { status: 400 });
      }
      parentId = parent.id;
    }

    const todoistProjectId = body.todoist_project_id !== undefined ? body.todoist_project_id : existing.todoist_project_id;

    await env.DB.prepare(
      `UPDATE categories SET name = ?, parent_id = ?, todoist_project_id = ? WHERE id = ?`
    )
      .bind(name, parentId, todoistProjectId, id)
      .run();
    const updated = await env.DB.prepare(`SELECT * FROM categories WHERE id = ?`).bind(id).first();
    return jsonResponse(updated);
  }

  // DELETE /api/categories/:id — safe archive: blocked (400) if active
  // subcategories or active topics still reference it, so nothing gets
  // silently orphaned. Never cascades.
  if (method === "DELETE" && parts.length === 3 && parts[1] === "categories") {
    const id = Number(parts[2]);
    const childCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM categories WHERE parent_id = ? AND archived = 0`
    ).bind(id).first();
    const topicCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM topics WHERE category_id = ? AND archived = 0`
    ).bind(id).first();

    if (childCount.n > 0 || topicCount.n > 0) {
      const reasons = [];
      if (childCount.n > 0) reasons.push(`${childCount.n} active subcategor${childCount.n === 1 ? "y" : "ies"}`);
      if (topicCount.n > 0) reasons.push(`${topicCount.n} active topic${topicCount.n === 1 ? "" : "s"}`);
      return jsonResponse(
        { error: `Cannot archive: ${reasons.join(" and ")} still reference this category. Reassign or archive them first.` },
        { status: 400 }
      );
    }

    await env.DB.prepare(`UPDATE categories SET archived = 1 WHERE id = ?`).bind(id).run();
    return jsonResponse({ ok: true });
  }

  // GET /api/todoist/projects — proxies Todoist's project list so the
  // frontend can offer a destination picker without holding the token itself.
  if (method === "GET" && parts.length === 3 && parts[1] === "todoist" && parts[2] === "projects") {
    if (!env.TODOIST_API_TOKEN) {
      return jsonResponse({ error: "TODOIST_API_TOKEN not configured" }, { status: 503 });
    }
    // Todoist's REST v2 API is fully decommissioned (410 Gone) — confirmed
    // by hand against the real API. The unified /api/v1/ API also changed
    // this endpoint's response shape from a bare array to { results: [...] }
    // (pagination wrapper); task creation below was NOT similarly wrapped —
    // verified both shapes directly rather than assuming they moved together.
    const res = await fetch("https://api.todoist.com/api/v1/projects", {
      headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
    });
    if (!res.ok) {
      return jsonResponse({ error: "failed to fetch Todoist projects" }, { status: 502 });
    }
    const { results } = await res.json();
    return jsonResponse(results.map((p) => ({ id: p.id, name: p.name, parent_id: p.parent_id || null })));
  }

  // GET /api/sync-status — last cron-driven Todoist operation of each kind,
  // so a silent failure shows up in the UI instead of only in the Worker's
  // own logs. `null` for an operation that hasn't shipped/run yet.
  if (method === "GET" && parts.length === 2 && parts[1] === "sync-status") {
    const operations = ["push", "import", "completion_sync"];
    const result = {};
    for (const operation of operations) {
      const row = await env.DB.prepare(
        `SELECT run_at, ok, succeeded, failed, detail FROM sync_log WHERE operation = ? ORDER BY id DESC LIMIT 1`
      ).bind(operation).first();
      if (!row) {
        result[operation] = null;
        continue;
      }
      // Instant-to-instant duration, not a "which calendar day" question —
      // deliberately doesn't need the +330 minutes/nowIST() IST treatment
      // that date-bucketing queries elsewhere in this file do. SQLite's
      // datetime('now') is UTC but formatted as "YYYY-MM-DD HH:MM:SS" (space,
      // no zone) — not valid ISO 8601, and Date.parse on that exact shape is
      // engine-dependent (some parse it as local time). Normalize to a real
      // UTC ISO string before parsing.
      const staleMs = 26 * 60 * 60 * 1000;
      const runAtUtc = row.run_at.replace(" ", "T") + "Z";
      const stale = Date.now() - Date.parse(runAtUtc) > staleMs;
      result[operation] = { ...row, ok: !!row.ok, stale };
    }
    return jsonResponse(result);
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
        `INSERT INTO reviews (topic_id, quality, ef_before, ef_after, interval_before, interval_after,
                               repetitions_before, next_due_before, last_reviewed_before)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, quality, before.ef, after.ef, before.interval_days, after.interval_days,
        before.repetitions, topic.next_due, topic.last_reviewed
      ),
    ]);

    const updated = await env.DB.prepare(`SELECT * FROM topics WHERE id = ?`).bind(id).first();
    return jsonResponse(updated);
  }

  // POST /api/topics/:id/undo-review — reverts the topic's most recent
  // review: restores its exact prior ef/interval_days/repetitions/next_due/
  // last_reviewed and deletes that review row. Always acts on "whichever
  // review is currently latest" for this topic rather than a client-supplied
  // review id — no stale-id race to guard, since the frontend's single
  // global undo-toast slot means a new review always replaces any pending
  // undo before this could be called on the wrong one.
  if (method === "POST" && parts.length === 4 && parts[1] === "topics" && parts[3] === "undo-review") {
    const id = Number(parts[2]);
    const review = await env.DB.prepare(
      `SELECT * FROM reviews WHERE topic_id = ? ORDER BY id DESC LIMIT 1`
    ).bind(id).first();
    if (!review) return jsonResponse({ error: "no review to undo" }, { status: 400 });
    if (review.next_due_before === null) {
      return jsonResponse({ error: "this review predates undo support" }, { status: 400 });
    }

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE topics SET ef = ?, interval_days = ?, repetitions = ?, next_due = ?, last_reviewed = ? WHERE id = ?`
      ).bind(
        review.ef_before, review.interval_before, review.repetitions_before,
        review.next_due_before, review.last_reviewed_before, id
      ),
      env.DB.prepare(`DELETE FROM reviews WHERE id = ?`).bind(review.id),
    ]);

    const updated = await env.DB.prepare(`SELECT * FROM topics WHERE id = ?`).bind(id).first();
    if (!updated) return jsonResponse({ error: "not found" }, { status: 404 });
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
/**
 * Resolves which Todoist project a topic's revision task should land in:
 * the topic's own override -> its category's override -> the nearest
 * ancestor category's override -> the global default. A JS loop rather
 * than a recursive SQL CTE — this runs once per due topic once per day
 * inside the cron, against a tree at most a few levels deep, and a plain
 * loop is far easier to verify by inspection than CTE semantics (same
 * "boring beats clever" call made for the SM-2 math and the auth compare).
 */
async function resolveTodoistProjectId(env, topic) {
  if (topic.todoist_project_id) return topic.todoist_project_id;

  let categoryId = topic.category_id;
  const seen = new Set();
  while (categoryId && !seen.has(categoryId)) {
    seen.add(categoryId);
    const category = await env.DB.prepare(
      `SELECT todoist_project_id, parent_id FROM categories WHERE id = ?`
    ).bind(categoryId).first();
    if (!category) break; // dangling reference — fall through to the default
    if (category.todoist_project_id) return category.todoist_project_id;
    categoryId = category.parent_id;
  }
  return env.TODOIST_PROJECT_ID;
}

async function pushToTodoist(env, topic) {
  if (topic.todoist_task_id) {
    // Already pushed. Steady doesn't try to re-sync completion state here —
    // the user checks the task off in Todoist, which is the whole point.
    return;
  }

  const projectId = await resolveTodoistProjectId(env, topic);
  // See the /api/todoist/projects route for why this is /api/v1/ now, not
  // /rest/v2/ — task creation's response shape is unaffected by the same
  // migration (confirmed directly: still a plain task object with .id at
  // the top level, not wrapped like the projects list response is).
  const res = await fetch("https://api.todoist.com/api/v1/tasks", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: `Review: ${topic.title}`,
      project_id: projectId,
      labels: [env.REVISION_LABEL || "revision"],
      due_string: "today",
    }),
  });

  if (!res.ok) {
    // Throw rather than swallow: runDailyPush's try/catch is what turns
    // this into a counted failure for the sync-status health-check. This
    // exact swallow-and-return was how the REST v2 decommission stayed
    // invisible all last session — don't repeat it here.
    throw new Error(`Todoist push failed for topic ${topic.id}: ${res.status} ${await res.text()}`);
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

  let succeeded = 0;
  let failed = 0;
  for (const topic of results) {
    try {
      await pushToTodoist(env, topic);
      succeeded++;
    } catch (err) {
      // One bad topic (network blip, bad project id, etc.) shouldn't stop
      // the rest of today's batch from reaching Todoist.
      console.error(`pushToTodoist threw for topic ${topic.id}: ${err}`);
      failed++;
    }
  }
  return { succeeded, failed };
}

// Wraps a cron-driven Todoist operation so it always produces exactly one
// sync_log row, whether it succeeds, partially fails, or throws outright -
// the whole point is that a silent failure (like the REST v2 decommission
// this project already hit once) shows up here instead of only ever in a
// console.error nobody's watching.
async function runOperation(env, operation, fn) {
  try {
    const { succeeded, failed } = await fn(env);
    await env.DB.prepare(
      `INSERT INTO sync_log (operation, ok, succeeded, failed) VALUES (?, 1, ?, ?)`
    ).bind(operation, succeeded, failed).run();
  } catch (err) {
    try {
      await env.DB.prepare(
        `INSERT INTO sync_log (operation, ok, succeeded, failed, detail) VALUES (?, 0, 0, 0, ?)`
      ).bind(operation, String(err)).run();
    } catch (logErr) {
      console.error(`sync_log write itself failed for ${operation}: ${logErr}`);
    }
  }
}

async function runScheduledSync(env) {
  await runOperation(env, "push", runDailyPush);
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
    ctx.waitUntil(runScheduledSync(env));
  },
};
