import test from "node:test";
import assert from "node:assert/strict";
import { buildPayload, ADDR } from "./fixtures/synthetic.js";
import { findCoin } from "../lib/normalize.js";
import { DEFAULT_FILTERS, applyFilterCommand, evaluate, describeFilters, normalizeFilters } from "../lib/rules.js";

const p = buildPayload(Date.parse("2026-10-23T12:00:00Z"));
const get = (a) => findCoin(p, a)[0];
const set = (f, k, v) => { const r = applyFilterCommand(f, k, v); assert.ok(!r.error, r.error); return r.filters; };

test("filter command parsing and aliases", () => {
  let f = normalizeFilters({});
  f = set(f, "score", "75"); assert.equal(f.minScore, 75);
  f = set(f, "chains", "sol"); assert.deepEqual(f.chains, ["solana"]);
  f = set(f, "kinds", "graduations"); assert.deepEqual(f.kinds, ["graduation"]);
  f = set(f, "liq", "20k"); assert.equal(f.minLiquidityUsd, 20000);
  f = set(f, "liq", "1.5m"); assert.equal(f.minLiquidityUsd, 1_500_000);
  f = set(f, "dev", "proven"); assert.equal(f.requireDev, "proven");
  f = set(f, "rugsafe", "on"); assert.equal(f.requireRugSafe, true);
  f = set(f, "exclude", "heuristic"); assert.ok(f.exclude.includes("heuristic"));
  f = set(f, "include", "heuristic"); assert.ok(!f.exclude.includes("heuristic"));
  f = set(f, "exclude", "none"); assert.deepEqual(f.exclude, []);
  f = set(f, "exclude", "rugdev"); assert.ok(f.exclude.includes("confirmed") && f.exclude.includes("suspected"));
  f = set(f, "rate", "500"); assert.equal(f.maxPerHour, 60);
  assert.ok(applyFilterCommand(f, "bogus", "1").error);
  assert.ok(applyFilterCommand(f, "chains", "eth").error);
  assert.deepEqual(applyFilterCommand(f, "reset").filters, normalizeFilters({}));
  assert.equal(describeFilters(f).length, 10);
});
test("defaults exclude hard flags but not heuristic", () => {
  assert.equal(evaluate(get(ADDR.provenSignal), DEFAULT_FILTERS).pass, true);
  assert.match(evaluate(get(ADDR.ruggerSignal), DEFAULT_FILTERS).reasons.join(), /excluded: confirmed/);
  assert.equal(evaluate(get(ADDR.ruggedGrad), DEFAULT_FILTERS).pass, false);
});
test("proven dev / rugsafe / liquidity / graduations-only", () => {
  const dev = { ...DEFAULT_FILTERS, requireDev: "proven", kinds: ["signal", "launch", "graduation"] };
  assert.equal(evaluate(get(ADDR.provenSignal), dev).pass, true);
  assert.equal(evaluate(get(ADDR.promisingLaunch), dev).pass, false);
  assert.equal(evaluate(get(ADDR.promisingLaunch), { ...dev, requireDev: "promising" }).pass, true);
  assert.equal(evaluate(get(ADDR.kolSignal), { ...DEFAULT_FILTERS, requireRugSafe: true }).pass, true);
  assert.equal(evaluate(get(ADDR.baseSignal), { ...DEFAULT_FILTERS, requireRugSafe: true }).pass, false);
  assert.match(evaluate(get(ADDR.baseLowLiq), { ...DEFAULT_FILTERS, minLiquidityUsd: 10000 }).reasons.join(), /liquidity/);
  const grads = { ...DEFAULT_FILTERS, kinds: ["graduation"] };
  assert.equal(evaluate(get(ADDR.provenSignal), grads).pass, false);
  assert.equal(evaluate(findCoin(p, ADDR.safeGrad).find((i) => i.kind === "graduation"), grads).pass, true);
});
test("exclude heuristic / sanctioned", () => {
  const all = { ...DEFAULT_FILTERS, kinds: ["launch"], exclude: [] };
  assert.equal(evaluate(get(ADDR.heuristicLaunch), all).pass, true);
  assert.equal(evaluate(get(ADDR.heuristicLaunch), { ...all, exclude: ["heuristic"] }).pass, false);
  assert.equal(evaluate(get(ADDR.sanctionedLaunch), { ...all, exclude: ["sanctioned"] }).pass, false);
});
test("hit-rate filter degrades gracefully without outcome stats", () => {
  const f = { ...DEFAULT_FILTERS, minHitRate: 50 };
  const r = evaluate(get(ADDR.provenSignal), f, { outcomes: { available: false, reason: "missing" } });
  assert.equal(r.pass, true); assert.match(r.notes[0], /unavailable/);
  const r2 = evaluate(get(ADDR.provenSignal), f, { outcomes: null });
  assert.equal(r2.pass, true);
});
