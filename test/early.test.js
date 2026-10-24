import test from "node:test";
import assert from "node:assert/strict";
import { buildPayload, ADDR } from "./fixtures/synthetic.js";
import { earlyItems, graduationItems } from "../lib/normalize.js";
import { badgesFor } from "../lib/badges.js";
import { evaluate, applyFilterCommand, normalizeFilters, DEFAULT_FILTERS } from "../lib/rules.js";
import { formatAlert, formatEarly } from "../lib/format.js";
import { validateMarkdownV2 } from "../lib/md.js";
import { createAlertEngine } from "../lib/alertEngine.js";
import { createMemoryStore } from "../lib/alertStore.js";
import { silent } from "./helpers.js";

const NOW = Date.parse("2026-10-23T12:00:00Z");

test("early items come from payload.earlyScanner, one per mint, with the arm that fired", () => {
  const items = earlyItems(buildPayload(NOW));
  const by = Object.fromEntries(items.map((i) => [i.address, i]));
  assert.equal(by[ADDR.earlyGood].arm, "early_curve");
  assert.equal(by[ADDR.stretch].arm, "final_stretch");
  assert.equal(by[ADDR.earlyNew].fired, false);
  assert.equal(earlyItems({}).length, 0);
});

test("early badges (site earlyCardHTML order and text)", () => {
  const items = Object.fromEntries(earlyItems(buildPayload(NOW)).map((i) => [i.address, i]));
  assert.deepEqual(badgesFor(items[ADDR.earlyGood]).map((b) => b.text), ["🏆 PROVEN DEV", "🧠 SMART ×2", "💪 CONVICTION 4.6 SOL", "#cat", "🧪 PAPER OPEN"]);
  const sold = badgesFor(items[ADDR.earlyDevSold]);
  assert.deepEqual(sold.map((b) => b.text), ["🚨 RUG DEV · CONFIRMED", "⭐ PROMISING DEV", "DEV SOLD 100%"]);
  assert.equal(sold[1].muted, true); // bad wins
  assert.deepEqual(badgesFor(items[ADDR.stretch]).map((b) => b.text), ["⚠️ HEURISTIC LIST · UNVERIFIED", "🔁 SERIAL WINNER", "💪 soft 3.1 SOL", "#moon", "#dog"]);
});

test("rules: only fired, hard-negative-free early signals pass; per-chat early filters", () => {
  const items = Object.fromEntries(earlyItems(buildPayload(NOW)).map((i) => [i.address, i]));
  const d = normalizeFilters({ ...DEFAULT_FILTERS, exclude: [] });
  assert.equal(evaluate(items[ADDR.earlyGood], d).pass, true);
  assert.ok(evaluate(items[ADDR.earlyDevSold], d).reasons.some((r) => /hard negative: dev_sold/.test(r)));
  assert.ok(evaluate(items[ADDR.earlyNew], d).reasons.includes("no early signal fired"));
  let f = applyFilterCommand(d, "early_score", "80").filters;
  assert.ok(evaluate(items[ADDR.earlyGood], f).reasons.some((r) => /early score 74 < 80/.test(r)));
  f = applyFilterCommand(d, "mcap", "4k-6k").filters;
  assert.equal(f.earlyMinMcapUsd, 4000);
  assert.equal(f.earlyMaxMcapUsd, 6000);
  assert.ok(evaluate(items[ADDR.earlyGood], f).reasons.some((r) => /mcap \$8200 > \$6000/.test(r)));
  f = applyFilterCommand(d, "bundle", "2").filters;
  assert.ok(evaluate(items[ADDR.earlyGood], f).reasons.some((r) => /bundle 2.3% > 2%/.test(r)));
  f = applyFilterCommand(applyFilterCommand(d, "smart", "on").filters, "first10", "9").filters;
  assert.equal(evaluate(items[ADDR.earlyGood], f).pass, true);
  assert.ok(evaluate(items[ADDR.stretch], f).reasons.includes("no smart-money buyer"));
  f = applyFilterCommand(d, "arms", "early").filters;
  assert.ok(evaluate(items[ADDR.stretch], f).reasons.some((r) => /arm final_stretch/.test(r)));
  assert.ok(applyFilterCommand(d, "mcap", "9k-3k").error);
  assert.ok(applyFilterCommand(d, "arms", "bogus").error);
});

test("graduations flagged signalEligible:false never alert", () => {
  const p = buildPayload(NOW);
  p.justGraduated[0].signalEligible = false;
  const g = graduationItems(p)[0];
  assert.ok(evaluate(g, normalizeFilters({ ...DEFAULT_FILTERS, exclude: [] })).reasons.some((r) => /outcome control/.test(r)));
});

test("EARLY SIGNAL alert + /early are valid MarkdownV2 and carry the curve numbers", () => {
  const p = buildPayload(NOW);
  const items = earlyItems(p);
  const it = items.find((i) => i.address === ADDR.earlyGood);
  const text = formatAlert(it, { siteUrl: "https://auspex.example", now: NOW });
  assert.deepEqual(validateMarkdownV2(text), [], text);
  const plain = text.replace(/\\/g, "");
  assert.match(plain, /EARLY SIGNAL/);
  assert.match(plain, /First 10 holding 9\/10/);
  assert.match(plain, /bundle 2\.3% → 1\.9%/);
  assert.match(plain, /6 fresh · 2 dormant · 5 CEX-funded · 11 unique funders/);
  assert.match(plain, /Deployer: wallet/);
  const e = formatEarly(p, { items, now: NOW, updatedAt: new Date(NOW - 30_000).toISOString() });
  assert.deepEqual(validateMarkdownV2(e), [], e);
  assert.match(e, /FINAL STRETCH · 1/);
  assert.match(e, /ABOUT TO GRADUATE/);
  assert.match(e.replace(/\\/g, ""), /win 41\.7%/);
});

test("alert engine: early signals go out once, fresh only, same dedupe + rate limit", async () => {
  let t = NOW;
  const pl = buildPayload(t);
  const sent = [];
  const store = createMemoryStore();
  const engine = createAlertEngine({
    data: { getSignalCache: async () => ({ payload: pl, updatedAt: new Date(t - 20_000).toISOString() }) },
    store, siteUrl: "https://auspex.example", log: silent, now: () => t, sleep: async (ms) => { t += ms; },
    telegram: { sendMessage: async (chatId, text) => { assert.deepEqual(validateMarkdownV2(text), [], text); sent.push({ chatId, text }); return { message_id: sent.length }; } },
  });
  await store.saveRule({ chatId: "9", enabled: true, filters: { ...DEFAULT_FILTERS, kinds: ["early"], maxPerHour: 60 } });
  const r = await engine.tick();
  const coins = r.sent.map((s) => s.coin);
  assert.deepEqual(coins.sort(), ["EGOOD", "HOOD", "STRCH"]); // dev-sold, unfired and 25-min-old signals are held back; HOOD = Robinhood Chain
  assert.equal((await engine.tick()).sent.length, 0); // dedupe
});

test("robinhood early cards: chain-tagged items, ETH conviction, venue / safety / buy-fee badges", () => {
  const items = Object.fromEntries(earlyItems(buildPayload(NOW)).map((i) => [i.address, i]));
  const rh = items[ADDR.rhEarly];
  assert.equal(rh.chain, "robinhood");
  assert.equal(rh.quoteSymbol, "ETH");
  assert.deepEqual(badgesFor(rh).map((b) => b.text), ["💪 CONVICTION 0.41 ETH", "Pons", "✅ safety ok", "buy fee 7.5%"]);
  assert.deepEqual(badgesFor(items[ADDR.rhPool]).map((b) => b.text), ["Uni v4", "\u26A0 safety pending"]);
  assert.equal(items[ADDR.earlyGood].chain, "solana");
});

test("alert rules: chain filter (solana / robinhood / all), Base no longer accepted", () => {
  const items = Object.fromEntries(earlyItems(buildPayload(NOW)).map((i) => [i.address, i]));
  const rh = items[ADDR.rhEarly];
  const def = normalizeFilters({});
  assert.deepEqual(def.chains, ["solana", "robinhood"]);
  assert.equal(evaluate(rh, { kinds: ["early"] }).pass, true);
  const solOnly = applyFilterCommand({}, "chains", "sol").filters;
  assert.ok(evaluate(rh, { ...solOnly, kinds: ["early"] }).reasons.some((r) => r.startsWith("chain robinhood")));
  const rhOnly = applyFilterCommand({}, "chains", "rh").filters;
  assert.deepEqual(rhOnly.chains, ["robinhood"]);
  assert.equal(evaluate(items[ADDR.earlyGood], { ...rhOnly, kinds: ["early"] }).pass, false);
  assert.deepEqual(applyFilterCommand({}, "chains", "all").filters.chains, ["solana", "robinhood"]);
  assert.ok(applyFilterCommand({}, "chains", "base").error);
  // stored rules from before the switch that only named base fall back to the defaults
  assert.deepEqual(normalizeFilters({ chains: ["base"] }).chains, ["solana", "robinhood"]);
  // rugsafe on Robinhood = EVM safety verdict ok
  assert.equal(evaluate(rh, { kinds: ["early"], requireRugSafe: true }).pass, true);
  assert.ok(evaluate(items[ADDR.rhPool], { kinds: ["early"], arms: ["early_curve"], requireRugSafe: true }).reasons.some((r) => r.includes("EVM safety pending")));
});

test("/early chain filter: one chain or both, never mixing the other chain's rows", () => {
  const p = buildPayload(NOW);
  const items = earlyItems(p);
  const rh = formatEarly(p, { items, now: NOW, chain: "robinhood" });
  assert.match(rh, /Robinhood Chain/);
  assert.match(rh, /HOOD/);
  assert.doesNotMatch(rh, /EGOOD/);
  assert.match(rh, /ETH \$2377/);
  const sol = formatEarly(p, { items, now: NOW, chain: "solana" });
  assert.doesNotMatch(sol, /HOOD/);
  assert.match(sol, /EGOOD/);
  const both = formatEarly(p, { items, now: NOW });
  assert.match(both, /\\\[RH\\\]/);
  for (const t of [rh, sol, both]) assert.deepEqual(validateMarkdownV2(t), [], t);
});

test("v4_direct (Robinhood direct Uniswap v4 launches): arm, badge, alert filter, /early section and paper lines", () => {
  const p = buildPayload(NOW);
  const items = Object.fromEntries(earlyItems(p).map((i) => [i.address, i]));
  const v4 = items[ADDR.rhV4];
  assert.equal(v4.arm, "v4_direct");
  assert.equal(v4.fired, true);
  assert.deepEqual(badgesFor(v4).map((b) => b.text), ["⚡ V4 DIRECT ✓", "Uni v4", "✅ safety ok"]);
  // opt-in: default arms leave it out; "arms v4" / "all" lets it through
  assert.ok(evaluate(v4, normalizeFilters({ ...DEFAULT_FILTERS, exclude: [] })).reasons.some((r) => /arm v4_direct not in/.test(r)));
  const on = applyFilterCommand(normalizeFilters({ ...DEFAULT_FILTERS, exclude: [] }), "arms", "early,stretch,v4").filters;
  assert.deepEqual(on.arms, ["early_curve", "final_stretch", "v4_direct"]);
  assert.equal(evaluate(v4, on).pass, true, evaluate(v4, on).reasons.join("; "));
  assert.deepEqual(applyFilterCommand({}, "arms", "all").filters.arms, ["early_curve", "final_stretch", "v4_direct"]);
  assert.match(applyFilterCommand({}, "arms", "bogus").error, /early, stretch, v4/);
  const alert = formatAlert(v4, { now: NOW });
  assert.match(alert, /V4 DIRECT · ROBINHOOD/);
  assert.match(alert, /opened \$120\\.0K \\\(\\\+242%\\\)/);
  assert.deepEqual(validateMarkdownV2(alert), [], alert);
  p.earlyPaper.byChain = { robinhood: { early_curve: p.earlyPaper.early_curve, v4_direct: { closed: 9, winRatePct: 33.3, peak2xPct: 22.2, win2xPct: 11.1, medianRealizedMultiple: 0.81 }, v4_control: { closed: 8, winRatePct: 25, peak2xPct: 12.5, win2xPct: 0, medianRealizedMultiple: 0.7 } } };
  const rh = formatEarly(p, { items: earlyItems(p), now: NOW, chain: "robinhood" });
  assert.match(rh, /V4 DIRECT \\\(Robinhood/);
  assert.match(rh, /PRISM/);
  assert.match(rh, /1 v4 direct/);
  assert.match(rh, /random control: 8 closed/);
  assert.deepEqual(validateMarkdownV2(rh), [], rh);
  const sol = formatEarly(p, { items: earlyItems(p), now: NOW, chain: "solana" });
  assert.doesNotMatch(sol, /V4 DIRECT|PRISM/);
});
