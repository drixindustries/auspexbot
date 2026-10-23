import test from "node:test";
import assert from "node:assert/strict";
import { outcomeRows } from "./fixtures/outcomes.js";
import { signalPerformance } from "./fixtures/synthetic.js";
import { aggregateRows, statsFrom, hitRateFor, createOutcomes, scoreBand, rowOutcome, sinceSignalFromRow } from "../lib/outcomes.js";
import { evaluate, DEFAULT_FILTERS } from "../lib/rules.js";
import { silent } from "./helpers.js";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const rows = outcomeRows(NOW);

test("score bands match the worker", () => {
  assert.deepEqual([null, 10, 25, 50, 74.9, 75, 100].map(scoreBand), ["unscored", "0-24", "25-49", "50-74", "50-74", "75-100", "75-100"]);
});
test("hit = +50% before -50%, resolved only", () => {
  assert.equal(rowOutcome({ hit_up50_at: "2026-01-01T00:10:00Z", hit_down50_at: "2026-01-01T00:20:00Z" }, 50), "hit");
  assert.equal(rowOutcome({ hit_up50_at: "2026-01-01T00:30:00Z", hit_down50_at: "2026-01-01T00:20:00Z" }, 50), "miss");
  assert.equal(rowOutcome({ status: "tracking" }, 50), "pending");
  assert.equal(rowOutcome({ status: "expired" }, 50), "miss");
});
test("aggregate over the final schema rows", () => {
  const a = aggregateRows(rows, { now: NOW });
  assert.equal(a.counted, 90); // 2 rows with no entry price excluded
  const band = a.rows.find((r) => r.dim === "scoreBand" && r.value === "75-100");
  assert.deepEqual(band.hit50, { hits: 12, decided: 26, ratePct: 46.2 });
  assert.equal(a.rows.find((r) => r.dim === "kind" && r.value === "graduation").hit50.ratePct, 60);
  assert.ok(a.rows.some((r) => r.dim === "badge" && r.value === "dev_proven"));
  assert.ok(a.rows.some((r) => r.dim === "source" && r.value === "LAUNCH:pump.fun"));
});
test("cohort: score band for signals, kind for launches/graduations", () => {
  const s = statsFrom(signalPerformance(NOW), "payload");
  const sig = hitRateFor(s, { kind: "signal", chain: "solana", score: 92 });
  assert.equal(sig.label, "score 75-100"); assert.equal(sig.ratePct, 46.2); assert.equal(sig.trusted, true); assert.equal(sig.x2Pct, 19.2);
  assert.equal(hitRateFor(s, { kind: "signal", score: 60 }).ratePct, 20);
  assert.equal(hitRateFor(s, { kind: "graduation" }).label, "graduations");
  assert.equal(hitRateFor(s, { kind: "launch" }).ratePct, 13);
  assert.equal(hitRateFor({ available: false }, { kind: "launch" }), null);
});
test("minHitRate uses the real cohort and is skipped without stats", () => {
  const s = statsFrom(signalPerformance(NOW), "payload");
  const f = { ...DEFAULT_FILTERS, kinds: ["signal", "launch", "graduation"], minHitRate: 40, exclude: [] };
  assert.equal(evaluate({ kind: "signal", chain: "solana", score: 95, address: "x" }, f, { outcomes: s }).pass, true);
  assert.match(evaluate({ kind: "signal", chain: "solana", score: 66, address: "x" }, f, { outcomes: s }).reasons.join(), /hit rate 20% < 40% \(score 50-74\)/);
  assert.equal(evaluate({ kind: "graduation", chain: "solana", address: "x" }, f, { outcomes: s }).pass, true);
  assert.equal(evaluate({ kind: "launch", chain: "solana", address: "x" }, f, { outcomes: s }).pass, false);
  const skipped = evaluate({ kind: "launch", chain: "solana", address: "x" }, f, { outcomes: { available: false } });
  assert.equal(skipped.pass, true); assert.match(skipped.notes[0], /unavailable/);
  const small = statsFrom({ counted: 3, rows: [{ dim: "kind", value: "launch", n: 3, hit50: { hits: 0, decided: 3, ratePct: 0 } }] }, "payload");
  assert.match(evaluate({ kind: "launch", chain: "solana", address: "x" }, f, { outcomes: small }).notes.join(), /not enough history/);
});
test("source order: payload aggregate first, then the table, then unavailable", async () => {
  const q = [];
  const withPayload = createOutcomes({ data: { getSignalCache: async () => ({ payload: { signalPerformance: signalPerformance(NOW) } }), getOutcomeRows: async (x) => { q.push(x); return { available: true, rows }; } }, log: silent, now: () => NOW });
  const a = await withPayload.getStats();
  assert.equal(a.source, "payload"); assert.equal(q.length, 0);
  const tableOnly = createOutcomes({ data: { getSignalCache: async () => ({ payload: {} }), getOutcomeRows: async (x) => { q.push(x); return { available: true, rows }; } }, log: silent, now: () => NOW });
  const b = await tableOnly.getStats();
  assert.equal(b.source, "table"); assert.equal(b.counted, 90);
  assert.match(q[0], /first_seen_at=gte\./); assert.match(q[0], /hit_up50_at/);
  await tableOnly.getStats(); assert.equal(q.length, 1, "table aggregate is cached");
  const none = createOutcomes({ data: { getSignalCache: async () => { throw new Error("down"); }, getOutcomeRows: async () => ({ available: false, status: 404, reason: "PGRST205" }) }, log: silent });
  assert.equal((await none.getStats()).available, false);
});
test("since-signal from a table row, and per-coin lookup by id", async () => {
  const row = rows.find((r) => r.kind === "graduation");
  const p = sinceSignalFromRow(row);
  assert.equal(p.kind, "graduation"); assert.equal(p.returnPct, 20); assert.deepEqual(Object.keys(p.checkpoints), ["5m", "15m", "1h", "24h"]);
  let asked;
  const o = createOutcomes({ data: { getSignalCache: async () => ({ payload: {} }), getOutcomeRows: async (x) => { asked = x; return { available: true, rows: [row] }; } }, log: silent });
  assert.equal((await o.sinceSignal({ kind: "graduation", chain: "solana", address: row.token_address })).kind, "graduation");
  assert.match(asked, new RegExp("id=eq.graduation%3Asolana%3A"));
  assert.equal(await o.sinceSignal({ kind: "other" }), null);
});
