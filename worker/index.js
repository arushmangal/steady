/**
 * Steady — Cloudflare Worker
 *
 * Routes:
 *   GET    /api/topics              list active topics, ordered by next_due
 *   POST   /api/topics              create a topic { title, notes?, category_id?, todoist_project_id?, studied_on? } - studied_on (YYYY-MM-DD, not future) backdates next_due, default today
 *   POST   /api/topics/bulk         backlog import { items: [{ title, next_due }], category_id?, todoist_project_id? } - staggered first-review dates, exam-capped
 *   POST   /api/topics/:id          edit-mode save: { title, category_id?, todoist_project_id? } together (title required, others clear when omitted)
 *   POST   /api/topics/:id/review   record a review { quality: 0-5, minutes_spent? } -> runs SM-2; if the topic has no live Todoist task yet, pushes one first so the review has something to reflect, then appends "*Xhrs Ymins" and closes it either way, returns updated topic
 *   POST   /api/topics/:id/undo-review  revert the topic's most recent review (400 if none, or too old to undo)
 *   POST   /api/topics/:id/category reassign a topic's category on its own { category_id }
 *   POST   /api/topics/:id/project  set/clear a topic's own Todoist project override { todoist_project_id }
 *   DELETE /api/topics/:id          archive a topic
 *   GET    /api/categories          list active categories (flat; frontend builds the tree)
 *   POST   /api/categories          create a category { name, parent_id?, todoist_project_id?, exam_date? }
 *   POST   /api/categories/:id      update a category (rename / reparent / change Todoist override / exam_date) - re-clamps topics to any exam cap
 *   DELETE /api/categories/:id      archive a category (blocked if it has active children/topics)
 *   GET    /api/stats               28-day review counts, for the activity heatmap
 *   GET    /api/calendar            due-topic counts/titles by day, for a given month
 *   GET    /api/todoist/projects    list Todoist projects (for the destination picker)
 *   GET    /api/sync-status         last cron-driven Todoist operation of each kind (push/import/completion_sync)
 *   POST   /api/push-now            manually run just the push operation on demand (bypasses the cron's daily wait)
 *   POST   /api/completion-sync-now manually run just the Todoist -> Steady completion sync on demand
 *   POST   /api/login               { username, password } -> 30-day signed session cookie (public; see checkAuth)
 *   POST   /api/logout              clears the session cookie
 *
 * Anything else falls through to the static assets binding (the frontend in /public).
 *
 * Scheduled (cron, see wrangler.toml): once a day, runs three operations in
 * sequence, each logged to sync_log independently via runOperation.
 * STEADY_LABEL (default "steady") is the one sync gate for both directions;
 * REVISION_LABEL (default "review") means "there's already a live
 * outstanding revision task for this topic". (1) pushes topics due
 * today/overdue to Todoist, labelled both REVISION_LABEL and STEADY_LABEL,
 * at priority 4 (Todoist's API value for the UI's "P1", its highest). A
 * topic whose existing todoist_task_id was deleted in Todoist (not
 * completed, just deleted) is detected - via that task's `is_deleted: true`
 * flag, not a 404, since Todoist soft-deletes - and gets a fresh task
 * pushed instead of being silently skipped forever.
 * (2) imports any STEADY_LABEL task that does NOT yet carry REVISION_LABEL
 * as a new topic, adopting that exact task as the topic's own
 * todoist_task_id and adding REVISION_LABEL to it - a task already carrying
 * REVISION_LABEL is already tracked and is skipped. (3) syncs completed
 * STEADY_LABEL tasks back into Steady as reviews: a bare 0-5 digit in the
 * task's latest comment is the confidence rating (no digit -> no SM-2
 * change at all, the task is reopened in place and re-due today instead of
 * a new one being created), and a "*Xhrs Ymins" line in the task's
 * description is read back as minutes_spent. A task carrying only
 * REVISION_LABEL (no STEADY_LABEL) is not synced by either direction.
 */

// This app is single-user and that user is on IST (UTC+5:30, no DST) — see
// CLAUDE.md. Every "what day is it" calculation anchors on IST, not raw UTC,
// otherwise the app thinks it's still yesterday until 5:30am IST. If the
// user's timezone ever changes, this constant is the one place to update.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const nowIST = () => new Date(Date.now() + IST_OFFSET_MS);
const todayISO = () => nowIST().toISOString().slice(0, 10);

// Shifts a YYYY-MM-DD date string by whole days. Date-only ISO strings
// parse as UTC midnight per spec, so this is pure calendar arithmetic with
// no timezone involvement.
function shiftISO(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

// --- Exam-date cap ---------------------------------------------------------
// A category (a "course") can carry an exam_date. Every topic in its subtree
// has its schedule capped so no review jumps past the exam, and the last
// pass before it lands 2-3 days ahead of it. Mirrored by examCapDate() in
// public/index.html - change both together (see CLAUDE.md).

// id -> { parent_id, exam_date } for every category, archived included
// (a topic's chain should resolve the same regardless). Tiny table, one query.
async function loadCategoryMap(env) {
  const { results } = await env.DB.prepare(`SELECT id, parent_id, exam_date FROM categories`).all();
  return Object.fromEntries(results.map((c) => [c.id, c]));
}

// Every exam_date set on a category or any of its ancestors - a topic in a
// midterm subcategory nested under a course with its own final is bound by
// both. Bounded by `seen`, same idiom as resolveTodoistProjectId.
function examDatesFor(categoryMap, categoryId) {
  const dates = [];
  const seen = new Set();
  let cur = categoryId;
  while (cur && !seen.has(cur) && categoryMap[cur]) {
    seen.add(cur);
    if (categoryMap[cur].exam_date) dates.push(categoryMap[cur].exam_date);
    cur = categoryMap[cur].parent_id;
  }
  return dates;
}

/**
 * The latest date a topic's next_due may sit at, or null for no cap. For
 * each upcoming exam: if the topic hasn't had its final pass yet (last
 * reviewed before exam-3), next_due may be no later than exam-2 (or today,
 * if that's already past). A review made on or after exam-3 IS the final
 * pass, so that exam stops constraining the topic - otherwise a review at
 * exam-3 would be capped to a redundant second pass at exam-2.
 *
 * Callers pass lastReviewed = today when capping a review that's just
 * happened, the topic's real last_reviewed when re-clamping existing
 * schedules, and null for brand-new topics.
 */
function examCapDate(examDates, lastReviewed, today) {
  let cap = null;
  for (const exam of examDates) {
    if (exam < today) continue; // already sat
    if (lastReviewed && lastReviewed >= shiftISO(exam, -3)) continue; // final pass done
    const finalPass = shiftISO(exam, -2);
    const limit = finalPass > today ? finalPass : today;
    if (cap === null || limit < cap) cap = limit;
  }
  return cap;
}

/**
 * Pulls in any active topic whose next_due sits past its exam cap. Run after
 * anything that can change a topic's cap without a review happening - a
 * category's exam_date or parent changing, or a topic moving category -
 * so setting an exam date affects already-scheduled topics, not just future
 * reviews. Touches next_due only, never interval_days: the exam pulls a
 * review earlier, it doesn't erase the interval already earned (same as any
 * early review, which sm2()'s Math.max floor already never penalizes).
 * Recomputes everything rather than tracking which subtree changed - at
 * this app's scale that's one cheap pass, and it can't miss a case.
 */
async function reclampAllTopics(env) {
  const categoryMap = await loadCategoryMap(env);
  const { results } = await env.DB.prepare(
    `SELECT id, category_id, next_due, last_reviewed FROM topics WHERE archived = 0 AND category_id IS NOT NULL`
  ).all();
  const today = todayISO();
  const updates = [];
  for (const t of results) {
    const cap = examCapDate(examDatesFor(categoryMap, t.category_id), t.last_reviewed, today);
    if (cap && t.next_due > cap) {
      updates.push(env.DB.prepare(`UPDATE topics SET next_due = ? WHERE id = ?`).bind(cap, t.id));
    }
  }
  if (updates.length) await env.DB.batch(updates);
}

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
 * A short, plain-language read on a topic's recent review history - not a
 * chart, not raw EF numbers. `qualities` is oldest-to-newest. Returns null
 * below 3 reviews (with 1-2 points any trend claim is noise), matching the
 * "invisible until earned" restraint already used for category headers.
 * First matching rule wins, most-specific first.
 */
function classifyTrajectory(qualities) {
  const n = qualities.length;
  if (n < 3) return null;

  const trailingStreak = (pred) => {
    let c = 0;
    for (let i = n - 1; i >= 0 && pred(qualities[i]); i--) c++;
    return c;
  };

  const solid = trailingStreak((q) => q >= 4);
  if (n >= 5 && solid >= 5) return `Rock solid — ${solid} clean reviews in a row.`;

  const struggling = trailingStreak((q) => q < 3); // <3 is SM-2's own lapse threshold
  if (struggling >= 2) return `You've struggled with this one recently.`;

  const w = Math.min(3, Math.floor(n / 2));
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const recent = avg(qualities.slice(n - w));
  const prior = avg(qualities.slice(n - 2 * w, n - w));

  if (recent - prior >= 0.5) return `Recall's been improving over your last ${w} reviews.`;
  if (prior - recent >= 0.5) return `This one's gotten harder to recall lately.`;
  return `Holding steady on this one.`;
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

/**
 * Records a review for a topic and returns its updated row, or null if the
 * topic doesn't exist. The one place review-application logic lives -
 * exactly one code path applies a review whether it's triggered by a user's
 * click in the Steady UI (the /review route below) or by the Todoist
 * completion-sync cron (runCompletionSync). Also the one place that clears
 * topics.todoist_task_id/unconfirmed_completion_at after a review, so a
 * topic reviewed via either trigger becomes push-eligible again the same
 * way (previously only the completion-sync path cleared this column at
 * all, so a topic reviewed from Steady's own UI could never be pushed a
 * second time - the exact same class of bug already fixed for the other
 * trigger, just not this one).
 *
 * `defer`, when given, receives the best-effort Todoist follow-up (push /
 * append time / close) as a promise instead of it being awaited - the /review
 * route passes ctx.waitUntil, so the response goes back the moment the SM-2
 * write lands rather than after 3-4 sequential Todoist round-trips (which
 * made every rating in the UI hang for a second or two). The cron path
 * passes nothing and awaits as before - it's already off the request path.
 */
async function applyReview(env, id, quality, minutesSpent, defer) {
  const topic = await env.DB.prepare(`SELECT * FROM topics WHERE id = ?`).bind(id).first();
  if (!topic) return null;

  const elapsedDays = topic.last_reviewed
    ? Math.round((Date.parse(todayISO()) - Date.parse(topic.last_reviewed)) / 86400000)
    : 0;

  const before = { ef: topic.ef, interval_days: topic.interval_days, repetitions: topic.repetitions };
  const after = sm2(before, quality, elapsedDays);

  // Exam cap: the review just happened today, so that's its lastReviewed.
  // Only next_due moves - interval_days stays what SM-2 earned (see
  // reclampAllTopics for why), and reviews.interval_after records the same.
  if (topic.category_id) {
    const cap = examCapDate(examDatesFor(await loadCategoryMap(env), topic.category_id), todayISO(), todayISO());
    if (cap && after.next_due > cap) after.next_due = cap;
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE topics SET ef = ?, interval_days = ?, repetitions = ?, next_due = ?, last_reviewed = ?,
                          todoist_task_id = NULL, unconfirmed_completion_at = NULL WHERE id = ?`
    ).bind(after.ef, after.interval_days, after.repetitions, after.next_due, todayISO(), id),
    env.DB.prepare(
      `INSERT INTO reviews (topic_id, quality, ef_before, ef_after, interval_before, interval_after,
                             repetitions_before, next_due_before, last_reviewed_before, minutes_spent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, quality, before.ef, after.ef, before.interval_days, after.interval_days,
      before.repetitions, topic.next_due, topic.last_reviewed, minutesSpent ?? null
    ),
  ]);

  // Best-effort only: none of this should ever block the review itself
  // (the SM-2 update above) from succeeding. Closing an already-completed
  // task (the completion-sync trigger, where the user closed it in
  // Todoist themselves) is expected to be a harmless no-op.
  const followUp = syncReviewToTodoist(env, topic, minutesSpent);
  if (defer) defer(followUp);
  else await followUp;

  return env.DB.prepare(`SELECT * FROM topics WHERE id = ?`).bind(id).first();
}

async function syncReviewToTodoist(env, topic, minutesSpent) {
  const id = topic.id;
  let taskId = topic.todoist_task_id;
  if (!taskId) {
    // Reviewed before ever being pushed (e.g. the same day a topic was
    // added, before the next cron/push-now) - previously this silently
    // left nothing in Todoist to show for the review at all. Push a task
    // now so there's genuinely something to reflect, then complete it
    // immediately below like any already-pushed topic, since the review
    // already happened.
    try {
      await pushToTodoist(env, topic);
      const pushed = await env.DB.prepare(`SELECT todoist_task_id FROM topics WHERE id = ?`).bind(id).first();
      taskId = pushed?.todoist_task_id || null;
    } catch (err) {
      console.error(`Failed to push a fresh Todoist task for topic ${id} during review: ${err}`);
    }
  }
  if (taskId) {
    if (minutesSpent != null) {
      try {
        await appendTimeToTodoistTask(env, taskId, minutesSpent);
      } catch (err) {
        console.error(`Failed to append time-spent to Todoist task ${taskId}: ${err}`);
      }
    }
    try {
      await closeTodoistTask(env, taskId);
    } catch (err) {
      console.error(`Failed to close Todoist task ${taskId}: ${err}`);
    }
    // If a fresh task was pushed just above, pushToTodoist's own write
    // left todoist_task_id pointing at it - but it's already closed, so
    // that would violate the "todoist_task_id is the CURRENT cycle's
    // *outstanding* task" invariant pushToTodoist itself relies on to
    // decide whether a topic still needs pushing. Clear it back to NULL,
    // same as the SM-2 batch above already does for the pre-existing-task
    // case.
    if (taskId !== topic.todoist_task_id) {
      await env.DB.prepare(`UPDATE topics SET todoist_task_id = NULL WHERE id = ?`).bind(id).run();
    }
  }
}

/**
 * Appends "*Xhrs Ymins" to a Todoist task's description (on a new line,
 * preserving whatever's already there rather than overwriting it — the
 * task may carry notes the user added by hand).
 */
async function appendTimeToTodoistTask(env, taskId, minutesSpent) {
  const getRes = await fetch(`https://api.todoist.com/api/v1/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
  });
  if (!getRes.ok) {
    throw new Error(`Failed to fetch task ${taskId}: ${getRes.status} ${await getRes.text()}`);
  }
  const task = await getRes.json();

  const hours = Math.floor(minutesSpent / 60);
  const mins = minutesSpent % 60;
  const note = `*${hours}hrs ${mins}mins`;
  const description = task.description ? `${task.description}\n${note}` : note;

  const updateRes = await fetch(`https://api.todoist.com/api/v1/tasks/${taskId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ description }),
  });
  if (!updateRes.ok) {
    throw new Error(`Failed to update task ${taskId} description: ${updateRes.status} ${await updateRes.text()}`);
  }
}

// Marks a Todoist task complete. Called whenever applyReview() runs on a
// topic with a live todoist_task_id, regardless of trigger - completing an
// already-completed task (the completion-sync trigger, where the user
// closed it in Todoist themselves) is a harmless no-op.
async function closeTodoistTask(env, taskId) {
  const res = await fetch(`https://api.todoist.com/api/v1/tasks/${taskId}/close`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to close Todoist task ${taskId}: ${res.status} ${await res.text()}`);
  }
}

// Reopens a completed Todoist task and resets its due date to today.
// Used by runCompletionSync when a completed task has no parseable
// confidence digit - the same task reappears due today rather than a new
// one being created, so nothing about which project/section it lived in
// needs to be tracked or reconstructed.
async function reopenTodoistTask(env, taskId) {
  const reopenRes = await fetch(`https://api.todoist.com/api/v1/tasks/${taskId}/reopen`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
  });
  if (!reopenRes.ok) {
    throw new Error(`Failed to reopen Todoist task ${taskId}: ${reopenRes.status} ${await reopenRes.text()}`);
  }
  const dueRes = await fetch(`https://api.todoist.com/api/v1/tasks/${taskId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ due_string: "today" }),
  });
  if (!dueRes.ok) {
    throw new Error(`Failed to reset due date for task ${taskId}: ${dueRes.status} ${await dueRes.text()}`);
  }
}

async function handleApi(request, env, url, ctx) {
  const method = request.method;
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "topics", ...]

  // GET /api/topics
  if (method === "GET" && parts.length === 2 && parts[1] === "topics") {
    const { results } = await env.DB.prepare(
      `SELECT * FROM topics WHERE archived = 0 ORDER BY next_due ASC`
    ).all();

    const { results: reviewRows } = await env.DB.prepare(
      `SELECT r.topic_id, r.quality, r.minutes_spent, r.reviewed_at FROM reviews r
       JOIN topics t ON t.id = r.topic_id
       WHERE t.archived = 0
       ORDER BY r.topic_id, r.id ASC`
    ).all();
    const qualitiesByTopic = {};
    const reviewsByTopic = {};
    for (const row of reviewRows) {
      (qualitiesByTopic[row.topic_id] ||= []).push(row.quality);
      (reviewsByTopic[row.topic_id] ||= []).push(row);
    }
    const RECENT_REVIEWS_LIMIT = 6;
    for (const topic of results) {
      topic.trajectory_note = classifyTrajectory(qualitiesByTopic[topic.id] || []);
      const allReviews = reviewsByTopic[topic.id] || [];
      topic.recent_reviews = allReviews
        .slice(-RECENT_REVIEWS_LIMIT)
        .reverse()
        .map((r) => ({ quality: r.quality, minutes_spent: r.minutes_spent, reviewed_at: r.reviewed_at }));
      topic.total_minutes_spent = allReviews.reduce((sum, r) => sum + (r.minutes_spent || 0), 0);
      // Latest confidence rating, for the per-course exam readiness view.
      topic.last_quality = allReviews.length ? allReviews[allReviews.length - 1].quality : null;
    }

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

    // studied_on: optional backdate for when this was actually first
    // studied (e.g. logging a session a few days late). Anchors next_due
    // to that date instead of today, same as standard SRS semantics — a
    // topic "studied" 3 days ago and never reviewed since is genuinely
    // 3 days overdue, not freshly due today. Defaults to today, so a
    // normal add is byte-for-byte unchanged from before this existed.
    let due = todayISO();
    if (body.studied_on !== undefined && body.studied_on !== null && body.studied_on !== "") {
      if (typeof body.studied_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.studied_on)) {
        return jsonResponse({ error: "studied_on must be an ISO date (YYYY-MM-DD)" }, { status: 400 });
      }
      if (body.studied_on > due) {
        return jsonResponse({ error: "studied_on cannot be in the future" }, { status: 400 });
      }
      due = body.studied_on;
    }
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

  // POST /api/topics/bulk — backlog import { items: [{ title, next_due }],
  // category_id?, todoist_project_id? }. The frontend computes the staggered
  // first-review dates (so it can preview the spread before importing); the
  // server only validates them (today or later) and re-applies the exam cap,
  // so a stale or hand-crafted request still can't schedule past an exam.
  // One batch, so a partial import can't happen.
  if (method === "POST" && parts.length === 3 && parts[1] === "topics" && parts[2] === "bulk") {
    const body = await request.json();
    const items = body.items;
    if (!Array.isArray(items) || !items.length) {
      return jsonResponse({ error: "items must be a non-empty array" }, { status: 400 });
    }
    if (items.length > 500) {
      return jsonResponse({ error: "at most 500 topics per import" }, { status: 400 });
    }
    const category = await resolveValidCategoryId(env, body.category_id);
    if (!category.ok) return jsonResponse({ error: category.error }, { status: 400 });

    const today = todayISO();
    const cap = category.id
      ? examCapDate(examDatesFor(await loadCategoryMap(env), category.id), null, today)
      : null;
    const statements = [];
    for (const item of items) {
      const title = typeof item?.title === "string" ? item.title.trim() : "";
      if (!title) return jsonResponse({ error: "every item needs a title" }, { status: 400 });
      if (!isISODate(item.next_due) || item.next_due < today) {
        return jsonResponse({ error: `next_due for "${title}" must be an ISO date, today or later` }, { status: 400 });
      }
      const due = cap && item.next_due > cap ? cap : item.next_due;
      statements.push(
        env.DB.prepare(
          `INSERT INTO topics (title, next_due, todoist_project_id, category_id) VALUES (?, ?, ?, ?)`
        ).bind(title, due, body.todoist_project_id || null, category.id)
      );
    }
    await env.DB.batch(statements);
    return jsonResponse({ created: statements.length }, { status: 201 });
  }

  // POST /api/topics/:id — general edit-mode save: title, category, and
  // Todoist project override together, in one request (the fields a topic
  // is actually created with, per CLAUDE.md's long-open "richer topic
  // editing" question — scheduling state like next_due/EF is deliberately
  // untouched here, it's not something the user "inputs"). All three
  // fields are sent together every time (matching the category manager's
  // own edit-save pattern) — not partial-patch semantics.
  if (method === "POST" && parts.length === 3 && parts[1] === "topics") {
    const id = Number(parts[2]);
    const existing = await env.DB.prepare(`SELECT id FROM topics WHERE id = ?`).bind(id).first();
    if (!existing) return jsonResponse({ error: "not found" }, { status: 404 });

    const body = await request.json();
    if (!body.title || typeof body.title !== "string") {
      return jsonResponse({ error: "title is required" }, { status: 400 });
    }
    const category = await resolveValidCategoryId(env, body.category_id);
    if (!category.ok) return jsonResponse({ error: category.error }, { status: 400 });

    await env.DB.prepare(
      `UPDATE topics SET title = ?, category_id = ?, todoist_project_id = ? WHERE id = ?`
    )
      .bind(body.title, category.id, body.todoist_project_id || null, id)
      .run();
    await reclampAllTopics(env); // moving into a course with an exam can pull next_due in
    const updated = await env.DB.prepare(`SELECT * FROM topics WHERE id = ?`).bind(id).first();
    return jsonResponse(updated);
  }

  // POST /api/topics/:id/category — reassign a topic's category on its own,
  // without touching title/project. Superseded as the frontend's edit-mode
  // trigger by the combined POST /api/topics/:id above, but left in place —
  // still a valid, narrower way to do just this one thing.
  if (method === "POST" && parts.length === 4 && parts[1] === "topics" && parts[3] === "category") {
    const id = Number(parts[2]);
    const topic = await env.DB.prepare(`SELECT id FROM topics WHERE id = ?`).bind(id).first();
    if (!topic) return jsonResponse({ error: "not found" }, { status: 404 });

    const body = await request.json();
    const category = await resolveValidCategoryId(env, body.category_id);
    if (!category.ok) return jsonResponse({ error: category.error }, { status: 400 });

    await env.DB.prepare(`UPDATE topics SET category_id = ? WHERE id = ?`).bind(category.id, id).run();
    await reclampAllTopics(env);
    const updated = await env.DB.prepare(`SELECT * FROM topics WHERE id = ?`).bind(id).first();
    return jsonResponse(updated);
  }

  // POST /api/topics/:id/project — set/clear a topic's own Todoist project
  // override. This is the value resolveTodoistProjectId() checks first, so
  // it wins outright over any category-level override — see the doc comment
  // on resolveTodoistProjectId for the full resolution order. Not validated
  // against the live Todoist project list server-side, same as project
  // creation/category overrides elsewhere in this file — the frontend picker
  // is the source of valid ids.
  if (method === "POST" && parts.length === 4 && parts[1] === "topics" && parts[3] === "project") {
    const id = Number(parts[2]);
    const topic = await env.DB.prepare(`SELECT id FROM topics WHERE id = ?`).bind(id).first();
    if (!topic) return jsonResponse({ error: "not found" }, { status: 404 });

    const body = await request.json();
    await env.DB.prepare(`UPDATE topics SET todoist_project_id = ? WHERE id = ?`)
      .bind(body.todoist_project_id || null, id)
      .run();
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
    const examDate = body.exam_date || null;
    if (examDate !== null && !isISODate(examDate)) {
      return jsonResponse({ error: "exam_date must be an ISO date (YYYY-MM-DD)" }, { status: 400 });
    }

    // A brand-new category has no topics yet, so nothing to re-clamp.
    const { meta } = await env.DB.prepare(
      `INSERT INTO categories (name, parent_id, todoist_project_id, exam_date) VALUES (?, ?, ?, ?)`
    )
      .bind(body.name, parent.id, body.todoist_project_id ?? null, examDate)
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

    // Clearing an exam date (null/"") doesn't push anything back out - topics
    // already pulled in just come due a little early, and their next real
    // review reschedules them normally.
    let examDate = existing.exam_date;
    if (body.exam_date !== undefined) {
      examDate = body.exam_date || null;
      if (examDate !== null && !isISODate(examDate)) {
        return jsonResponse({ error: "exam_date must be an ISO date (YYYY-MM-DD)" }, { status: 400 });
      }
    }

    await env.DB.prepare(
      `UPDATE categories SET name = ?, parent_id = ?, todoist_project_id = ?, exam_date = ? WHERE id = ?`
    )
      .bind(name, parentId, todoistProjectId, examDate, id)
      .run();
    // Setting an exam date, or reparenting under a course that has one,
    // changes the cap on every topic underneath - apply it now, not only at
    // each topic's next review.
    await reclampAllTopics(env);
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

  // POST /api/push-now — runs just the push operation immediately instead of
  // waiting for the daily cron, for e.g. right after editing a topic's
  // project override and wanting it in Todoist now. Goes through the same
  // runOperation wrapper as the cron path, so it produces a real sync_log
  // row too — a manual push that failed shouldn't be any less visible than
  // a cron-driven one. Import/completion-sync are deliberately not run here
  // — this button is scoped to exactly what it says: pushing, not a full
  // three-operation sync.
  if (method === "POST" && parts.length === 2 && parts[1] === "push-now") {
    await runOperation(env, "push", runDailyPush);
    const row = await env.DB.prepare(
      `SELECT run_at, ok, succeeded, failed, detail FROM sync_log WHERE operation = 'push' ORDER BY id DESC LIMIT 1`
    ).first();
    return jsonResponse({ ...row, ok: !!row.ok });
  }

  // POST /api/completion-sync-now — runs just the Todoist -> Steady
  // completion sync immediately instead of waiting for the daily cron, for
  // pulling in a just-completed task's confidence rating without a wait of
  // up to 24h. Same shape as push-now: goes through runOperation so it
  // still produces a real sync_log row, and is scoped to exactly this one
  // operation (not import, not push).
  if (method === "POST" && parts.length === 2 && parts[1] === "completion-sync-now") {
    await runOperation(env, "completion_sync", runCompletionSync);
    const row = await env.DB.prepare(
      `SELECT run_at, ok, succeeded, failed, detail FROM sync_log WHERE operation = 'completion_sync' ORDER BY id DESC LIMIT 1`
    ).first();
    return jsonResponse({ ...row, ok: !!row.ok });
  }

  // POST /api/topics/:id/review
  if (method === "POST" && parts.length === 4 && parts[1] === "topics" && parts[3] === "review") {
    const id = Number(parts[2]);
    const body = await request.json();
    const quality = Number(body.quality);
    if (!Number.isInteger(quality) || quality < 0 || quality > 5) {
      return jsonResponse({ error: "quality must be an integer 0-5" }, { status: 400 });
    }
    let minutesSpent = null;
    if (body.minutes_spent !== undefined && body.minutes_spent !== null) {
      minutesSpent = Number(body.minutes_spent);
      if (!Number.isInteger(minutesSpent) || minutesSpent < 0) {
        return jsonResponse({ error: "minutes_spent must be a non-negative integer" }, { status: 400 });
      }
    }

    const updated = await applyReview(env, id, quality, minutesSpent, (p) => ctx.waitUntil(p));
    if (!updated) return jsonResponse({ error: "not found" }, { status: 404 });
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

// Set on every task Steady itself creates, so the completion contract is
// visible right on the task instead of living only in this file/CLAUDE.md —
// the one thing that actually determines whether completing it in Todoist
// updates SM-2 state (a digit comment) or just reopens the task in place
// (runCompletionSync's no-digit path). Not applied to tasks runInboundImport
// adopts, since those are the user's own pre-existing capture notes and
// rewriting their description would be presumptuous.
const COMPLETION_INSTRUCTIONS =
  "Steady: before completing this task, add a comment with a single number " +
  "0-5 for how well you remembered this (0 = nothing, 5 = everything) — " +
  "that's what Steady logs as your review. Complete it with no number yet, " +
  "and Steady reopens this same task, due today, instead of recording a review.";

async function pushToTodoist(env, topic) {
  if (topic.todoist_task_id) {
    // Previously an accepted, documented limitation: if a pushed/adopted
    // task was deleted in Todoist without ever being completed,
    // todoist_task_id stayed pointing at a task that no longer existed and
    // nothing ever detected it, so the topic silently stopped being
    // push-eligible forever. Check the task actually still exists before
    // trusting the "already pushed" guard. Confirmed live: a deleted task's
    // GET /tasks/{id} does NOT 404 - it returns 200 with `is_deleted: true`
    // in the body (Todoist soft-deletes), so a plain res.ok check alone
    // would have missed every real deletion and kept this bug alive. Both
    // that and an actual 404 (defensive - in case some other deletion path
    // ever does return one) count as "gone".
    const checkRes = await fetch(`https://api.todoist.com/api/v1/tasks/${topic.todoist_task_id}`, {
      headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
    });
    let isGone = checkRes.status === 404;
    if (checkRes.ok) {
      const existingTask = await checkRes.json();
      isGone = !!existingTask.is_deleted;
    } else if (checkRes.status !== 404) {
      // A network blip or a transient 5xx isn't proof the task is gone -
      // don't guess and risk creating a duplicate. Let this count as a
      // failed push, same as any other pushToTodoist error, so it's
      // retried next run instead.
      throw new Error(`Failed to check existing Todoist task ${topic.todoist_task_id} for topic ${topic.id}: ${checkRes.status} ${await checkRes.text()}`);
    }
    if (!isGone) {
      // Still there. Steady doesn't try to re-sync completion state here —
      // the user checks the task off in Todoist, which is the whole point.
      return;
    }
    await env.DB.prepare(`UPDATE topics SET todoist_task_id = NULL WHERE id = ?`)
      .bind(topic.id)
      .run();
    topic = { ...topic, todoist_task_id: null };
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
      description: COMPLETION_INSTRUCTIONS,
      project_id: projectId,
      // "review" means "there's a live outstanding revision task for this
      // topic"; "steady" is the actual sync gate for both directions - any
      // task Steady has ever touched can be found by that one label,
      // independent of push/import.
      labels: [env.REVISION_LABEL || "review", env.STEADY_LABEL || "steady"],
      due_string: "today",
      // Todoist's API inverts the UI label: priority 4 is what the UI shows
      // as "P1" (highest), 1 is "P4" (default/lowest). Every pushed revision
      // task is P1 so it's never lost among a project's other, unrelated
      // tasks.
      priority: 4,
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

/**
 * Imports any Todoist task carrying STEADY_LABEL but NOT yet REVISION_LABEL
 * as a new Steady topic, searched globally (not by project/section — the
 * user's real Todoist tree is too deep/varied for that to be a meaningful
 * scope). A task that already carries REVISION_LABEL is already tracked
 * (either a normally-pushed task, or one this function already adopted on
 * a prior run) and is skipped outright - "revision label if already there,
 * great, else steady assigns it."
 *
 * source_todoist_task_id is permanent write-once provenance/dedup for the
 * *original* capture task. todoist_task_id is set to that SAME task's id
 * at import time (not left NULL) - the task is adopted as the topic's own
 * currently-outstanding revision task, which is what makes "any and all
 * tasks linked to steady can be completed from todoist" true on a topic's
 * very first cycle, not just from its second cycle onward.
 *
 * next_due is tomorrow, not today: an immediate same-day bounce-back for
 * something just captured seconds ago would read as noise, not a
 * considered schedule - it only matters if the task sits uncompleted,
 * since a real completion recomputes next_due via SM-2 regardless.
 *
 * The original task keeps existing after import - REVISION_LABEL is added
 * to it (never removed, unlike the old STEADY_IMPORT_LABEL scheme this
 * replaces), since the task may have its own independent Todoist life
 * (due date, other labels) unrelated to being "done".
 */
async function runInboundImport(env) {
  const steadyLabel = env.STEADY_LABEL || "steady";
  const revisionLabel = env.REVISION_LABEL || "review";
  const res = await fetch(`https://api.todoist.com/api/v1/tasks?label=${encodeURIComponent(steadyLabel)}`, {
    headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Todoist label search failed: ${res.status} ${await res.text()}`);
  }
  const { results } = await res.json();

  const tomorrow = nowIST();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const nextDue = tomorrow.toISOString().slice(0, 10);

  let succeeded = 0;
  let failed = 0;
  for (const task of results) {
    try {
      const labels = task.labels || [];
      // "revision label if already there, great" - already tracked, no action.
      if (labels.includes(revisionLabel)) continue;

      // Fresh import candidate. Dedup guard first - self-heals a prior
      // run's label-add failure without re-inserting the topic.
      const existing = await env.DB.prepare(
        `SELECT 1 FROM topics WHERE source_todoist_task_id = ?`
      ).bind(task.id).first();
      if (!existing) {
        await env.DB.prepare(
          `INSERT INTO topics (title, next_due, source_todoist_task_id, todoist_task_id) VALUES (?, ?, ?, ?)`
        ).bind(task.content, nextDue, task.id, task.id).run();
      }

      const updateRes = await fetch(`https://api.todoist.com/api/v1/tasks/${task.id}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ labels: [...labels, revisionLabel] }),
      });
      if (!updateRes.ok) {
        throw new Error(`Failed to add revision label to task ${task.id}: ${updateRes.status} ${await updateRes.text()}`);
      }
      succeeded++;
    } catch (err) {
      console.error(`runInboundImport failed for task ${task.id}: ${err}`);
      failed++;
    }
  }
  return { succeeded, failed };
}

/**
 * Syncs completed Todoist tasks back into Steady as reviews. Filters on
 * STEADY_LABEL, not REVISION_LABEL - "just revision label doesn't mean it
 * goes to steady" - then matches a topic via todoist_task_id equality
 * (unchanged). For each matched completion, reads the task's most recent
 * comment (added since the task was created - inherently scoped, since
 * each review cycle's task is freshly created and never reused) for a
 * bare 0-5 confidence digit, and its description for a "*Xhrs Ymins" line
 * (the reverse direction of appendTimeToTodoistTask's own write) for
 * minutes_spent.
 *
 * A digit found -> applyReview() records the real review (the same shared
 * code path the /review route uses) and, as of that function's own
 * change, clears todoist_task_id/unconfirmed_completion_at itself - no
 * extra bookkeeping needed here.
 *
 * No digit found -> SM-2 state must stay completely untouched (dropping
 * the old default-to-quality-3 behavior entirely). Rather than creating a
 * new task - which would need to resolve/preserve which project the
 * original lived in, and would pile up duplicates across repeated skipped
 * cycles - the SAME task is reopened and re-dued today via
 * reopenTodoistTask(), and unconfirmed_completion_at is set so the
 * frontend can say a completion arrived with no confidence rating. This
 * is self-correcting for free: a reopened task no longer appears in the
 * completed-tasks endpoint on the next run, so there's no risk of
 * reprocessing it before the user completes it again for real.
 */
async function runCompletionSync(env) {
  const steadyLabel = env.STEADY_LABEL || "steady";
  // A generous fixed window (not derived from sync_log's last-successful-run
  // timestamp - that would couple this feature's correctness to another
  // table's data existing/being well-formed) so a missed cron run still
  // gets caught on the next one.
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const until = new Date().toISOString();
  const res = await fetch(
    `https://api.todoist.com/api/v1/tasks/completed/by_completion_date?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
    { headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` } }
  );
  if (!res.ok) {
    throw new Error(`Todoist completed-tasks search failed: ${res.status} ${await res.text()}`);
  }
  const { items } = await res.json();
  // This endpoint's own `label` query param does NOT actually filter
  // (confirmed empirically - unrelated completed tasks came back even when
  // passing a label), so labels are filtered here in JS instead.
  const labeled = items.filter((item) => (item.labels || []).includes(steadyLabel));

  let succeeded = 0;
  let failed = 0;
  for (const task of labeled) {
    try {
      const topic = await env.DB.prepare(
        `SELECT * FROM topics WHERE todoist_task_id = ?`
      ).bind(task.id).first();
      if (!topic) continue; // not a task Steady is currently tracking - not a failure

      const commentsRes = await fetch(`https://api.todoist.com/api/v1/comments?task_id=${task.id}`, {
        headers: { Authorization: `Bearer ${env.TODOIST_API_TOKEN}` },
      });
      if (!commentsRes.ok) {
        throw new Error(`Failed to fetch comments for task ${task.id}: ${commentsRes.status} ${await commentsRes.text()}`);
      }
      const { results: comments } = await commentsRes.json();
      comments.sort((a, b) => Date.parse(a.posted_at) - Date.parse(b.posted_at)); // don't trust implicit ordering
      const latest = comments.length ? comments[comments.length - 1] : null;
      const match = latest ? latest.content.match(/\b[0-5]\b/) : null;

      let minutesSpent = null;
      if (task.description) {
        const timeMatches = [...task.description.matchAll(/\*(\d+)hrs\s+(\d+)mins/g)];
        if (timeMatches.length) {
          const [, h, m] = timeMatches[timeMatches.length - 1]; // last match wins
          minutesSpent = Number(h) * 60 + Number(m);
        }
      }

      if (match) {
        const quality = Number(match[0]);
        const updated = await applyReview(env, topic.id, quality, minutesSpent);
        if (!updated) throw new Error(`applyReview returned nothing for topic ${topic.id}`);
      } else {
        await reopenTodoistTask(env, task.id);
        await env.DB.prepare(
          `UPDATE topics SET unconfirmed_completion_at = datetime('now') WHERE id = ?`
        ).bind(topic.id).run();
      }
      succeeded++;
    } catch (err) {
      console.error(`runCompletionSync failed for task ${task.id}: ${err}`);
      failed++;
    }
  }
  return { succeeded, failed };
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
  await runOperation(env, "import", runInboundImport);
  await runOperation(env, "completion_sync", runCompletionSync);
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

// --- Auth: login page + signed session cookie ------------------------------
//
// Credentials are still env.BASIC_AUTH_USER / env.BASIC_AUTH_PASS (secrets,
// unchanged), but the browser now signs in once on /login and gets a 30-day
// session cookie instead of the native Basic Auth popup - which also fixes
// the installed PWA hitting that popup on every cold launch. The cookie is
// `<expiry>.<HMAC(expiry)>`, keyed by the credentials themselves: no session
// table, no extra secret to set, and changing the password invalidates
// every outstanding session. If the credentials aren't set (local `wrangler
// dev` without `.dev.vars`) auth is skipped entirely, as before.

const SESSION_COOKIE = "steady_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

// Reachable signed-out: the login page itself, its endpoint, and what the
// browser needs to recognise the app as installable before signing in.
function isPublicPath(pathname) {
  return (
    pathname === "/login" || pathname === "/login.html" || pathname === "/api/login" ||
    pathname === "/manifest.json" || pathname === "/sw.js" || pathname.startsWith("/icons/")
  );
}

async function sessionSignature(env, expiry) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(`${env.BASIC_AUTH_USER}\n${env.BASIC_AUTH_PASS}`),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`steady-session:${expiry}`)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

async function hasValidSession(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return false;
  const [expiryStr, sig] = token.split(".");
  const expiry = Number(expiryStr);
  if (!Number.isInteger(expiry) || !sig || expiry < Date.now() / 1000) return false;
  return timingSafeEqual(sig, await sessionSignature(env, expiry));
}

function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/**
 * This is a single-user personal tool sitting on a public workers.dev URL,
 * so every non-public request is gated. A valid session cookie is the normal
 * path; an `Authorization: Basic` header is still accepted (constant-time
 * compared) for scripted/curl access, but no `WWW-Authenticate` challenge is
 * ever sent, so browsers never show the native popup.
 */
async function checkAuth(request, env) {
  if (!env.BASIC_AUTH_USER) return true;
  if (await hasValidSession(request, env)) return true;
  const header = request.headers.get("Authorization");
  if (!header) return false;
  const expected = "Basic " + btoa(`${env.BASIC_AUTH_USER}:${env.BASIC_AUTH_PASS}`);
  return timingSafeEqual(header, expected);
}

// POST /api/login { username, password } -> sets the session cookie.
// Both fields compared in constant time and both always compared (no early
// exit on a wrong username); a failure waits a beat before answering, to
// make guessing slower without needing any stored rate-limit state.
async function handleLogin(request, env) {
  if (!env.BASIC_AUTH_USER) return jsonResponse({ ok: true }); // auth disabled (local dev)
  const body = await request.json().catch(() => ({}));
  const userOk = await timingSafeEqual(String(body.username ?? ""), env.BASIC_AUTH_USER);
  const passOk = await timingSafeEqual(String(body.password ?? ""), env.BASIC_AUTH_PASS);
  if (!(userOk && passOk)) {
    await new Promise((r) => setTimeout(r, 750));
    return jsonResponse({ error: "Wrong username or password." }, { status: 401 });
  }
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = `${expiry}.${await sessionSignature(env, expiry)}`;
  return jsonResponse({ ok: true }, { headers: {
    "content-type": "application/json; charset=utf-8",
    "Set-Cookie": sessionCookie(token, SESSION_TTL_SECONDS),
  } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return jsonResponse({ ok: true }, { headers: {
        "content-type": "application/json; charset=utf-8",
        "Set-Cookie": sessionCookie("", 0),
      } });
    }

    const authed = await checkAuth(request, env);
    // Already signed in (or auth disabled): skip straight past the login page.
    if (authed && (url.pathname === "/login" || url.pathname === "/login.html")) {
      return Response.redirect(new URL("/", url).toString(), 302);
    }
    if (!authed && !isPublicPath(url.pathname)) {
      if (url.pathname.startsWith("/api/") || request.method !== "GET") {
        // Plain 401, deliberately no WWW-Authenticate - the frontend sees
        // this and sends the browser to /login itself.
        return jsonResponse({ error: "authentication required" }, { status: 401 });
      }
      const login = new URL("/login", url);
      if (url.pathname !== "/") login.searchParams.set("next", url.pathname + url.search);
      return Response.redirect(login.toString(), 302);
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url, ctx);
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
