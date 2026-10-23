import test from "node:test";
import assert from "node:assert/strict";
import { computeOutcomeStats, hitRateFor, createOutcomes, bucketOf } from "../lib/outcomes.js";
import { evaluate, DEFAULT_FILTERS } from "../lib/rules.js";
import { silent } from "./helpers.js";

const rows = [];
for (let i = 0; i < 20; i++) rows.push({ chain_id: "solana", kind: "signal", first_seen_score: 92, return_24h_pct: i < 14 ? 50 : -30 });
for (let i = 0; i < 12; i++) rows.push({ chain_id: "solana", kind: "signal", first_seen_score: 65, return_24h_pct: i < 3 ? 10 : -50 });
rows.push({ chain_id: "solana", kind: "signal", first_seen_score: 65, return_24h_pct: null }); // unresolved

test("bucketing", () => { assert.equal(bucketOf(92), 90); assert.equal(bucketOf(100), 90); assert.equal(bucketOf(null), null); });
test("stats per score bucket with column detection", () => {
  const s = computeOutcomeStats(rows);
  assert.equal(s.available, true); assert.equal(s.n, 32);
  assert.equal(s.columns.score, "first_seen_score");
  const hi = hitRateFor(s, { kind: "signal", chain: "solana", score: 95 });
  assert.equal(hi.rate, 70); assert.equal(hi.trusted, true);
  const lo = hitRateFor(s, { kind: "signal", chain: "solana", score: 61 });
  assert.equal(lo.rate, 25);
});
test("explicit hit column and env overrides", () => {
  const s = computeOutcomeStats([{ sc: 80, won: true }, { sc: 80, won: false }], { AUSPEX_OUTCOMES_SCORE_COL: "sc", AUSPEX_OUTCOMES_HIT_COL: "won" });
  assert.equal(s.buckets["*|*|80"].rate, 50);
  assert.equal(computeOutcomeStats([{ foo: 1 }]).available, false);
});
test("minHitRate filter uses trusted cohorts only", () => {
  const s = computeOutcomeStats(rows);
  const f = { ...DEFAULT_FILTERS, minHitRate: 50, exclude: [] };
  assert.equal(evaluate({ kind: "signal", chain: "solana", score: 95, address: "x" }, f, { outcomes: s }).pass, true);
  assert.match(evaluate({ kind: "signal", chain: "solana", score: 66, address: "x" }, f, { outcomes: s }).reasons.join(), /hit rate 25% < 50%/);
});
test("createOutcomes: missing table -> unavailable; 400 retried without order", async () => {
  const missing = createOutcomes({ data: { getOutcomeRows: async () => ({ available: false, status: 404, reason: "relation does not exist" }) }, log: silent });
  assert.equal((await missing.getStats()).available, false);
  const calls = [];
  const no400 = createOutcomes({ data: { getOutcomeRows: async (q) => { calls.push(q); return q.includes("order=") ? { available: false, status: 400 } : { available: true, rows }; } }, log: silent });
  assert.equal((await no400.getStats()).available, true);
  assert.equal(calls.length, 2);
});
