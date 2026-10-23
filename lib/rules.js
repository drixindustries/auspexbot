// Telegram alert rules: per-chat filters on top of the Auspex feed (the same items the site shows).
// Stored as JSON (auspex_bot_alert_rules.filters) so new filters don't need a migration.

import { badMatches, goodDev, rugInsights, rugTier, liquidityUsd } from "./normalize.js";
import { hitRateFor } from "./outcomes.js";

export const KINDS = ["signal", "launch", "graduation"];
export const CHAINS = ["solana", "base"];
// Things a rule can exclude. Bad-list kinds come from the worker's creator reputation; the rest from RugCheck.
export const EXCLUDABLE = ["sanctioned", "confirmed", "suspected", "heuristic", "rugged", "insiders", "serial", "danger"];

export const DEFAULT_FILTERS = Object.freeze({
  kinds: ["signal", "graduation"],
  chains: ["solana", "base"],
  minScore: 60,             // signals only (launches/graduations have no score)
  minLiquidityUsd: 0,       // 0 = off; when set, items with unknown liquidity are excluded
  minProviders: 1,          // signals: distinct providers that listed the same CA (site's "×N confirmed")
  requireDev: null,         // null | "promising" (promising or proven) | "proven"
  requireRugSafe: false,    // RugCheck tier must be "safe" (Solana only; unknown tier fails)
  exclude: ["sanctioned", "confirmed", "suspected", "rugged", "danger"],
  minHitRate: null,         // % — needs auspex_signal_outcomes; skipped (not failed) when stats are unavailable
  maxPerHour: 10,
});

export const LIMITS = { maxPerHour: [1, 60], minScore: [0, 100], minProviders: [1, 5], minHitRate: [0, 100] };

export function normalizeFilters(f = {}) {
  const d = DEFAULT_FILTERS;
  const arr = (v, allowed, fallback) => {
    const list = Array.isArray(v) ? v.filter((x) => allowed.includes(x)) : fallback;
    return [...new Set(list)];
  };
  const clamp = (v, [lo, hi], fb) => (v == null || !Number.isFinite(Number(v)) ? fb : Math.max(lo, Math.min(hi, Number(v))));
  return {
    kinds: arr(f.kinds, KINDS, d.kinds).length ? arr(f.kinds, KINDS, d.kinds) : [...d.kinds],
    chains: arr(f.chains, CHAINS, d.chains).length ? arr(f.chains, CHAINS, d.chains) : [...d.chains],
    minScore: clamp(f.minScore, LIMITS.minScore, d.minScore),
    minLiquidityUsd: Math.max(0, Number(f.minLiquidityUsd) || 0),
    minProviders: clamp(f.minProviders, LIMITS.minProviders, d.minProviders),
    requireDev: f.requireDev === "proven" || f.requireDev === "promising" ? f.requireDev : null,
    requireRugSafe: !!f.requireRugSafe,
    exclude: Array.isArray(f.exclude) ? [...new Set(f.exclude.filter((x) => EXCLUDABLE.includes(x)))] : [...d.exclude],
    minHitRate: f.minHitRate == null ? null : clamp(f.minHitRate, LIMITS.minHitRate, null),
    maxPerHour: clamp(f.maxPerHour, LIMITS.maxPerHour, d.maxPerHour),
  };
}

function parseMoney(s) {
  const m = String(s).trim().toLowerCase().replace(/[$,_]/g, "").match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1);
}
function parseList(s) {
  return String(s).toLowerCase().split(/[\s,]+/).filter(Boolean);
}
function parseBool(s) {
  const v = String(s).toLowerCase();
  if (["on", "yes", "true", "1", "y"].includes(v)) return true;
  if (["off", "no", "false", "0", "n", "none"].includes(v)) return false;
  return null;
}

const ALIASES = {
  score: "minScore", min_score: "minScore", minscore: "minScore",
  liq: "minLiquidityUsd", min_liq: "minLiquidityUsd", liquidity: "minLiquidityUsd", min_liquidity: "minLiquidityUsd",
  providers: "minProviders", min_providers: "minProviders", confirmed: "minProviders",
  dev: "requireDev", require_dev: "requireDev",
  rugsafe: "requireRugSafe", rug_safe: "requireRugSafe", require_rug_safe: "requireRugSafe", safe: "requireRugSafe",
  exclude: "exclude", include: "include",
  chains: "chains", chain: "chains",
  kinds: "kinds", kind: "kinds", types: "kinds",
  hitrate: "minHitRate", hit_rate: "minHitRate", min_hit_rate: "minHitRate",
  rate: "maxPerHour", max_per_hour: "maxPerHour", perhour: "maxPerHour",
};

const KIND_ALIASES = { signals: "signal", launches: "launch", graduations: "graduation", grads: "graduation", grad: "graduation", all: "*" };
const EXCLUDE_ALIASES = { rugdev: ["confirmed", "suspected"], "rug-dev": ["confirmed", "suspected"], bad: ["sanctioned", "confirmed", "suspected"], ofac: ["sanctioned"], allenhark: ["heuristic"], all: EXCLUDABLE, none: [] };

/**
 * Apply one "/filter <key> <value>" to a filter set. Returns { filters, message } or { error }.
 * Examples: score 70 | chains solana | kinds graduation | dev proven | rugsafe on | liq 20k |
 *           exclude heuristic,rugdev | include heuristic | hitrate 40 | hitrate off | rate 5 | reset
 */
export function applyFilterCommand(current, key, rawValue) {
  const f = normalizeFilters(current);
  const k = ALIASES[String(key || "").toLowerCase()] || (String(key || "").toLowerCase() === "reset" ? "reset" : null);
  const v = rawValue == null ? "" : String(rawValue).trim();
  if (!k) return { error: `Unknown filter "${key}".` };
  if (k === "reset") return { filters: normalizeFilters({}), message: "Filters reset to defaults." };
  if (!v) return { error: `Missing value for ${key}.` };
  switch (k) {
    case "minScore": case "minProviders": case "maxPerHour": {
      const n = Number(v);
      if (!Number.isFinite(n)) return { error: `${key} must be a number.` };
      const [lo, hi] = LIMITS[k];
      f[k] = Math.max(lo, Math.min(hi, Math.round(n)));
      return { filters: f, message: `${k} = ${f[k]}` };
    }
    case "minHitRate": {
      if (parseBool(v) === false) { f.minHitRate = null; return { filters: f, message: "minHitRate off" }; }
      const n = Number(String(v).replace("%", ""));
      if (!Number.isFinite(n)) return { error: "hitrate must be a percentage or off." };
      f.minHitRate = Math.max(0, Math.min(100, n));
      return { filters: f, message: `minHitRate = ${f.minHitRate}%` };
    }
    case "minLiquidityUsd": {
      if (parseBool(v) === false) { f.minLiquidityUsd = 0; return { filters: f, message: "minLiquidityUsd off" }; }
      const n = parseMoney(v);
      if (n == null) return { error: "liq must look like 20000, 20k or 1.5m." };
      f.minLiquidityUsd = n;
      return { filters: f, message: `minLiquidityUsd = $${n.toLocaleString("en-US")}` };
    }
    case "requireDev": {
      const x = v.toLowerCase();
      if (x === "proven" || x === "promising") f.requireDev = x;
      else if (parseBool(x) === false || x === "any") f.requireDev = null;
      else return { error: "dev must be proven, promising or off." };
      return { filters: f, message: `requireDev = ${f.requireDev || "off"}` };
    }
    case "requireRugSafe": {
      const bv = parseBool(v);
      if (bv == null) return { error: "rugsafe must be on or off." };
      f.requireRugSafe = bv;
      return { filters: f, message: `requireRugSafe = ${bv ? "on" : "off"}` };
    }
    case "exclude": case "include": {
      const items = parseList(v).flatMap((x) => EXCLUDE_ALIASES[x] || [x]);
      const bad = items.filter((x) => !EXCLUDABLE.includes(x));
      if (bad.length) return { error: `Unknown flag(s): ${bad.join(", ")}. Use: ${EXCLUDABLE.join(", ")}, rugdev, bad, all, none.` };
      const set = new Set(k === "exclude" && parseList(v).includes("none") ? [] : f.exclude);
      for (const x of items) k === "exclude" ? set.add(x) : set.delete(x);
      f.exclude = EXCLUDABLE.filter((x) => set.has(x));
      return { filters: f, message: `exclude = ${f.exclude.join(", ") || "nothing"}` };
    }
    case "chains": {
      const list = parseList(v).flatMap((x) => (x === "all" ? CHAINS : x === "sol" ? ["solana"] : [x]));
      const bad = list.filter((x) => !CHAINS.includes(x));
      if (bad.length || !list.length) return { error: `chains must be from: ${CHAINS.join(", ")} (or all).` };
      f.chains = [...new Set(list)];
      return { filters: f, message: `chains = ${f.chains.join(", ")}` };
    }
    case "kinds": {
      const list = parseList(v).flatMap((x) => { const a = KIND_ALIASES[x] || x; return a === "*" ? KINDS : [a]; });
      const bad = list.filter((x) => !KINDS.includes(x));
      if (bad.length || !list.length) return { error: `kinds must be from: ${KINDS.join(", ")} (or all).` };
      f.kinds = [...new Set(list)];
      return { filters: f, message: `kinds = ${f.kinds.join(", ")}` };
    }
    default:
      return { error: `Unknown filter "${key}".` };
  }
}

/** Flags present on an item, in the vocabulary of `exclude`. */
export function itemFlags(item) {
  const flags = new Set(badMatches(item).map((m) => m.kind));
  if (item.kind === "launch" && item.isBadActor && !flags.size) flags.add("confirmed"); // legacy payloads
  const ins = rugInsights(item);
  if (ins?.rugged) flags.add("rugged");
  if (ins?.insidersDetected > 0) flags.add("insiders");
  if (ins?.creatorTokens?.count >= 3) flags.add("serial");
  if (rugTier(item) === "danger") flags.add("danger");
  return flags;
}

/**
 * Evaluate one item against a filter set. Returns { pass, reasons[] (why it failed), notes[] (skipped checks), hitRate }.
 * ctx.outcomes = stats from lib/outcomes.js (or null).
 */
export function evaluate(item, filters, ctx = {}) {
  const f = normalizeFilters(filters);
  const reasons = [];
  const notes = [];
  if (!f.kinds.includes(item.kind)) reasons.push(`kind ${item.kind} not in ${f.kinds.join("/")}`);
  if (!f.chains.includes(item.chain)) reasons.push(`chain ${item.chain} not in ${f.chains.join("/")}`);
  if (item.kind === "signal") {
    if ((item.score ?? 0) < f.minScore) reasons.push(`score ${item.score ?? "?"} < ${f.minScore}`);
    if ((item.providerCount ?? 1) < f.minProviders) reasons.push(`providers ${item.providerCount} < ${f.minProviders}`);
  }
  if (f.minLiquidityUsd > 0) {
    const liq = liquidityUsd(item);
    if (liq == null) reasons.push("liquidity unknown");
    else if (liq < f.minLiquidityUsd) reasons.push(`liquidity $${Math.round(liq)} < $${f.minLiquidityUsd}`);
  }
  if (f.requireDev) {
    const good = goodDev(item);
    const ok = good && (f.requireDev === "promising" ? ["promising", "proven"].includes(good.tier) : good.tier === "proven");
    if (!ok) reasons.push(`dev not ${f.requireDev}`);
    else if (badMatches(item).length) reasons.push("good dev is also on a bad list"); // bad always wins (site rule)
  }
  if (f.requireRugSafe && rugTier(item) !== "safe") reasons.push(`RugCheck ${rugTier(item) || "unknown"}, not safe`);
  const flags = itemFlags(item);
  const hit = f.exclude.filter((x) => flags.has(x));
  if (hit.length) reasons.push(`excluded: ${hit.join(", ")}`);

  let hitRate = null;
  const stats = ctx.outcomes;
  if (stats && stats.available && !stats.empty) hitRate = hitRateFor(stats, item);
  if (f.minHitRate != null) {
    if (!stats || !stats.available) notes.push("hit-rate filter skipped: performance stats unavailable");
    else if (!hitRate || !hitRate.trusted) notes.push("hit-rate filter skipped: not enough history for this cohort");
    else if (hitRate.rate < f.minHitRate) reasons.push(`cohort hit rate ${hitRate.rate}% < ${f.minHitRate}%`);
  }
  return { pass: reasons.length === 0, reasons, notes, hitRate };
}

export function describeFilters(filters) {
  const f = normalizeFilters(filters);
  return [
    `kinds: ${f.kinds.join(", ")}`,
    `chains: ${f.chains.join(", ")}`,
    `min score (signals): ${f.minScore}`,
    `min providers (signals): ${f.minProviders}`,
    `min liquidity: ${f.minLiquidityUsd ? "$" + f.minLiquidityUsd.toLocaleString("en-US") : "off"}`,
    `require dev: ${f.requireDev || "off"}`,
    `require RugCheck safe: ${f.requireRugSafe ? "on" : "off"}`,
    `exclude: ${f.exclude.join(", ") || "nothing"}`,
    `min hit rate: ${f.minHitRate != null ? f.minHitRate + "%" : "off"}`,
    `max alerts/hour: ${f.maxPerHour}`,
  ];
}
