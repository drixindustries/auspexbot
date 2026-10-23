import test from "node:test";
import assert from "node:assert/strict";
import { buildPayload, ADDR } from "./fixtures/synthetic.js";
import { allItems, findCoin } from "../lib/normalize.js";
import { formatAlert, formatCoinCard, formatFeed, formatItemList, formatPaper, formatHallOfFame, formatTopPost, siteCoinUrl } from "../lib/format.js";
import { validateMarkdownV2 } from "../lib/md.js";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const p = buildPayload(NOW);
const ok = (t) => assert.deepEqual(validateMarkdownV2(t), [], t);

test("every item formats to valid MarkdownV2 (alerts and coin cards)", () => {
  for (const it of allItems(p)) { ok(formatAlert(it, { siteUrl: "https://a.b", now: NOW })); ok(formatCoinCard([it], { siteUrl: "https://a.b", now: NOW })); }
});
test("lists, paper, HoF and autopost are valid", () => {
  ok(formatFeed(p, { now: NOW })); ok(formatFeed(p, { chain: "base", now: NOW }));
  ok(formatItemList("Launches", allItems(p).filter((i) => i.kind === "launch"), { now: NOW }));
  ok(formatItemList("Empty", [], { now: NOW }));
  ok(formatPaper({ trades: [{ token_symbol: "X.Y", entry_mcap_usd: 1000, status: "closed", outcome: "graduated", final_pnl_pct: 12.5, entry_time: "2026-10-22T00:00:00Z", pnl_1h_pct: -3 }], stats: { total: 1, graduated: 1, completed: 1, wins: 1 }, testCount: 2 }));
  ok(formatHallOfFame([{ token_symbol: "(ODIE)", peak_mcap_usd: 5e6, first_seen_mcap_usd: 1e5, peak_multiple: 50, chain_id: "solana", token_address: "abc" }]));
  ok(formatTopPost(allItems(p).slice(0, 5), ["a (b).", null], { siteUrl: "https://a.b", now: NOW }));
});
test("alert carries verdict, badges and site link", () => {
  const t = formatAlert(findCoin(p, ADDR.ruggerSignal)[0], { siteUrl: "https://a.b", now: NOW });
  assert.match(t, /RUG DEV/); assert.match(t, /~⭐ PROMISING DEV · 1 winner~/);
  assert.equal(siteCoinUrl("https://a.b/", { chain: "base", address: "0xAbC" }), "https://a.b/?chain=base&ca=0xAbC");
});
