// Turns the worker's cached payload (auspex_signal_cache row "latest") into flat coin items.
// Lookups mirror the site (auspex-site index.html) exactly, so a coin resolves to the same
// RugCheck / creator / KOL / LunarCrush data in Telegram as on the web.

/** Same as the site's lookupByAddress: original case first, then lower case (older payloads). */
export function lookupByAddress(map, addr) {
  if (!map || !addr) return null;
  return map[addr] || map[String(addr).toLowerCase()] || null;
}

/** Same key the site uses for payload.signalCreatorFlags. */
export function creatorFlagKey(chain, address) {
  return chain + ":" + (chain === "solana" ? address : String(address).toLowerCase());
}

export function sameAddress(chain, a, b) {
  if (!a || !b) return false;
  return chain === "solana" ? a === b || a.toLowerCase() === b.toLowerCase() : a.toLowerCase() === b.toLowerCase();
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function signalItems(payload = {}) {
  const out = [];
  const groups = payload.chainGroups || {};
  const rugSafety = payload.rugSafety || {};
  const flags = payload.signalCreatorFlags || {};
  const kolBuys = payload.kolBuys || {};
  const lunar = payload.lunarSignals || {};
  for (const [chain, rows] of Object.entries(groups)) {
    (rows || []).forEach((r, idx) => {
      if (!r || !r.tokenAddress) return;
      const address = r.tokenAddress;
      out.push({
        kind: "signal",
        chain: r.chainId || chain,
        address,
        name: r.name || null,
        symbol: r.symbol || null,
        rank: idx + 1,
        score: num(r.score),
        sources: r.sources || (r.source ? [r.source] : []),
        providerCount: r.providerCount != null ? r.providerCount : (r.sources ? r.sources.length : 0),
        priceUsd: num(r.priceUsd),
        mcapUsd: num(r.marketCapUsd ?? r.mcapUsd),
        liquidityUsd: num(r.liquidityUsd),
        volume24h: num(r.volume24h),
        change24h: num(r.change24h),
        change1h: num(r.change1h),
        firstSeenAt: r.firstSeenAt || null,
        firstSeenMcapUsd: num(r.firstSeenMcapUsd),
        firstSeenPriceUsd: num(r.firstSeenPriceUsd),
        firstSeenScore: num(r.firstSeenScore),
        url: r.url || null,
        at: r.firstSeenAt || payload.generatedAt || null,
        rug: lookupByAddress(rugSafety, address),
        creatorFlag: flags[creatorFlagKey(r.chainId || chain, address)] || null,
        kol: lookupByAddress(kolBuys, address),
        lunar: r.symbol ? lunar[String(r.symbol).toUpperCase()] || null : null,
      });
    });
  }
  return out;
}

export function launchItems(payload = {}) {
  return (payload.justLaunched || []).filter((l) => l && l.mint).map((l) => ({
    kind: "launch",
    chain: "solana",
    address: l.mint,
    name: l.name || null,
    symbol: l.symbol || null,
    launchpad: l.launchpad || null,
    creator: l.creator || null,
    marketCapSol: num(l.marketCapSol),
    at: l.launchedAt || null,
    devReputation: l.devReputation || null,
    badActorMatches: l.badActorMatches || [],
    isBadActor: !!l.isBadActor,
    serialWinner: l.serialWinner || null,
    rugInsights: l.rugInsights || null,
    creatorWallet: l.creatorWallet || null,
    walletCheck: l.walletCheck || null,
    xHandle: l.xHandle || null,
    xAccountAge: l.xAccountAge || null,
    bundleCheck: l.bundleCheck || null,
    matchedMetas: l.matchedMetas || [],
  }));
}

export function graduationItems(payload = {}) {
  return (payload.justGraduated || []).filter((g) => g && g.mint).map((g) => ({
    kind: "graduation",
    chain: "solana",
    address: g.mint,
    name: g.name || null,
    symbol: g.symbol || null,
    launchpad: g.launchpad || null,
    venue: g.venue || null,
    pool: g.pool || null,
    creator: g.creator || null,
    at: g.graduatedAt || null,
    rug: g.rugSafety || null,
    devReputation: g.devReputation || null,
  }));
}

export function allItems(payload) {
  return [...signalItems(payload), ...launchItems(payload), ...graduationItems(payload)];
}

/** Every item (signal / launch / graduation) for one address, signal first. */
export function findCoin(payload, address, chain = null) {
  if (!payload || !address) return [];
  const order = { signal: 0, graduation: 1, launch: 2 };
  return allItems(payload)
    .filter((it) => (!chain || it.chain === chain) && sameAddress(it.chain, it.address, address))
    .sort((a, b) => order[a.kind] - order[b.kind]);
}

// ---- unified accessors (signal / launch / graduation carry the same facts in different places) ----

/** Bad-actor matches, strongest first (worker sorts them). */
export function badMatches(item) {
  if (item.kind === "signal") return item.creatorFlag?.bad || [];
  if (item.kind === "launch") return item.devReputation?.bad || item.badActorMatches || [];
  return item.devReputation?.bad || [];
}

export function goodDev(item) {
  if (item.kind === "signal") return item.creatorFlag?.good || null;
  return item.devReputation?.good || null;
}

export function rugInsights(item) {
  if (item.kind === "launch") return item.rugInsights || null;
  return item.rug?.insights || null;
}

/** RugCheck tier: safe | caution | danger | null (unknown / not checked / Base). */
export function rugTier(item) {
  const t = item.rug?.tier;
  return t === "safe" || t === "caution" || t === "danger" ? t : null;
}

export function liquidityUsd(item) {
  if (item.liquidityUsd != null) return item.liquidityUsd;
  const ins = rugInsights(item);
  return ins && ins.liquidityUsd != null ? num(ins.liquidityUsd) : null;
}

export function creatorOf(item) {
  return item.creator || item.creatorFlag?.creator || rugInsights(item)?.creator || null;
}

export function displayName(item) {
  return item.name || item.symbol || (item.address ? item.address.slice(0, 6) + "…" : "unknown");
}
