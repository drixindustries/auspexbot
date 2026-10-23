// Parity with the worker: aggregate the same auspex_signal_outcomes rows with the worker's own
// lib/signal-outcomes.js (fromRow + aggregate) and with lib/outcomes.js, and compare every bucket.
// AUSPEX_WORKER_SIGNAL_OUTCOMES=/path/to/auspex-worker/lib/signal-outcomes.js (skipped otherwise).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { outcomeRows } from "./fixtures/outcomes.js";
import { aggregateRows, sinceSignalFromRow, scoreBand } from "../lib/outcomes.js";

const P = process.env.AUSPEX_WORKER_SIGNAL_OUTCOMES;
const skip = !P || !fs.existsSync(P) ? "set AUSPEX_WORKER_SIGNAL_OUTCOMES to auspex-worker/lib/signal-outcomes.js" : false;
const NOW = Date.parse("2026-10-23T12:00:00Z");

test("bot aggregate == worker aggregate (payload.signalPerformance)", { skip }, async () => {
  const W = await import(pathToFileURL(P).href);
  const rows = outcomeRows(NOW);
  const worker = W.aggregate(rows.map(W.fromRow), { now: NOW });
  const bot = aggregateRows(rows, { now: NOW });
  assert.equal(bot.counted, worker.counted);
  const key = (r) => `${r.dim}|${r.value}`;
  const wm = new Map(worker.rows.map((r) => [key(r), r]));
  assert.equal(bot.rows.length, worker.rows.length);
  for (const r of bot.rows) {
    const w = wm.get(key(r));
    assert.ok(w, `worker has no bucket ${key(r)}`);
    for (const f of ["n", "rugRatePct", "hit50", "hit100", "median", "samples", "medianMaxUpPct", "medianMaxDrawdownPct"]) assert.deepEqual(r[f], w[f], `${key(r)}.${f}`);
  }
});

test("since-signal view from a row == worker sinceSignal()", { skip }, async () => {
  const W = await import(pathToFileURL(P).href);
  for (const row of outcomeRows(NOW).slice(0, 40)) {
    const w = W.sinceSignal(W.fromRow(row));
    const b = sinceSignalFromRow(row);
    for (const f of ["kind", "basis", "returnPct", "maxUpPct", "maxDrawdownPct", "checkpoints", "rugged", "liqCollapsed", "status", "entryMcapUsd"]) assert.deepEqual(b[f], w[f], f);
    assert.equal(new Date(b.firstSeenAt).toISOString(), w.firstSeenAt);
  }
  for (const s of [null, 0, 24, 25, 49.9, 50, 74, 75, 100]) assert.equal(scoreBand(s), W.scoreBand(s));
});
