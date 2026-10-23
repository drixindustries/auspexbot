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
  assert.deepEqual(coins.sort(), ["EGOOD", "STRCH"]); // dev-sold, unfired and 25-min-old signals are held back
  assert.equal((await engine.tick()).sent.length, 0); // dedupe
});
