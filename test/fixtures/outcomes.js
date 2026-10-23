// Deterministic auspex_signal_outcomes rows (final schema, auspex-worker feat/signal-performance) for tests and
// the E2E seed. Expected hit +50% rates: score 75-100 → 12/26 (46.2%), score 50-74 → 4/20 (20%),
// launches → 3/23 (13%), graduations → 9/15 (60%). Two rows without an entry price are excluded from stats.
const B58 = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789";
const addr = (tag, i) => { let s = tag + i; let k = i * 7 + tag.length; while (s.length < 40) s += B58[(k += 13) % B58.length]; return s + "pump"; };

export function outcomeRows(nowMs = Date.now()) {
  const rows = [];
  const iso = (msAgo) => new Date(nowMs - msAgo).toISOString();
  const H = 3_600_000;
  let n = 0;
  function row({ kind, score = null, badges = [], sources = [], outcome, chain = "solana", basis = "price", rugged = false, collapsed = false, ret1h = 10 }) {
    n += 1;
    const tokenAddress = chain === "solana" ? addr(kind.slice(0, 3), n) : "0x" + String(n).padStart(40, "0");
    const first = (n % 48) * H + 30 * 60_000; // spread over the last 2 days
    const st = outcome === "pending" ? "tracking" : "done";
    const up50 = outcome === "hit" || outcome === "x2" ? iso(first - 20 * 60_000) : null;
    const up100 = outcome === "x2" ? iso(first - 40 * 60_000) : null;
    const down = outcome === "miss" ? iso(first - 25 * 60_000) : outcome === "late_hit" ? iso(first - 10 * 60_000) : null;
    const cps = {
      "5m": { at: iso(first - 5 * 60_000), returnPct: ret1h / 4, late: false },
      "15m": { at: iso(first - 15 * 60_000), returnPct: ret1h / 2, late: false },
      "1h": { at: iso(first - H), returnPct: ret1h, late: false },
    };
    if (st === "done") cps["24h"] = { at: iso(first - 24 * H), returnPct: outcome === "miss" ? -70 : 80, late: false };
    const score_band = score == null ? "unscored" : score < 25 ? "0-24" : score < 50 ? "25-49" : score < 75 ? "50-74" : "75-100";
    rows.push({
      id: `${kind}:${chain}:${chain === "solana" ? tokenAddress : tokenAddress.toLowerCase()}`,
      kind, chain_id: chain, token_address: tokenAddress, name: `${kind} ${n}`, symbol: `T${n}`, first_seen_at: iso(first),
      sources, score, score_band, badges, late_badges: [], flags: {}, creator: null,
      entry_basis: basis, entry_price_usd: basis ? 0.001 : null, entry_mcap_usd: basis ? 100_000 : null, entry_liquidity_usd: basis ? 20_000 : null,
      entry_source: basis ? "signal" : "first_lookup", entry_delay_ms: 0, checkpoints: basis ? cps : {},
      ret_5m: basis ? ret1h / 4 : null, ret_15m: basis ? ret1h / 2 : null, ret_1h: basis ? ret1h : null, ret_6h: null, ret_24h: st === "done" && basis ? (outcome === "miss" ? -70 : 80) : null,
      max_up_pct: basis ? (outcome === "x2" ? 140 : outcome === "hit" ? 60 : 20) : null, max_drawdown_pct: basis ? (outcome === "miss" ? -75 : -10) : null,
      hit_up50_at: up50, hit_up100_at: up100, hit_down50_at: down,
      peak_liquidity_usd: 30_000, peak_pool_id: null, last_price_usd: 0.0012, last_mcap_usd: 120_000, last_liquidity_usd: 25_000,
      last_return_pct: 20, last_checked_at: iso(first - 2 * H), rugged, liq_collapsed: collapsed, collapsed_at: collapsed ? iso(first - H) : null,
      misses: 0, observations: 12, status: st, next_check_at: st === "tracking" ? iso(-5 * 60_000) : null, updated_at: iso(60_000),
    });
  }
  const top = ["DEX", "GT"];
  for (let i = 0; i < 30; i++) row({ kind: "top_signal", score: 80 + (i % 20), sources: top, badges: i % 3 === 0 ? ["dev_proven", "multi_source", "rc_safe"] : ["rc_safe"], outcome: i < 5 ? "x2" : i < 12 ? "hit" : i < 26 ? "miss" : "pending", ret1h: i < 12 ? 35 : -20 });
  for (let i = 0; i < 20; i++) row({ kind: "top_signal", score: 55 + (i % 15), sources: ["DEXPROFILE"], badges: i % 2 ? ["bad_heuristic"] : [], outcome: i < 4 ? "hit" : "miss", ret1h: -15 });
  for (let i = 0; i < 25; i++) row({ kind: "launch", sources: ["LAUNCH:pump.fun"], badges: i % 5 === 0 ? ["bundle_high"] : [], outcome: i < 3 ? "hit" : i < 23 ? "miss" : "pending", basis: "mcap", rugged: i % 4 === 0, ret1h: -40 });
  for (let i = 0; i < 15; i++) row({ kind: "graduation", sources: ["GRAD:PumpSwap"], badges: ["dev_promising"], outcome: i < 9 ? "hit" : "miss", collapsed: i === 14, ret1h: 25 });
  for (let i = 0; i < 2; i++) row({ kind: "top_signal", score: 90, sources: top, outcome: "pending", basis: null });
  return rows;
}
