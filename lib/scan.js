// CA scanner for addresses that are not on the Auspex board — the same lookups the site's
// "scan a CA" box makes from the browser: DexScreener tokens/v1 on Solana then Base, plus RugCheck
// for Solana. GoPlus (EVM) is a bot-only extra kept from the old /check.

import { fetchSafety } from "../safetyCheck.js";

export const SCAN_CHAINS = ["solana", "base"];
const SOL_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
const EVM_RE = /0x[a-fA-F0-9]{40}/;

/** First contract address in a message: EVM (0x…) or Solana base58. */
export function extractAddress(text) {
  if (!text) return null;
  const evm = String(text).match(EVM_RE);
  if (evm) return { address: evm[0], family: "evm" };
  const sol = String(text).match(SOL_RE);
  if (sol) return { address: sol[0], family: "solana" };
  return null;
}

async function getJson(fetchImpl, url, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

export function rugcheckTier(score) {
  return score <= 30 ? "safe" : score <= 60 ? "caution" : "danger"; // site + worker lib/rugcheck.js rugTier
}

/** DexScreener best pair for an address on one chain (most liquid), or null. */
export async function dexPair(chain, address, { fetchImpl = globalThis.fetch } = {}) {
  const pairs = await getJson(fetchImpl, `https://api.dexscreener.com/tokens/v1/${chain}/${encodeURIComponent(address)}`);
  if (!Array.isArray(pairs) || !pairs.length) return null;
  return pairs.slice().sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0))[0];
}

export async function scanAddress(address, { fetchImpl = globalThis.fetch, family = null } = {}) {
  const chains = family === "evm" ? ["base"] : family === "solana" ? ["solana"] : SCAN_CHAINS;
  for (const chain of chains) {
    const pair = await dexPair(chain, address, { fetchImpl });
    if (!pair) continue;
    const out = { chain, address, pair, rugcheck: null, goplus: null };
    if (chain === "solana") {
      const rc = await getJson(fetchImpl, `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(address)}/report`);
      if (rc && rc.score_normalised != null) {
        const tier = rugcheckTier(rc.score_normalised);
        const m = { safe: ["🟢", "SAFE"], caution: ["🟡", "CAUTION"], danger: ["🔴", "DANGER"] }[tier];
        out.rugcheck = { tier, emoji: m[0], label: m[1], score: rc.score_normalised, risks: (rc.risks || []).map((r) => r.name).filter(Boolean) };
      }
    } else {
      out.goplus = await fetchSafety(address).catch(() => null);
    }
    return out;
  }
  return null;
}

/** Chain-agnostic price snapshot for /call and call scoring (replaces the Base-only GeckoTerminal lookup). */
export async function tokenSnapshot(address, { fetchImpl = globalThis.fetch, chain = null } = {}) {
  const fam = extractAddress(address)?.family;
  const chains = chain ? [chain] : fam === "evm" ? ["base"] : ["solana"];
  for (const c of chains) {
    const p = await dexPair(c, address, { fetchImpl });
    if (!p) continue;
    const price = Number(p.priceUsd);
    return {
      chain: c, address, name: p.baseToken?.name || "Unknown", symbol: p.baseToken?.symbol || "???",
      priceRaw: Number.isFinite(price) ? price : 0, liquidityUsd: p.liquidity?.usd ?? null, volume24h: p.volume?.h24 ?? null,
      change24h: p.priceChange?.h24 ?? null, mcapUsd: p.marketCap ?? p.fdv ?? null, pairAddress: p.pairAddress || null, url: p.url || null,
    };
  }
  return null;
}
