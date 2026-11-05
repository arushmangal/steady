/**
 * Pure scheduling helpers: no DB, no network, no clock. Everything takes
 * `today` (an ISO YYYY-MM-DD string) explicitly so it can be unit tested
 * with `node --test worker/plan.test.js`.
 *
 * Three jobs live here:
 *   1. rebalance()      - automatic load levelling after missed days
 *   2. lintCards() and projectLoad() - the flashcard-hell guard
 *   3. planRelease()    - how many staged flashcards may be introduced today
 */

export const NEW_PER_DAY = 10; // normal pace for introducing new cards
export const NEW_MAX = 25; // ceiling, only used when an exam is close
export const BACKLOG_PAUSE = 60; // this many cards already due => introduce none
export const LEECH_LAPSES = 4; // a card forgotten this many times needs rewriting
export const CONFIRM_BATCH = 8; // adding more than this at once needs a recheck
export const CONFIRM_DAILY = 20; // ...or more than this in one day in total
export const PEAK_WARN = 80; // projected reviews in one day that trigger a warning
export const SECONDS_PER_CARD = 8;

export function shiftISO(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromISO, toISO) {
  return Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86400000);
}

/**
 * Levels the review load across days, with no input from the user.
 *
 * `items`: [{ key, due, interval, cap, weak }]
 *   due      ISO date the item is currently scheduled for
 *   interval its current interval in days (how much lateness it can absorb)
 *   cap      latest date it may be scheduled (the exam cap), or null
 *   fixed    true to count the item toward a day's load but never move it
 *            (brand-new cards released today)
 *   weak     true if it is shaky; weak items get a narrower window and are
 *            placed before others, so they are the last to be delayed
 *
 * Every item gets a window [lo, hi]:
 *   - missed (due before today): today .. today + 7 days
 *   - otherwise: due +/- 20% of its interval (at least 1 day, at most 7),
 *     never earlier than today, never later than its exam cap.
 * Items are placed most-constrained first, each on the least loaded day in
 * its window. A small tolerance (one item) keeps an item where it already
 * is, so a roughly even schedule is left alone instead of shuffled daily.
 *
 * Returns { moves: [{ key, from, to }], loadBefore, loadAfter }. A missed
 * item that ends up on today is NOT a move: it keeps its old due date so
 * "3 days overdue" stays visible.
 */
export function rebalance(items, today, opts = {}) {
  const { horizon = 14, overdueSpread = 7, maxSlack = 7, lockToday = false } = opts;
  const end = shiftISO(today, horizon);
  const cand = items.filter((i) => i.due <= end);

  const loadBefore = {};
  for (const i of cand) {
    const d = i.due < today ? today : i.due;
    loadBefore[d] = (loadBefore[d] || 0) + 1;
  }

  const jobs = cand.map((i) => {
    const missed = i.due < today;
    const home = missed ? today : i.due;
    let slack = missed ? overdueSpread : Math.min(maxSlack, Math.max(1, Math.floor((i.interval || 1) * 0.2)));
    if (i.weak) slack = Math.max(1, Math.floor(slack / 2));
    let lo = missed ? today : shiftISO(i.due, -slack);
    if (lo < today) lo = today;
    let hi = shiftISO(home, slack);
    if ((lockToday && !missed && i.due <= today) || i.fixed) lo = hi = home;
    if (i.cap && hi > i.cap) hi = i.cap;
    if (hi < today) hi = today;
    if (lo > hi) lo = hi;
    return { item: i, missed, home: home > hi ? hi : home, lo, hi, len: daysBetween(lo, hi) };
  });

  jobs.sort(
    (a, b) =>
      a.len - b.len ||
      (b.item.weak ? 1 : 0) - (a.item.weak ? 1 : 0) ||
      (a.item.due < b.item.due ? -1 : a.item.due > b.item.due ? 1 : 0) ||
      String(a.item.key).localeCompare(String(b.item.key))
  );

  // Start from the current schedule, then improve it item by item, most
  // constrained first. Two passes let early decisions settle once the whole
  // picture is known.
  const load = {};
  // Items scheduled beyond the horizon are not moved, but they still make
  // their days busy, so nothing is shuffled onto them.
  for (const i of items) if (i.due > end) load[i.due] = (load[i.due] || 0) + 1;
  const pos = new Map();
  for (const j of jobs) {
    pos.set(j.item.key, j.home);
    load[j.home] = (load[j.home] || 0) + 1;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const j of jobs) {
      const cur = pos.get(j.item.key);
      load[cur]--;
      let best = cur;
      let bestLoad = Infinity;
      for (let d = j.lo; d <= j.hi; d = shiftISO(d, 1)) {
        const l = load[d] || 0;
        if (l < bestLoad || (l === bestLoad && Math.abs(daysBetween(j.home, d)) < Math.abs(daysBetween(j.home, best)))) {
          best = d;
          bestLoad = l;
        }
      }
      // Hysteresis: a placed item only moves if somewhere else is lighter by
      // two or more, so a roughly even schedule is left alone. Missed items
      // are always free to go to the best day.
      const pick = j.missed || (load[cur] || 0) >= bestLoad + 2 ? best : cur;
      load[pick] = (load[pick] || 0) + 1;
      pos.set(j.item.key, pick);
    }
  }
  const moves = [];
  for (const j of jobs) {
    const to = pos.get(j.item.key);
    const stays = to === j.home && (!j.missed || to === today);
    if (!stays) moves.push({ key: j.item.key, from: j.item.due, to });
  }
  return { moves, loadBefore, loadAfter: load };
}

export function peakOf(load) {
  let peak = 0;
  let day = null;
  for (const [d, n] of Object.entries(load)) if (n > peak || (n === peak && day && d < day)) { peak = n; day = d; }
  return { peak, day };
}

// --- Flashcard-hell guard ---------------------------------------------------

const words = (s) => (String(s || "").trim().match(/\S+/g) || []).length;
// Tokens keep the operators and exponents that tell sibling formulas apart
// (sqrt(a^2 + x^2) vs sqrt(a^2 - x^2) are different cards, not duplicates).
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/\+/g, " plus ")
    .replace(/[\u2212-]/g, " minus ")
    .replace(/\u221a/g, " sqrt ")
    .replace(/\u222b/g, " int ")
    .replace(/\u207b\u00b9/g, " inv ")
    .replace(/[\u00b2^]2?/g, " sq ")
    .replace(/\//g, " div ")
    .replace(/[^a-z0-9\u0370-\u03ff ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

// Jaccard over adjacent token pairs, so order matters: sqrt(a^2 - x^2) and
// sqrt(x^2 - a^2) are different cards even though they use the same symbols.
function jaccard(a, b) {
  const A = norm(a), B = norm(b);
  if (!A.length || !B.length) return 0;
  const grams = (t) => (t.length < 2 ? t : t.slice(1).map((w, i) => t[i] + " " + w));
  const count = (arr) => arr.reduce((m, w) => (m.set(w, (m.get(w) || 0) + 1), m), new Map());
  const ca = count(grams(A)), cb = count(grams(B));
  let inter = 0, union = 0;
  for (const w of new Set([...ca.keys(), ...cb.keys()])) {
    inter += Math.min(ca.get(w) || 0, cb.get(w) || 0);
    union += Math.max(ca.get(w) || 0, cb.get(w) || 0);
  }
  return inter / union;
}

/**
 * Flags cards that are the usual ways flashcard decks go wrong. Each flag is
 * advice, not a block: the UI lists them and lets the user drop or keep.
 * `existingFronts` are fronts already in the deck (for duplicate detection).
 * Returns one array of { code, msg } per input card, in order.
 */
export function lintCards(cards, existingFronts = []) {
  const out = [];
  const seen = [...existingFronts];
  for (const c of cards) {
    const flags = [];
    const front = String(c.front || "").trim();
    const back = String(c.back || "").trim();
    if (!front || (!back && !c.image)) {
      flags.push({ code: "empty", msg: "Needs both a front and a back." });
    }
    if (words(back) > 25) {
      flags.push({ code: "long_back", msg: "The back is long. Split it into separate cards, or keep it in your notes." });
    }
    const lines = back.split(/\n+/).filter((l) => l.trim());
    if (lines.length >= 4) {
      flags.push({ code: "list", msg: "The back is a list. Lists are hard to recall as one card; ask for one item per card or skip it." });
    }
    if (/\b(list|enumerate|name all|name the \d+|steps (of|in)|all the)\b/i.test(front)) {
      flags.push({ code: "enumeration", msg: "Asks for a list or sequence. Cards work best when they ask for one thing." });
    }
    if ((front.match(/\?/g) || []).length > 1) {
      flags.push({ code: "two_questions", msg: "Asks more than one question. One question per card." });
    }
    let dupOf = null;
    for (const s of seen) {
      if (jaccard(front, s) >= 0.85) { dupOf = s; break; }
    }
    if (dupOf) flags.push({ code: "duplicate", msg: `Nearly the same as another card: "${dupOf.slice(0, 60)}".` });
    seen.push(front);
    out.push(flags);
  }
  return out;
}

/**
 * Projects how many reviews per day the deck will need over the next 30 days
 * if `newCount` more cards are added and released at `perDay`, on top of the
 * reviews already scheduled (`dueHistogram`: date -> count). A new card is
 * assumed to be seen on its release day and then about 1, 7, 22 and 60 days
 * later, plus 25% extra for forgetting. Rough on purpose: it exists to show
 * the shape of the load, not predict it.
 */
export function projectLoad(dueHistogram, newCount, today, perDay = NEW_PER_DAY) {
  const days = 30;
  const arr = [];
  for (let i = 0; i < days; i++) arr.push(dueHistogram[shiftISO(today, i)] || 0);
  const offsets = [0, 1, 7, 22, 60];
  const extra = new Array(days).fill(0);
  for (let k = 0; k < newCount; k++) {
    const release = Math.floor(k / Math.max(1, perDay));
    for (const o of offsets) {
      const d = release + o;
      if (d < days) extra[d] += o === 0 ? 1 : 1.25;
    }
  }
  const total = arr.map((n, i) => Math.round(n + extra[i]));
  let peak = 0;
  let peakIndex = 0;
  total.forEach((n, i) => { if (n > peak) { peak = n; peakIndex = i; } });
  const baselinePeak = Math.max(0, ...arr);
  return {
    peak,
    peak_day: shiftISO(today, peakIndex),
    baseline_peak: baselinePeak,
    peak_minutes: Math.round((peak * SECONDS_PER_CARD) / 60),
    days_to_release: Math.ceil(newCount / Math.max(1, perDay)),
  };
}

/**
 * Decides whether adding `n` cards needs the recheck screen.
 */
export function needsRecheck(n, addedToday) {
  return n > CONFIRM_BATCH || addedToday + n > CONFIRM_DAILY;
}

/**
 * Which staged cards to introduce today.
 *   staged         [{ id, exam }] in creation order; exam = earliest upcoming
 *                  exam date for the card's course, or null
 *   introducedToday how many were already released today
 *   dueNow         cards already due (review backlog)
 * With a backlog of BACKLOG_PAUSE or more, nothing is introduced: clear the
 * reviews first. Cards whose exam is within 14 days go first, and their
 * presence lifts the daily limit from NEW_PER_DAY to NEW_MAX.
 */
export function planRelease({ staged, introducedToday, dueNow, today }) {
  if (dueNow >= BACKLOG_PAUSE) return { ids: [], paused: true, budget: 0 };
  const soon = (c) => c.exam && c.exam >= today && daysBetween(today, c.exam) <= 14;
  const urgent = staged.filter(soon);
  const limit = urgent.length ? NEW_MAX : NEW_PER_DAY;
  const budget = Math.max(0, limit - introducedToday);
  const ordered = [...urgent, ...staged.filter((c) => !soon(c))];
  return { ids: ordered.slice(0, budget).map((c) => c.id), paused: false, budget };
}
