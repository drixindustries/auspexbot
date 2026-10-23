// Read-only access to the same Supabase tables the site reads (auspex-site index.html):
//   auspex_signal_cache (row "latest"), auspex_paper_trades, auspex_hall_of_fame,
//   and — once the signal-performance PR lands — auspex_signal_outcomes.
// Uses plain PostgREST over fetch so it works with the site's public anon key and with a local PostgREST.

export function createAuspexData({ url, key, fetchImpl = globalThis.fetch, cacheTtlMs = 20_000, now = () => Date.now(), log = console } = {}) {
  if (!url) throw new Error("AUSPEX_SUPABASE_URL (or SUPABASE_URL) is required");
  const base = url.replace(/\/+$/, "") + "/rest/v1";
  const headers = key ? { apikey: key, Authorization: `Bearer ${key}` } : {};
  let cached = null; // { payload, updatedAt, fetchedAt }

  async function get(path, { timeoutMs = 10_000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/${path}`, { headers, signal: ctrl.signal });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { ok: res.ok, status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The worker's whole computed payload. Cached briefly so commands and the alert loop share one read. */
  async function getSignalCache({ force = false } = {}) {
    if (!force && cached && now() - cached.fetchedAt < cacheTtlMs) return cached;
    const r = await get("auspex_signal_cache?id=eq.latest&select=payload,updated_at");
    if (!r.ok) throw new Error(`auspex_signal_cache read failed: HTTP ${r.status}`);
    if (!Array.isArray(r.body) || !r.body.length) throw new Error("auspex_signal_cache has no 'latest' row — has the worker run yet?");
    cached = { payload: r.body[0].payload || {}, updatedAt: r.body[0].updated_at, fetchedAt: now() };
    return cached;
  }

  /** Same query and test-mode filtering as the site's Paper Trading panel. */
  async function getPaperTrades(limit = 30) {
    const r = await get(`auspex_paper_trades?select=*&order=entry_time.desc&limit=${Number(limit) || 30}`);
    if (!r.ok) throw new Error(`auspex_paper_trades read failed: HTTP ${r.status}`);
    const all = Array.isArray(r.body) ? r.body : [];
    const trades = all.filter((t) => !t.test_mode);
    const closed = trades.filter((t) => t.status === "closed");
    const withFinal = closed.filter((t) => t.final_pnl_pct != null);
    return {
      trades,
      testCount: all.length - trades.length,
      stats: {
        total: trades.length,
        graduated: trades.filter((t) => t.outcome === "graduated").length,
        completed: withFinal.length,
        wins: withFinal.filter((t) => t.final_pnl_pct > 0).length,
      },
    };
  }

  /** Same query as the site's Hall of Fame panel. */
  async function getHallOfFame(limit = 20) {
    const r = await get(`auspex_hall_of_fame?select=*&order=peak_mcap_usd.desc.nullslast&limit=${Number(limit) || 20}`);
    if (!r.ok) throw new Error(`auspex_hall_of_fame read failed: HTTP ${r.status}`);
    return Array.isArray(r.body) ? r.body : [];
  }

  /** Raw rows for the outcomes adapter; returns { available:false } when the table isn't there or readable. */
  async function getOutcomeRows(query) {
    try {
      const r = await get(`auspex_signal_outcomes?${query}`);
      if (!r.ok) return { available: false, status: r.status, reason: (r.body && (r.body.code || r.body.message)) || `HTTP ${r.status}` };
      return { available: true, rows: Array.isArray(r.body) ? r.body : [] };
    } catch (e) {
      return { available: false, reason: e.message };
    }
  }

  return { getSignalCache, getPaperTrades, getHallOfFame, getOutcomeRows, _get: get, log };
}
