const GECKO = "https://api.geckoterminal.com/api/v2";
const HEADERS = { Accept: "application/json;version=20230302" };

export async function fetchTokenData(address) {
  const [tokenRes, poolsRes] = await Promise.all([
    fetch(`${GECKO}/networks/base/tokens/${address}`, { headers: HEADERS }),
    fetch(`${GECKO}/networks/base/tokens/${address}/pools?page=1`, { headers: HEADERS }),
  ]);

  if (!tokenRes.ok) throw new Error("Token not found on Base");

  const tokenJson = await tokenRes.json();
  const d = tokenJson?.data?.attributes;
  if (!d) throw new Error("Token not found");

  let volume24h = "N/A", liquidity = "N/A", priceChange24h = 0;

  if (poolsRes.ok) {
    const poolsJson = await poolsRes.json();
    const p = poolsJson?.data?.[0]?.attributes;
    if (p) {
      volume24h    = formatUSD(p.volume_usd?.h24);
      liquidity    = formatUSD(p.reserve_in_usd);
      priceChange24h = parseFloat(p.price_change_percentage?.h24 ?? 0);
    }
  }

  const price  = parseFloat(d.price_usd ?? 0);
  const change = isNaN(priceChange24h) ? 0 : priceChange24h;

  return {
    name:      d.name || "Unknown",
    symbol:    d.symbol || "???",
    address,
    price:     formatPrice(price),
    priceRaw:  price,              // raw float for scoring comparisons
    change:    formatChange(change),
    changeUp:  change >= 0,
    volume24h,
    liquidity,
    holders:   d.holders ? Number(d.holders).toLocaleString() : "N/A",
    marketCap: formatUSD(d.market_cap_usd),
    fdv:       formatUSD(d.fdv_usd),
  };
}

/**
 * Fetch top pool address for a Base token.
 * Used by chart renderer to get OHLCV data.
 */
export async function fetchTopPoolAddress(tokenAddress) {
  const res = await fetch(
    `${GECKO}/networks/base/tokens/${tokenAddress}/pools?page=1`,
    { headers: HEADERS }
  );
  if (!res.ok) return null;
  const json = await res.json();
  const pool = json?.data?.[0];
  return pool?.attributes?.address || null;
}

/**
 * Fetch top trending tokens on Base from GeckoTerminal.
 * Returns array of token objects.
 */
export async function fetchTrendingBase(limit = 5) {
  const res = await fetch(
    `${GECKO}/networks/base/trending_pools?page=1`,
    { headers: HEADERS }
  );

  if (!res.ok) throw new Error("Failed to fetch trending tokens");

  const json = await res.json();
  const pools = json?.data?.slice(0, limit) || [];

  const tokens = [];
  for (const pool of pools) {
    const p    = pool.attributes;
    const addr = pool.relationships?.base_token?.data?.id?.split("_")[1];
    if (!addr) continue;

    tokens.push({
      name:      p.name?.split(" / ")[0] || "Unknown",
      symbol:    p.base_token_price_usd ? p.name?.split(" / ")[0] : "???",
      address:   addr,
      price:     formatPrice(parseFloat(p.base_token_price_usd ?? 0)),
      change:    formatChange(parseFloat(p.price_change_percentage?.h24 ?? 0)),
      changeUp:  parseFloat(p.price_change_percentage?.h24 ?? 0) >= 0,
      volume24h: formatUSD(p.volume_usd?.h24),
      liquidity: formatUSD(p.reserve_in_usd),
      fdv:       formatUSD(p.fdv_usd),
      holders:   "N/A",
      marketCap: formatUSD(p.market_cap_usd),
    });
  }

  return tokens;
}

// ── Formatters ─────────────────────────────────────────────────────────────

export function formatUSD(val) {
  const n = parseFloat(val);
  if (!val || isNaN(n)) return "N/A";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function formatPrice(n) {
  if (!n || isNaN(n)) return "$0.00";
  if (n < 0.000001)   return `$${n.toExponential(2)}`;
  if (n < 0.01)       return `$${n.toFixed(6)}`;
  if (n < 1)          return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatChange(n) {
  if (isNaN(n)) return "0.00%";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function calcRugScore({ liquidity, holders, volume24h, fdv }) {
  let score = 0;
  const liq = parseRaw(liquidity);
  if      (liq < 10_000)  score += 40;
  else if (liq < 50_000)  score += 25;
  else if (liq < 100_000) score += 10;
  const h = parseRawInt(holders);
  if      (h < 100)  score += 25;
  else if (h < 500)  score += 15;
  else if (h < 1000) score += 5;
  const vol    = parseRaw(volume24h);
  const fdvRaw = parseRaw(fdv);
  if (fdvRaw > 0 && vol / fdvRaw < 0.005) score += 15;
  return Math.min(score, 100);
}

function parseRaw(val) {
  if (!val || val === "N/A") return 0;
  const s = String(val).replace(/[$,KMB]/g, "");
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  if (String(val).includes("M")) return n * 1_000_000;
  if (String(val).includes("K")) return n * 1_000;
  return n;
}

function parseRawInt(val) {
  if (!val || val === "N/A") return 0;
  return parseInt(String(val).replace(/,/g, ""), 10) || 0;
}
