// Signal performance (auspex-worker feat/signal-performance, lib/signal-outcomes.js).
//
// Source of truth, in order:
//   1. payload.signalPerformance — the worker's own aggregate (7-day window, refreshed every 5 min) in the
//      same cache row the site reads. Same numbers as the site's performance panel.
//   2. auspex_signal_outcomes — if the payload has no aggregate (older worker), the rows are read and
//      aggregated here with the worker's rules (ported below), so the numbers still match.
//   3. Neither → { available:false }: hit-rate rules are skipped with a note, never blocking alerts.
//
// "Hit" = the worker's hit +50%: reached +50% (sampled) before -50%, counted over RESOLVED signals only.
// Cohort for an item: score band for board signals (top_signal), kind for launches / graduations.

export const WINDOW_MS = 7 * 24 * 3600_000; // worker: OUTCOME_STATS_WINDOW_MS
export const MIN_DECIDED = 10;              // site: PERF_MIN_N — fewer resolved signals than this isn't trusted
export const CHECKPOINT_KEYS = ["5m", "15m", "1h", "6h", "24h"];
const UP = [50, 100];

/** Bot item kind → outcome-record kind. */
export const OUTCOME_KIND = { signal: "top_signal", launch: "launch", graduation: "graduation" };

/** worker: scoreBand() */
export function scoreBand(score) {
  const s = Number(score);
  if (score == null || !Number.isFinite(s)) return "unscored";
  if (s < 25) return "0-24";
  if (s < 50) return "25-49";
  if (s < 75) return "50-74";
  return "75-100";
}

const round = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
function median(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const t = (v) => (v == null ? null : new Date(v).getTime());

/** worker: hitOutcome() over a DB row. */
export function rowOutcome(row, upPct) {
  const up = t(row[`hit_up${upPct}_at`]);
  const down = t(row.hit_down50_at);
  if (up != null && (down == null || up <= down)) return "hit";
  if (down != null) return "miss";
  if (row.status === "done" || row.status === "expired") return "miss";
  return "pending";
}

/** worker: aggregate() over auspex_signal_outcomes rows (same dims, same bucket fields). */
export function aggregateRows(rows, { now = Date.now() } = {}) {
  const buckets = new Map();
  const bucket = (dim, value) => {
    const k = `${dim}\u0000${value}`;
    if (!buckets.has(k)) buckets.set(k, { dim, value, n: 0, hits: {}, decided: {}, rugs: 0, cps: {}, maxUps: [], maxDowns: [] });
    return buckets.get(k);
  };
  const add = (b, r) => {
    b.n += 1;
    for (const u of UP) {
      const o = rowOutcome(r, u);
      if (o !== "pending") { b.decided[u] = (b.decided[u] || 0) + 1; if (o === "hit") b.hits[u] = (b.hits[u] || 0) + 1; }
    }
    if (r.rugged || r.liq_collapsed) b.rugs += 1;
    for (const k of CHECKPOINT_KEYS) {
      const c = r.checkpoints?.[k];
      if (c && !c.missed && !c.late && c.returnPct != null) (b.cps[k] ||= []).push(Number(c.returnPct));
    }
    if (r.status !== "tracking" && r.max_up_pct != null) { b.maxUps.push(Number(r.max_up_pct)); b.maxDowns.push(Number(r.max_drawdown_pct)); }
  };
  let counted = 0;
  for (const r of rows) {
    if (!r.entry_basis) continue; // no entry price ever → no returns (worker: minEntry)
    counted += 1;
    add(bucket("all", "all"), r);
    add(bucket("kind", r.kind), r);
    add(bucket("chain", r.chain_id), r);
    add(bucket("scoreBand", r.score_band || scoreBand(r.score)), r);
    for (const s of r.sources || []) add(bucket("source", s), r);
    for (const bd of (r.badges && r.badges.length ? r.badges : ["(none)"])) add(bucket("badge", bd), r);
  }
  const out = [...buckets.values()].map((b) => {
    const row = { dim: b.dim, value: b.value, n: b.n, rugRatePct: b.n ? round((b.rugs / b.n) * 100) : null, median: {}, samples: {} };
    for (const u of UP) { const d = b.decided[u] || 0; row[`hit${u}`] = { hits: b.hits[u] || 0, decided: d, ratePct: d ? round(((b.hits[u] || 0) / d) * 100) : null }; }
    for (const k of CHECKPOINT_KEYS) { const a = b.cps[k] || []; row.median[k] = round(median(a)); row.samples[k] = a.length; }
    row.medianMaxUpPct = round(median(b.maxUps));
    row.medianMaxDrawdownPct = round(median(b.maxDowns));
    return row;
  });
  out.sort((a, b) => (a.dim === b.dim ? b.n - a.n : 0));
  return { generatedAt: new Date(now).toISOString(), counted, rows: out, windowDays: WINDOW_MS / 86_400_000 };
}

/** Normalise either source into { available, source, rows, counted, windowDays, generatedAt }. */
export function statsFrom(perf, source) {
  if (!perf || !Array.isArray(perf.rows)) return { available: false, reason: "no signalPerformance" };
  return { available: true, source, empty: !perf.counted, counted: perf.counted ?? 0, rows: perf.rows, windowDays: perf.windowDays ?? 7, generatedAt: perf.generatedAt ?? null };
}

const COHORT_LABEL = {
  kind: (v) => ({ top_signal: "top signals", launch: "launches", graduation: "graduations" }[v] || v),
  scoreBand: (v) => (v === "unscored" ? "unscored" : `score ${v}`),
};

/** Cohort the item belongs to, and its stats. Signals: score band. Launches / graduations: kind. */
export function hitRateFor(stats, item) {
  if (!stats || !stats.available || !stats.rows) return null;
  const [dim, value] = item.kind === "signal" ? ["scoreBand", scoreBand(item.score)] : ["kind", OUTCOME_KIND[item.kind]];
  const r = stats.rows.find((x) => x.dim === dim && x.value === value);
  if (!r) return null;
  const h = r.hit50 || { hits: 0, decided: 0, ratePct: null };
  return {
    dim, value, label: (COHORT_LABEL[dim] || String)(value), n: r.n,
    ratePct: h.ratePct, hits: h.hits, decided: h.decided,
    x2Pct: r.hit100?.ratePct ?? null, rugRatePct: r.rugRatePct ?? null, median1h: r.median?.["1h"] ?? null, median24h: r.median?.["24h"] ?? null,
    trusted: h.decided >= MIN_DECIDED && h.ratePct != null, windowDays: stats.windowDays, source: stats.source,
  };
}

/** The per-row "since signal" view from the table, for coins whose payload row has no signalPerf. worker: sinceSignal() */
export function sinceSignalFromRow(row) {
  if (!row) return null;
  const cps = {};
  for (const k of CHECKPOINT_KEYS) { const c = row.checkpoints?.[k]; if (c && !c.missed) cps[k] = c.returnPct; }
  const num = (v) => (v == null ? null : Number(v));
  return {
    kind: row.kind, firstSeenAt: row.first_seen_at, basis: row.entry_basis ?? null,
    entryMcapUsd: num(row.entry_mcap_usd), entryPriceUsd: num(row.entry_price_usd),
    returnPct: row.last_checked_at ? num(row.last_return_pct) : null, lastAt: row.last_checked_at ?? null,
    maxUpPct: num(row.max_up_pct), maxDrawdownPct: num(row.max_drawdown_pct), checkpoints: cps,
    rugged: !!row.rugged, liqCollapsed: !!row.liq_collapsed, status: row.status || "tracking",
  };
}

const ROW_COLS = "kind,chain_id,score,score_band,sources,badges,entry_basis,checkpoints,max_up_pct,max_drawdown_pct,hit_up50_at,hit_up100_at,hit_down50_at,rugged,liq_collapsed,status";

export function createOutcomes({ data, ttlMs = 5 * 60_000, now = () => Date.now(), log = console } = {}) {
  let cache = null;
  let lastState = null;
  async function getStats({ force = false } = {}) {
    // 1. the worker's aggregate in the cache payload (getSignalCache is itself cached ~20s)
    try {
      const c = await data.getSignalCache();
      if (c?.payload?.signalPerformance) return note(statsFrom(c.payload.signalPerformance, "payload"));
    } catch { /* fall through to the table */ }
    // 2. the table, aggregated here (cached for ttlMs)
    if (!force && cache && now() - cache.at < ttlMs) return cache.stats;
    const since = new Date(now() - WINDOW_MS).toISOString();
    const r = await data.getOutcomeRows(`select=${ROW_COLS}&first_seen_at=gte.${encodeURIComponent(since)}&limit=20000`);
    const stats = r.available ? statsFrom(aggregateRows(r.rows, { now: now() }), "table") : { available: false, reason: r.reason || "unavailable" };
    cache = { at: now(), stats };
    return note(stats);
  }
  function note(stats) {
    const state = stats.available ? `available (${stats.source})` : `unavailable (${stats.reason})`;
    if (state !== lastState) { log.log?.(`[outcomes] signal performance ${state}`); lastState = state; }
    return stats;
  }
  /** "since signal" for one coin from the table (used by /coin when the payload row has none). */
  async function sinceSignal(item) {
    const kind = OUTCOME_KIND[item.kind];
    if (!kind) return null;
    const addr = item.chain === "solana" ? item.address : String(item.address).toLowerCase();
    const r = await data.getOutcomeRows(`select=*&id=eq.${encodeURIComponent(`${kind}:${item.chain}:${addr}`)}&limit=1`);
    return r.available && r.rows[0] ? sinceSignalFromRow(r.rows[0]) : null;
  }
  return { getStats, sinceSignal };
}
