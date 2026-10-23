import test from "node:test";
import assert from "node:assert/strict";
import { buildPayload, ADDR } from "./fixtures/synthetic.js";
import { allItems, findCoin, lookupByAddress } from "../lib/normalize.js";
import { badgesFor, badgeText, creatorVerdict } from "../lib/badges.js";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const p = buildPayload(NOW);
const get = (addr) => findCoin(p, addr)[0];

test("proven dev + RugCheck safe signal", () => {
  const it = get(ADDR.provenSignal);
  const t = badgeText(badgesFor(it));
  assert.match(t, /🟢 SAFE/); assert.match(t, /🏆 PROVEN DEV · 2 winners/); assert.match(t, /SERIAL LAUNCHER: 6 TOKENS/);
  assert.equal(creatorVerdict(it), "good");
});
test("bad always wins: rug dev with promising record is bad and the good badge is muted", () => {
  const it = get(ADDR.ruggerSignal);
  const bs = badgesFor(it);
  assert.equal(creatorVerdict(it), "bad");
  assert.ok(bs.find((b) => /PROMISING DEV/.test(b.text)).muted);
  assert.match(badgeText(bs), /🚨 RUG DEV · CONFIRMED.*⚠️ HEURISTIC LIST · UNVERIFIED/);
  assert.match(badgeText(bs), /INSIDERS DETECTED \(7\)/);
});
test("heuristic-only is its own verdict, sanctioned is bad", () => {
  assert.equal(creatorVerdict(get(ADDR.heuristicLaunch)), "heuristic");
  assert.equal(creatorVerdict(get(ADDR.sanctionedLaunch)), "bad");
  assert.match(badgeText(badgesFor(get(ADDR.sanctionedLaunch))), /⛔ SANCTIONED/);
});
test("graduation badges: venue, launchpad, rugged + danger", () => {
  const t = badgeText(badgesFor(get(ADDR.ruggedGrad)));
  assert.match(t, /🔴 DANGER/); assert.match(t, /→ PumpSwap/); assert.match(t, /☠ RUGGED/);
});
test("KOL / LunarCrush / AltRank / hype badges", () => {
  const t = badgeText(badgesFor(get(ADDR.kolSignal)));
  assert.match(t, /KOL BUY: Ansem, Cupsey \+1/); assert.match(t, /GS 71/); assert.match(t, /\+180 AltRank/); assert.match(t, /ORGANIC/);
});
test("EVM lookups are case-insensitive, Solana exact", () => {
  assert.equal(findCoin(p, ADDR.baseSignal.toUpperCase().replace("0X", "0x"))[0]?.symbol, "BBULL");
  assert.equal(lookupByAddress({ abc: 1 }, "ABC"), 1);
});
test("every real-feed item yields badges without throwing", () => {
  const items = allItems(p);
  assert.ok(items.length > 30);
  for (const it of items) { assert.ok(Array.isArray(badgesFor(it))); creatorVerdict(it); }
});
