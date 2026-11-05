import test from "node:test";
import assert from "node:assert/strict";
import {
  rebalance, peakOf, lintCards, projectLoad, needsRecheck, planRelease, shiftISO,
} from "./plan.js";

const T = "2026-11-05";
const mk = (n, due, extra = {}) => Array.from({ length: n }, (_, i) => ({ key: `${due}-${i}-${extra.tag || ""}`, due, interval: 6, cap: null, weak: false, ...extra }));
const counts = (res, items) => {
  const dest = {};
  const moved = Object.fromEntries(res.moves.map((m) => [m.key, m.to]));
  for (const i of items) { const d = moved[i.key] ?? (i.due < T ? T : i.due); dest[d] = (dest[d] || 0) + 1; }
  return dest;
};

test("missed days: a 30-item backlog is spread over a week, not dumped on today", () => {
  const items = mk(30, "2026-11-02");
  const res = rebalance(items, T);
  const dest = counts(res, items);
  assert.equal(Object.values(dest).reduce((a, b) => a + b, 0), 30);
  assert.ok(Math.max(...Object.values(dest)) <= 5, JSON.stringify(dest));
  assert.ok(Object.keys(dest).every((d) => d >= T && d <= shiftISO(T, 7)));
});

test("a heavy day sheds items to lighter neighbours, within the allowed window", () => {
  const heavy = mk(20, "2026-11-10", { interval: 15 }); // slack 3 days
  const light = mk(2, "2026-11-12", { interval: 15, tag: "l" });
  const items = [...heavy, ...light];
  const res = rebalance(items, T);
  const dest = counts(res, items);
  assert.ok(Math.max(...Object.values(dest)) < 20);
  for (const m of res.moves) {
    const it = items.find((i) => i.key === m.key);
    assert.ok(Math.abs((Date.parse(m.to) - Date.parse(it.due)) / 86400000) <= 3, "moved further than 20% of its interval");
  }
});

test("exam caps are never exceeded, even when that leaves a day overloaded", () => {
  const cap = "2026-11-07";
  const items = mk(40, "2026-11-01", { cap });
  const res = rebalance(items, T);
  for (const d of Object.keys(counts(res, items))) assert.ok(d <= cap, d);
});

test("an already even schedule is left alone", () => {
  const items = [];
  for (let d = 0; d < 22; d++) items.push(...mk(5, shiftISO(T, d), { interval: 15, tag: String(d) }));
  const res = rebalance(items, T);
  assert.equal(res.moves.length, 0);
});

test("a mild imbalance (one item more) is tolerated, not shuffled", () => {
  const items = [];
  for (let d = 0; d < 22; d++) items.push(...mk(d === 8 ? 6 : 5, shiftISO(T, d), { interval: 15, tag: String(d) }));
  assert.equal(rebalance(items, T).moves.length, 0);
});

test("lockToday keeps what is due today where it is", () => {
  const items = [...mk(30, T, { interval: 15 })];
  const res = rebalance(items, T, { lockToday: true });
  assert.equal(res.moves.length, 0);
});

test("weak items are delayed less than solid ones", () => {
  const weak = mk(10, T, { weak: true, tag: "w", interval: 15 });
  const solid = mk(10, T, { weak: false, tag: "s", interval: 15 });
  const res = rebalance([...weak, ...solid], T);
  const delay = (set) => set.reduce((s, i) => s + (Date.parse((res.moves.find((m) => m.key === i.key)?.to) ?? i.due) - Date.parse(i.due)) / 86400000, 0);
  assert.ok(delay(weak) <= delay(solid));
});

test("peak load drops after rebalancing a pile-up", () => {
  const items = mk(45, "2026-11-03", { interval: 6 });
  const res = rebalance(items, T);
  assert.ok(peakOf(res.loadAfter).peak < peakOf(res.loadBefore).peak);
});

test("lint flags the usual flashcard-hell patterns", () => {
  const [a, b, c, d, e] = lintCards([
    { front: "Derivative of sin^-1 x?", back: "1/sqrt(1-x^2)" },
    { front: "Explain everything about the Fourier transform", back: Array(40).fill("word").join(" ") },
    { front: "List the trig identities", back: "a" },
    { front: "What is the domain of tan^-1 x? And of sin^-1 x?", back: "R; [-1,1]" },
    { front: "derivative of sin^-1 x", back: "again" },
  ], []);
  assert.deepEqual(a, []);
  assert.ok(b.some((f) => f.code === "long_back"));
  assert.ok(c.some((f) => f.code === "enumeration"));
  assert.ok(d.some((f) => f.code === "two_questions"));
  assert.ok(e.some((f) => f.code === "duplicate"));
});

test("sibling formula cards are not duplicates of each other", () => {
  const flags = lintCards([
    { front: "Trig substitution for √(a² − x²)?", back: "x = a sin θ" },
    { front: "Trig substitution for √(a² + x²)?", back: "x = a tan θ" },
    { front: "Trig substitution for √(x² − a²)?", back: "x = a sec θ" },
    { front: "∫ dx / √(x² + a²) = ?", back: "ln(x + √(x² + a²)) + C" },
    { front: "∫ dx / √(x² − a²) = ?", back: "ln|x + √(x² − a²)| + C" },
    { front: "∫ tan x dx = ?", back: "ln|sec x|" },
    { front: "∫ cot x dx = ?", back: "ln|sin x|" },
  ]);
  assert.deepEqual(flags.flat(), []);
});

test("recheck is required for big batches and for heavy days", () => {
  assert.equal(needsRecheck(5, 0), false);
  assert.equal(needsRecheck(9, 0), true);
  assert.equal(needsRecheck(6, 16), true);
});

test("projection shows the load of a big add", () => {
  const p = projectLoad({}, 60, T);
  assert.ok(p.peak >= 20);
  assert.equal(p.days_to_release, 6);
});

test("release: normal pace, exam urgency, backlog pause", () => {
  const staged = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, exam: null }));
  assert.equal(planRelease({ staged, introducedToday: 0, dueNow: 5, today: T }).ids.length, 10);
  assert.equal(planRelease({ staged, introducedToday: 7, dueNow: 5, today: T }).ids.length, 3);
  assert.equal(planRelease({ staged, introducedToday: 0, dueNow: 60, today: T }).paused, true);
  const urgent = [{ id: 99, exam: "2026-11-12" }, ...staged];
  const r = planRelease({ staged: urgent, introducedToday: 0, dueNow: 0, today: T });
  assert.equal(r.ids[0], 99);
  assert.equal(r.ids.length, 25);
});
