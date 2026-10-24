import test from "node:test";
import assert from "node:assert/strict";
import { momentumItems, allItems, findCoin } from "../lib/normalize.js";
import { badgesFor } from "../lib/badges.js";
import { evaluate, applyFilterCommand, normalizeFilters, DEFAULT_FILTERS, KINDS } from "../lib/rules.js";
import { formatAlert } from "../lib/format.js";
import { validateMarkdownV2 } from "../lib/md.js";
import { createAlertEngine } from "../lib/alertEngine.js";
import { createMemoryStore } from "../lib/alertStore.js";
import { silent } from "./helpers.js";

const NOW = Date.parse("2026-10-24T00:46:00Z");
const ELIZA = "Biiv46yBzZwwdg3HvYQ52yPXmnMb5EnF8dboTx2qpump";
const ELON = "FUMMypMwEQqvx2zNXBA5gororx5nEjPtV9WUPxN8kRuu";
const BAD = "BADxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump";

// payload.postGradMomentum as written by the worker (feat/post-grad-momentum, lib/post-grad-momentum.js)
function payload(at = NOW) {
  const sig = (mint, o) => ({
    mint, name: o.name, symbol: o.symbol, at: new Date(at - (o.agoMs ?? 30_000)).toISOString(), boardScore: 30, sources: o.sources || ["DEXPROFILE"],
    boardMcapUsd: o.board ?? null, quoteMcapUsd: o.mcap, quoteDivergencePct: null, quoteStale: !!o.stale, poolAgeMin: o.pool ?? 0.6,
    liquidityUsd: o.liq ?? 31_000, dexId: "pumpswap", pairAddress: "PAIR" + mint.slice(0, 4), buys5m: 120, sells5m: 60, change5m: 35.2, brand: o.brand ?? null,
  });
  return {
    generatedAt: new Date(at).toISOString(),
    chainGroups: {},
    rugSafety: { [ELIZA]: { tier: "safe", riskScore: 1 } },
    signalCreatorFlags: { [`solana:${BAD}`]: { creator: "Cre8", bad: [{ kind: "confirmed", sourceId: "rugdev", label: "RUG DEV" }] } },
    postGradMomentum: {
      config: { minMcapUsd: 8000, maxMcapUsd: 80000, maxPoolAgeMin: 5 },
      signals: [
        sig(ELIZA, { name: "Why would I deceive you?", symbol: "ELIZABETH", mcap: 44_000, board: 17_593, stale: true }),
        sig(ELON, { name: "Elon Coin", symbol: "ELON", mcap: 24_000, sources: ["GTNEW"], brand: "elon", pool: 1.5 }),
        sig(BAD, { name: "Bad", symbol: "BAD", mcap: 40_000 }),
        sig("OLDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump", { name: "Old", symbol: "OLD", mcap: 40_000, agoMs: 30 * 60_000 }),
      ],
    },
  };
}

test("momentum items: fresh AMM quote as mcap, board quote kept, creator flags and RugCheck joined", () => {
  const items = momentumItems(payload());
  assert.equal(items.length, 4);
  const e = items[0];
  assert.equal(e.kind, "momentum");
  assert.equal(e.mcapUsd, 44_000);
  assert.equal(e.boardMcapUsd, 17_593);
  assert.equal(e.quoteStale, true);
  assert.equal(e.rug.tier, "safe");
  assert.equal(items[2].creatorFlag.bad[0].kind, "confirmed");
  assert.equal(momentumItems({}).length, 0);
  assert.ok(allItems(payload()).some((i) => i.kind === "momentum"));
  assert.equal(findCoin(payload(), ELIZA)[0].kind, "momentum");
});

test("rules: momentum is a default alert kind; bad creators excluded; /filter mcap applies; kinds alias pgm", () => {
  assert.ok(KINDS.includes("momentum"));
  assert.ok(DEFAULT_FILTERS.kinds.includes("momentum"));
  const by = Object.fromEntries(momentumItems(payload()).map((i) => [i.symbol, i]));
  const d = normalizeFilters({});
  assert.equal(evaluate(by.ELIZABETH, d).pass, true);
  assert.equal(evaluate(by.ELON, d).pass, true); // board score is irrelevant for this kind
  assert.ok(evaluate(by.BAD, d).reasons.some((r) => /excluded: confirmed/.test(r)));
  const band = applyFilterCommand(d, "mcap", "8k-25k").filters;
  assert.ok(evaluate(by.ELIZABETH, band).reasons.some((r) => /mcap \$44000 > \$25000/.test(r)));
  assert.equal(evaluate(by.ELON, band).pass, true);
  assert.deepEqual(applyFilterCommand(d, "kinds", "pgm").filters.kinds, ["momentum"]);
  assert.ok(evaluate(by.ELIZABETH, normalizeFilters({ kinds: ["signal"] })).reasons.some((r) => /kind momentum/.test(r)));
});

test("alert card: header, stale-board note, plan line, valid MarkdownV2", () => {
  const [e] = momentumItems(payload());
  const text = formatAlert(e, { siteUrl: "https://auspex.example", now: NOW });
  assert.deepEqual(validateMarkdownV2(text), [], text);
  assert.match(text, /POST\\-GRAD MOMENTUM/);
  assert.match(text, /board showed \$17\\\.6K/);
  assert.match(text, /pool 36s old/);
  assert.match(text, /25% at 3x/);
  assert.deepEqual(badgesFor(momentumItems(payload())[1]).map((b) => b.text), ["™ BRAND: elon"]);
});

test("alert engine: sends fresh momentum signals once, holds back stale and bad-creator ones", async () => {
  let t = NOW;
  const pl = payload(NOW);
  const sent = [];
  const store = createMemoryStore();
  const engine = createAlertEngine({
    data: { getSignalCache: async () => ({ payload: pl, updatedAt: new Date(t - 20_000).toISOString() }) },
    store, siteUrl: "https://auspex.example", log: silent, now: () => t, sleep: async (ms) => { t += ms; },
    telegram: { sendMessage: async (chatId, text) => { assert.deepEqual(validateMarkdownV2(text), [], text); sent.push({ chatId, text }); return { message_id: sent.length }; } },
  });
  await store.saveRule({ chatId: "7", enabled: true, filters: { ...DEFAULT_FILTERS, maxPerHour: 60 } });
  const r = await engine.tick();
  assert.deepEqual(r.sent.map((s) => s.coin).sort(), ["ELIZABETH", "ELON"]);
  assert.equal((await engine.tick()).sent.length, 0);
});
