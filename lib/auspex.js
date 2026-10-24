// Process-wide Auspex data handles for the bot (one cache read shared by commands, alerts and crons).

import { config } from "../config.js";
import { createAuspexData } from "./auspexData.js";
import { createOutcomes } from "./outcomes.js";
import { signalItems, findCoin } from "./normalize.js";
import { formatUSD, formatPrice, formatChange, fetchTrendingBase } from "../gecko.js";

export const auspexData = createAuspexData({ url: config.AUSPEX_SUPABASE_URL, key: config.AUSPEX_SUPABASE_KEY });
export const outcomes = createOutcomes({ data: auspexData, ttlMs: Number(process.env.OUTCOMES_TTL_MS) || 10 * 60_000 });

export function explorerUrl(chain, address) {
  if (chain === "solana") return `https://solscan.io/token/${address}`;
  if (chain === "robinhood") return `https://robinhoodchain.blockscout.com/token/${address}`;
  if (chain === "ethereum") return `https://etherscan.io/token/${address}`;
  return `https://dexscreener.com/${chain}/${address}`;
}

/** Shape the old agents / formatter expect, built from an Auspex signal item. */
export function toLegacyToken(it) {
  const ch = it.change24h ?? 0;
  return {
    name: it.name || it.symbol || "Unknown",
    symbol: it.symbol || "???",
    address: it.address,
    chain: it.chain,
    explorerUrl: explorerUrl(it.chain, it.address),
    price: formatPrice(it.priceUsd ?? 0),
    priceRaw: it.priceUsd ?? 0,
    change: formatChange(ch),
    changeUp: ch >= 0,
    volume24h: formatUSD(it.volume24h),
    liquidity: formatUSD(it.liquidityUsd),
    holders: "N/A",
    marketCap: formatUSD(it.mcapUsd),
    fdv: formatUSD(it.mcapUsd),
    score: it.score,
    item: it,
  };
}

/** Top Auspex signals (Solana + Robinhood Chain, by score) — what the site's Signal Feed leads with. */
export async function topSignals(limit = 5, { chains = ["solana", "robinhood"] } = {}) {
  const { payload } = await auspexData.getSignalCache();
  return signalItems(payload)
    .filter((it) => chains.includes(it.chain))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
}

/** Token list for autopost / anomaly watcher / digest: Auspex cache by default, GeckoTerminal trending (GECKO_NETWORK, default robinhood) if configured. */
export async function fetchTrendingTokens(limit = 5) {
  if (config.AUTOPOST_SOURCE === "gecko") return fetchTrendingBase(limit);
  try {
    return (await topSignals(limit)).map(toLegacyToken);
  } catch (e) {
    console.error("Auspex cache unavailable, falling back to GeckoTerminal trending:", e.message);
    return fetchTrendingBase(limit);
  }
}

export async function lookupCoin(address) {
  const cache = await auspexData.getSignalCache();
  return { items: findCoin(cache.payload, address), updatedAt: cache.updatedAt, payload: cache.payload };
}
