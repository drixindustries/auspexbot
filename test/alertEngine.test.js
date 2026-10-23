import test from "node:test";
import assert from "node:assert/strict";
import { buildPayload, ADDR } from "./fixtures/synthetic.js";
import { createAlertEngine } from "../lib/alertEngine.js";
import { createMemoryStore } from "../lib/alertStore.js";
import { DEFAULT_FILTERS } from "../lib/rules.js";
import { validateMarkdownV2 } from "../lib/md.js";
import { silent } from "./helpers.js";

function harness({ payload, updatedAgoMs = 30_000, failWith = null, outcomes = null } = {}) {
  let t = Date.parse("2026-10-23T12:00:00Z");
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  let pl = payload || buildPayload(t);
  const data = { getSignalCache: async () => ({ payload: pl, updatedAt: new Date(t - updatedAgoMs).toISOString() }) };
  const sent = [];
  let fail = failWith;
  const telegram = { sendMessage: async (chatId, text, extra) => {
    if (fail) { const e = new Error(fail.msg); e.response = { error_code: fail.code, parameters: fail.params }; fail = null; throw e; }
    assert.deepEqual(validateMarkdownV2(text), [], text);
    sent.push({ chatId, text, extra }); return { message_id: sent.length };
  } };
  const store = createMemoryStore();
  const engine = createAlertEngine({ data, outcomes, store, telegram, siteUrl: "https://auspex.example", log: silent, now: clock.now, sleep: async (ms) => clock.advance(ms) });
  return { engine, store, sent, clock, setPayload: (x) => { pl = x; } };
}
const rule = (chatId, filters = {}) => ({ chatId, enabled: true, filters: { ...DEFAULT_FILTERS, ...filters } });

test("sends matching coins once, suppresses non-matching and duplicates", async () => {
  const h = harness();
  await h.store.saveRule(rule("100", { kinds: ["signal", "launch", "graduation"], requireDev: "proven", maxPerHour: 60 }));
  const r1 = await h.engine.tick();
  const coins = r1.sent.map((s) => s.coin);
  assert.ok(coins.includes("SGRAD") && coins.includes("PPUP"), coins.join());
  assert.ok(!coins.includes("RCAT") && !coins.includes("SANC") && !coins.includes("STALE"));
  assert.ok(r1.suppressed.some((s) => s.coin === "RCAT" && s.reason === "filtered"));
  const r2 = await h.engine.tick();
  assert.equal(r2.sent.length, 0);
  assert.ok(r2.suppressed.filter((s) => s.reason === "duplicate").length >= coins.length);
  // alert links to the coin on the site and carries the badges
  const a = h.sent.find((s) => s.text.includes("PPUP"));
  assert.match(a.text, /PROVEN DEV/);
  assert.match(JSON.stringify(a.extra.reply_markup), /auspex\.example\/\?chain=solana&ca=PRoVEN/);
});
test("a coin that is both a signal and a graduation alerts once", async () => {
  const p = buildPayload(Date.parse("2026-10-23T12:00:00Z"));
  p.chainGroups.solana.unshift({ ...p.chainGroups.solana[0], tokenAddress: ADDR.safeGrad, symbol: "SGRAD", name: "Safe Grad" });
  const h = harness({ payload: p });
  await h.store.saveRule(rule("1", { maxPerHour: 60, minScore: 0 }));
  const r = await h.engine.tick();
  assert.equal(r.sent.filter((s) => s.address === ADDR.safeGrad).length, 1);
  assert.equal(r.sent.find((s) => s.address === ADDR.safeGrad).kind, "graduation");
});
test("per-chat hourly rate limit", async () => {
  const h = harness();
  await h.store.saveRule(rule("7", { minScore: 0, maxPerHour: 2, exclude: [] }));
  const r = await h.engine.tick();
  assert.equal(r.sent.length, 2);
  assert.ok(r.suppressed.some((s) => s.reason === "rate_limited"));
  h.clock.advance(3_600_001);
  const r2 = await h.engine.tick();
  assert.ok(r2.sent.length >= 1 && r2.sent.length <= 2); // rate-limited coins are delivered once the window frees up
});
test("prime() prevents a flood when alerts are switched on", async () => {
  const h = harness();
  const n = await h.engine.prime("9", rule("9").filters);
  assert.ok(n > 0);
  await h.store.saveRule(rule("9"));
  const r = await h.engine.tick();
  assert.equal(r.sent.length, 0);
});
test("stale cache -> no alerts", async () => {
  const h = harness({ updatedAgoMs: 30 * 60_000 });
  await h.store.saveRule(rule("1"));
  const r = await h.engine.tick();
  assert.equal(r.stale, true); assert.equal(h.sent.length, 0);
});
test("403 disables the chat's rule; 429 pauses", async () => {
  const h = harness({ failWith: { code: 403, msg: "Forbidden: bot was blocked by the user" } });
  await h.store.saveRule(rule("5"));
  await h.engine.tick();
  assert.equal((await h.store.getRule("5")).enabled, false);
  const h2 = harness({ failWith: { code: 429, msg: "Too Many Requests", params: { retry_after: 7 } } });
  await h2.store.saveRule(rule("6", { minScore: 0, maxPerHour: 60 }));
  const before = h2.clock.now();
  await h2.engine.tick(); // first send 429s, loop breaks
  await h2.engine.tick(); // waits out retry_after, then sends
  assert.ok(h2.clock.now() - before >= 7000);
  assert.ok(h2.sent.length > 0);
});
test("not-allowed chats (no subscription) are skipped", async () => {
  const h = harness();
  const e = createAlertEngine({ data: { getSignalCache: async () => ({ payload: buildPayload(Date.now()), updatedAt: new Date().toISOString() }) }, store: h.store, telegram: { sendMessage: async () => assert.fail("should not send") }, log: silent, isChatAllowed: async () => false });
  await h.store.saveRule(rule("1"));
  const r = await e.tick();
  assert.equal(r.suppressed[0].reason, "not_allowed");
});
test("hit-rate line shows when outcome stats exist", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ kind: "signal", chain_id: "solana", first_seen_score: 92, return_24h_pct: i < 9 ? 40 : -10 }));
  const { computeOutcomeStats } = await import("../lib/outcomes.js");
  const h = harness({ outcomes: { getStats: async () => computeOutcomeStats(rows) } });
  await h.store.saveRule(rule("1", { kinds: ["signal"], minHitRate: 60 }));
  const r = await h.engine.tick();
  const pp = r.sent.find((s) => s.coin === "PPUP");
  assert.ok(pp); assert.match(pp.text, /75/);
});
