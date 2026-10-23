// Synthetic coins layered on a real worker payload (test/fixtures/real-payload.json, captured from a local
// worker run against live DexScreener/GeckoTerminal/PumpPortal/RugCheck on 2026-10-23) so every badge,
// verdict and filter path is exercised. Addresses are fake but valid base58 / hex.
import fs from "node:fs";
import { outcomeRows } from "./outcomes.js";
import { aggregateRows } from "../../lib/outcomes.js";

export const ADDR = {
  provenSignal: "PRoVEN1sigNa1AAAAAAAAAAAAAAAAAAAAAAAAAAApump",
  ruggerSignal: "RuGGeR1sigNa1BBBBBBBBBBBBBBBBBBBBBBBBBBBpump",
  baseSignal: "0x1111111111111111111111111111111111111111",
  baseLowLiq: "0x2222222222222222222222222222222222222222",
  kolSignal: "KoL1sigNa1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCpump",
  heuristicLaunch: "HeuR1st1cLaunchDDDDDDDDDDDDDDDDDDDDDDDDpump",
  sanctionedLaunch: "SanCt1onedLaunchEEEEEEEEEEEEEEEEEEEEEEEpump",
  promisingLaunch: "Prom1s1ngLaunchFFFFFFFFFFFFFFFFFFFFFFFFFpump",
  staleLaunch: "StaLeLaunchGGGGGGGGGGGGGGGGGGGGGGGGGGGGGpump",
  safeGrad: "SafeGradHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHpump",
  ruggedGrad: "RuggedGradJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJpump",
};

const CREATOR = { proven: "ProvenDevWa11etKKKKKKKKKKKKKKKKKKKKKKKKKKKK", rugger: "RugDevWa11etMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM" };
const proven = { tier: "proven", confidence: 0.8, knownLaunches: 6, winners: [
  { mint: "W1nner1111111111111111111111111111111111pump", symbol: "WIN1", marketCapUsd: 2_400_000, type: "PRIOR_WINNER" },
  { mint: "W1nner2222222222222222222222222222222222pump", symbol: "WIN2", marketCapUsd: 310_000, type: "GRADUATED_HELD" },
] };
const promising = { tier: "promising", confidence: 0.5, knownLaunches: 3, winners: [{ mint: "W1nner3333333333333333333333333333333333pump", symbol: "WIN3", marketCapUsd: 150_000, type: "PRIOR_WINNER" }] };
const confirmedBad = { sourceId: "auspex", kind: "confirmed", label: "Auspex own rug-dev list", reason: "RUGCHECK_RUGGED on 1 mint", listedAt: "2026-10-20T00:00:00Z", confidence: 0.9 };
const heuristicBad = { sourceId: "allenhark", kind: "heuristic", label: "AllenHark blacklist (automated heuristic, unverified)", reason: "automated heuristic", listedAt: "2026-02-17T15:39:41.734Z" };
const sanctionedBad = { sourceId: "ofac-sol", kind: "sanctioned", label: "OFAC SDN (Solana)", reason: "OFAC SDN list", listedAt: "2025-01-01T00:00:00Z" };

export function realPayload() {
  return JSON.parse(fs.readFileSync(new URL("./real-payload.json", import.meta.url), "utf8"));
}

/** payload.signalPerformance as the worker writes it (same aggregate; see test/parity.worker.test.js). */
export function signalPerformance(nowMs = Date.now()) {
  return { ...aggregateRows(outcomeRows(nowMs), { now: nowMs }), windowDays: 7, tracking: 6, inMemory: 92 };
}

export function buildPayload(nowMs = Date.now(), base = realPayload(), { perf = false } = {}) {
  const p = structuredClone(base);
  const iso = (minAgo) => new Date(nowMs - minAgo * 60_000).toISOString();
  p.generatedAt = iso(0);
  const sig = (o) => ({ source: "DEX", sources: ["DEX", "GT"], providerCount: 2, change1h: 12, change24h: 150, volume24h: 800_000, firstSeenAt: iso(20), ...o });
  p.chainGroups.solana = [
    sig({ chainId: "solana", tokenAddress: ADDR.provenSignal, name: "Proven Pup", symbol: "PPUP", score: 92, liquidityUsd: 85_000, marketCapUsd: 900_000, firstSeenMcapUsd: 600_000, priceUsd: "0.0009" }),
    sig({ chainId: "solana", tokenAddress: ADDR.ruggerSignal, name: "Rugger Cat", symbol: "RCAT", score: 88, liquidityUsd: 60_000, marketCapUsd: 500_000, priceUsd: "0.0005" }),
    sig({ chainId: "solana", tokenAddress: ADDR.kolSignal, name: "Kol Frog", symbol: "KFROG", score: 75, liquidityUsd: 40_000, marketCapUsd: 300_000, sources: ["DEXPROFILE"], providerCount: 1 }),
    ...(p.chainGroups.solana || []),
  ];
  p.chainGroups.base = [
    sig({ chainId: "base", tokenAddress: ADDR.baseSignal, name: "Base Bull", symbol: "BBULL", score: 81, liquidityUsd: 120_000, marketCapUsd: 2_000_000 }),
    sig({ chainId: "base", tokenAddress: ADDR.baseLowLiq, name: "Thin Base", symbol: "THIN", score: 70, liquidityUsd: 3_000, marketCapUsd: 50_000 }),
    ...(p.chainGroups.base || []),
  ];
  p.rugSafety = {
    ...p.rugSafety,
    [ADDR.provenSignal]: { tier: "safe", riskScore: 12, risks: [], checkedAt: iso(3), insights: { rugged: false, creator: CREATOR.proven, insidersDetected: 0, insiderNetworks: 0, creatorTokens: { count: 6, lowCapCount: 3, lowCapThresholdUsd: 10_000, top: [] } } },
    [ADDR.ruggerSignal]: { tier: "caution", riskScore: 45, risks: ["Top 10 holders high ownership"], checkedAt: iso(4), insights: { rugged: false, creator: CREATOR.rugger, insidersDetected: 7, insiderNetworks: 2, insiderNetworkLargest: 5 } },
    [ADDR.kolSignal]: { tier: "safe", riskScore: 5, risks: [], checkedAt: iso(2), insights: null },
  };
  p.signalCreatorFlags = {
    ...p.signalCreatorFlags,
    [`solana:${ADDR.provenSignal}`]: { creator: CREATOR.proven, bad: [], good: proven },
    [`solana:${ADDR.ruggerSignal}`]: { creator: CREATOR.rugger, bad: [confirmedBad, heuristicBad], good: promising },
  };
  p.kolBuys = { ...p.kolBuys, [ADDR.kolSignal]: [{ kol: "Ansem", at: iso(5) }, { kol: "Cupsey", at: iso(6) }, { kol: "Orange", at: iso(7) }] };
  p.lunarSignals = { ...p.lunarSignals, KFROG: { galaxyScore: 71, sentiment: 83.4, altRank: 120, altRankPrevious: 300, altRankDelta: 180, hype: { spiking: true, verdict: "organic", zScore: 2.6, spamRatio: 0.1, top3CreatorShare: 0.2 } } };

  const launch = (o) => ({ name: null, symbol: null, launchpad: "pump.fun", creator: null, marketCapSol: 31, launchedAt: iso(2), creatorWallet: null, walletCheck: "disabled", serialWinner: null, isBadActor: false, badActorMatches: [], devReputation: { bad: [], good: null }, rugInsights: null, xHandle: null, xAccountAge: null, bundleCheck: null, matchedMetas: [], ...o });
  p.justLaunched = [
    launch({ mint: ADDR.heuristicLaunch, name: "Heuristic Hound", symbol: "HHND", creator: "HeurDevWa11etNNNNNNNNNNNNNNNNNNNNNNNNNNNNN", isBadActor: true, badActorMatches: [heuristicBad], devReputation: { bad: [heuristicBad], good: null } }),
    launch({ mint: ADDR.sanctionedLaunch, name: "Sanction Coin", symbol: "SANC", creator: "SancDevWa11etPPPPPPPPPPPPPPPPPPPPPPPPPPPPP", isBadActor: true, badActorMatches: [sanctionedBad], devReputation: { bad: [sanctionedBad], good: null } }),
    launch({ mint: ADDR.promisingLaunch, name: "Promising Panda", symbol: "PPAN", creator: CREATOR.proven, devReputation: { bad: [], good: promising }, serialWinner: promising.winners, creatorWallet: { ageLabel: "established", txCount: 100, cappedAt100: true }, bundleCheck: { riskLabel: "low", totalBuys: 12, uniqueBuyers: 11, windowSec: 20 }, matchedMetas: ["panda"] }),
    launch({ mint: ADDR.staleLaunch, name: "Stale Launch", symbol: "STALE", creator: CREATOR.proven, devReputation: { bad: [], good: proven }, launchedAt: iso(90) }),
    ...(p.justLaunched || []),
  ];
  p.justGraduated = [
    { mint: ADDR.safeGrad, name: "Safe Grad", symbol: "SGRAD", pool: "pump-amm", venue: "PumpSwap", launchpad: "pump.fun", creator: CREATOR.proven, graduatedAt: iso(4),
      rugSafety: { tier: "safe", riskScore: 8, risks: [], checkedAt: iso(3), insights: { rugged: false, creator: CREATOR.proven, insidersDetected: 2, insiderNetworks: 1, liquidityUsd: 32_000, creatorTokens: null } },
      devReputation: { bad: [], good: proven } },
    { mint: ADDR.ruggedGrad, name: "Rugged Grad", symbol: "RGRAD", pool: "pump-amm", venue: "PumpSwap", launchpad: "pump.fun", creator: CREATOR.rugger, graduatedAt: iso(6),
      rugSafety: { tier: "danger", riskScore: 88, risks: ["Large LP unlocked", "Creator history of rugged tokens"], checkedAt: iso(5), insights: { rugged: true, creator: CREATOR.rugger, insidersDetected: 0, liquidityUsd: 900 } },
      devReputation: { bad: [confirmedBad], good: null } },
    ...(p.justGraduated || []),
  ];
  // per-row "since signal" views (worker attachSignalPerf → sinceSignal)
  const perfOf = (o) => ({ kind: "top_signal", firstSeenAt: iso(35), basis: "price", entryMcapUsd: 600_000, entryPriceUsd: 0.0006, returnPct: 42, lastAt: iso(1), maxUpPct: 61.5, maxDrawdownPct: -8.2, checkpoints: { "5m": 4.1, "15m": 18.9 }, rugged: false, liqCollapsed: false, status: "tracking", ...o });
  p.chainGroups.solana[0].signalPerf = perfOf({});
  p.chainGroups.solana[1].signalPerf = perfOf({ returnPct: -63.2, maxUpPct: 12, maxDrawdownPct: -70, checkpoints: { "5m": -2, "15m": -30, "1h": -63.2 }, firstSeenAt: iso(130) });
  p.justLaunched[2].signalPerf = perfOf({ kind: "launch", basis: "mcap", returnPct: null, maxUpPct: null, maxDrawdownPct: null, checkpoints: {}, firstSeenAt: iso(2) });
  p.justGraduated[1].signalPerf = perfOf({ kind: "graduation", returnPct: -97, rugged: true, liqCollapsed: true, maxUpPct: 15, maxDrawdownPct: -97, firstSeenAt: iso(6), checkpoints: { "5m": -97 }, status: "done" });
  if (perf) p.signalPerformance = signalPerformance(nowMs);
  return p;
}
