// Adapter for auspex_signal_outcomes (signal performance tracking, being added on branch
// feat/signal-performance of auspex-worker / auspex-site). That schema is not final, so this adapter:
//   * degrades gracefully: if the table is missing / unreadable, stats are { available:false } and any
//     rule that depends on them is skipped (reported in /alerts), never blocking other alerts;
//   * detects columns from a short candidate list instead of hard-coding one name (override via env
//     AUSPEX_OUTCOMES_SCORE_COL / _RETURN_COL / _HIT_COL / _KIND_COL once the PR lands).
// Stats are hit rates per score bucket (10-point buckets) and optionally per kind (signal/launch/graduation).

const CANDIDATES = {
  score: ["first_seen_score", "entry_score", "score", "signal_score"],
  ret: ["return_24h_pct", "pnl_24h_pct", "change_24h_pct", "max_return_pct", "return_pct", "final_pnl_pct", "pnl_pct"],
  hit: ["is_hit", "hit", "is_win", "win"],
  kind: ["kind", "signal_kind", "entry_kind", "source_kind"],
  chain: ["chain_id", "chain"],
};

export const BUCKET = 10;
export const MIN_SAMPLE = 10; // below this a bucket's hit rate is reported but not trusted by rules

function pick(row, names, override) {
  if (override) return row[override] !== undefined ? override : null;
  return names.find((n) => row[n] !== undefined) || null;
}

export function bucketOf(score) {
  if (score == null || !Number.isFinite(Number(score))) return null;
  const s = Math.max(0, Math.min(100, Number(score)));
  return Math.min(90, Math.floor(s / BUCKET) * BUCKET);
}

/** Pure: rows -> stats. Exported for tests. */
export function computeOutcomeStats(rows, env = {}) {
  if (!rows || !rows.length) return { available: true, empty: true, buckets: {}, n: 0, columns: null };
  const sample = rows.find((r) => r && typeof r === "object") || {};
  const cols = {
    score: pick(sample, CANDIDATES.score, env.AUSPEX_OUTCOMES_SCORE_COL),
    ret: pick(sample, CANDIDATES.ret, env.AUSPEX_OUTCOMES_RETURN_COL),
    hit: pick(sample, CANDIDATES.hit, env.AUSPEX_OUTCOMES_HIT_COL),
    kind: pick(sample, CANDIDATES.kind, env.AUSPEX_OUTCOMES_KIND_COL),
    chain: pick(sample, CANDIDATES.chain, null),
  };
  if (!cols.hit && !cols.ret) return { available: false, reason: "no hit/return column recognised", columns: cols };

  const buckets = {}; // key "kind|chain|bucket" and "*|*|bucket"
  let n = 0;
  const add = (key, hit) => {
    const s = (buckets[key] = buckets[key] || { n: 0, hits: 0 });
    s.n += 1; if (hit) s.hits += 1;
  };
  for (const r of rows) {
    let hit;
    if (cols.hit && r[cols.hit] != null) hit = r[cols.hit] === true || r[cols.hit] === "true" || r[cols.hit] === 1;
    else if (cols.ret && r[cols.ret] != null && Number.isFinite(Number(r[cols.ret]))) hit = Number(r[cols.ret]) > 0;
    else continue; // outcome not resolved yet
    const bk = cols.score ? bucketOf(r[cols.score]) : null;
    const kind = cols.kind ? r[cols.kind] || "*" : "*";
    const chain = cols.chain ? r[cols.chain] || "*" : "*";
    n += 1;
    for (const k of new Set([`${kind}|${chain}|${bk}`, `${kind}|*|${bk}`, `*|*|${bk}`, `*|*|all`])) add(k, hit);
  }
  for (const s of Object.values(buckets)) s.rate = s.n ? Math.round((s.hits / s.n) * 1000) / 10 : null;
  return { available: true, empty: n === 0, buckets, n, columns: cols };
}

/** Best stats for an item: most specific cohort with enough samples, else the widest one. */
export function hitRateFor(stats, item) {
  if (!stats || !stats.available || stats.empty) return null;
  const bk = bucketOf(item.score ?? null);
  const keys = [`${item.kind}|${item.chain}|${bk}`, `${item.kind}|*|${bk}`, `*|*|${bk}`];
  for (const k of keys) {
    const s = stats.buckets[k];
    if (s && s.n >= MIN_SAMPLE) return { ...s, cohort: k, trusted: true };
  }
  for (const k of keys) {
    const s = stats.buckets[k];
    if (s) return { ...s, cohort: k, trusted: false };
  }
  return null;
}

export function createOutcomes({ data, env = process.env, ttlMs = 10 * 60_000, now = () => Date.now(), log = console } = {}) {
  let cache = null;
  let lastState = null;
  async function getStats({ force = false } = {}) {
    if (!force && cache && now() - cache.at < ttlMs) return cache.stats;
    let r = await data.getOutcomeRows("select=*&order=created_at.desc.nullslast&limit=5000");
    if (!r.available && r.status === 400) r = await data.getOutcomeRows("select=*&limit=5000"); // no created_at column
    let stats;
    if (!r.available) stats = { available: false, reason: r.reason || "unavailable" };
    else stats = computeOutcomeStats(r.rows, env);
    const state = stats.available ? "available" : `unavailable (${stats.reason})`;
    if (state !== lastState) { log.log?.(`[outcomes] auspex_signal_outcomes ${state}`); lastState = state; }
    cache = { at: now(), stats };
    return stats;
  }
  return { getStats };
}
