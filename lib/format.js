// MarkdownV2 renderers for Auspex items: alerts, /coin cards, /feed, /launches, /grads, /paper, /hof.
// Badge text comes from lib/badges.js (site parity); this file only lays it out for Telegram.

import { esc, code, link } from "./md.js";
import { badgesFor, creatorVerdict, VERDICT_HEADER, BAD_KIND_EXPLAIN } from "./badges.js";
import { badMatches, creatorOf, displayName, rugInsights, liquidityUsd, signalItems } from "./normalize.js";

export const DEFAULT_SITE_URL = "https://auspex-site.vercel.app";

export function siteCoinUrl(siteUrl, item) {
  const base = String(siteUrl || DEFAULT_SITE_URL).replace(/\/+$/, "");
  return `${base}/?chain=${encodeURIComponent(item.chain)}&ca=${encodeURIComponent(item.address)}`;
}

export function dexUrl(item) {
  return `https://dexscreener.com/${item.chain}/${item.address}`;
}

export function compactUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return "?";
  const v = Number(n);
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${v.toFixed(2)}`;
  if (a === 0) return "$0";
  return `$${v.toPrecision(3)}`;
}

export function pct(n, digits = 1) {
  if (n == null || !Number.isFinite(Number(n))) return "?";
  const v = Number(n);
  return (v >= 0 ? "+" : "") + v.toFixed(digits) + "%";
}

export function ago(iso, now = Date.now()) {
  if (!iso) return null;
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return Math.round(ms / 60_000) + "m ago";
  if (ms < 48 * 3_600_000) return Math.round(ms / 3_600_000) + "h ago";
  return Math.round(ms / 86_400_000) + "d ago";
}

function shortAddr(a) {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "";
}

/** One MarkdownV2 line of badges. Muted good-dev (wallet also on a bad list) is struck through like the site. */
export function badgeLine(badges) {
  if (!badges.length) return null;
  return badges.map((x) => (x.muted ? `~${esc(x.text)}~` : esc(x.text))).join("  ");
}

const KIND_HEADER = {
  signal: (it) => `📡 SIGNAL #${it.rank ?? "?"} · ${String(it.chain).toUpperCase()} · score ${it.score ?? "?"}`,
  launch: (it) => `🚀 NEW LAUNCH · ${String(it.chain).toUpperCase()}${it.launchpad ? " · " + it.launchpad : ""}`,
  graduation: (it) => `🎓 GRADUATED · ${String(it.chain).toUpperCase()}${it.venue ? " → " + it.venue : ""}`,
  early: (it) => `${it.arm === "final_stretch" ? "🏁 FINAL STRETCH" : it.fired ? "⚡ EARLY SIGNAL" : "🛰 ON THE CURVE"} · SOLANA${it.launchpad ? " · " + it.launchpad : ""} · early score ${it.earlyScore ?? "?"}`,
  momentum: (it) => `🔥 POST-GRAD MOMENTUM · SOLANA${it.dexId ? " · " + it.dexId : ""} · ${compactUsd(it.mcapUsd)}`,
};

const fx = (v, d = 1) => (v == null || !Number.isFinite(Number(v)) ? "·" : Number(v).toFixed(d));
function secs(s) {
  if (s == null || !Number.isFinite(Number(s))) return "·";
  s = Math.round(s);
  return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m" + (s % 60 ? (s % 60) + "s" : "") : (s / 3600).toFixed(1) + "h";
}

/** The curve card's numbers (same fields as the site's early card), as alert lines. */
export function earlyDetailLines(item) {
  const f = item.f || {};
  const prog = f.progress != null ? Math.round(f.progress * 100) + "%" : "?";
  const out = [];
  out.push("💰 " + esc(`MCap ${compactUsd(f.mcapUsd)} · curve ${prog}${f.standardCurve === false ? " (custom curve, completes ~" + compactUsd(f.gradMcapUsd) + ")" : ""} · age ${secs(f.ageSec)}`));
  out.push("📈 " + esc(`${fx(f.buyersPerMin, 0)} buyers/min · net ${fx(f.netSolPerMin, 1)} SOL/min · ${f.uniqueBuyers ?? "?"} buyers · buy ratio ${fx(f.buyRatioRecent, 2)}`));
  out.push("👥 " + esc(`First 10 holding ${f.first10Holding ?? "?"}/${f.first10Count ?? 0} · bundle ${fx(f.bundleLaunchPct)}% → ${fx(f.bundleNowPct)}% · snipers ${fx(f.sniperPct, 0)}% · top10 ${fx(f.top10Pct, 0)}% · dev ${fx(f.devPct)}%${f.devSold ? " (SOLD)" : ""}`));
  if (f.fundingChecked > 0) {
    out.push("🏦 " + esc(`Funding (first ${f.fundingChecked}): ${f.freshBuyers} fresh · ${f.dormantBuyers} dormant · ${f.cexFundedBuyers} CEX-funded · ${f.uniqueFunders ?? "?"} unique funders` + (f.sharedFunderMax >= 2 ? ` · ${f.sharedFunderMax} share one funder` : "") + (f.freshCluster5m ? ` · fresh cluster ${f.freshCluster5m} in 5m` : "")));
  }
  if (f.deployerAgeMin != null || f.deployerDrainedPct != null) {
    out.push("🧑‍💻 " + esc(`Deployer: wallet ${f.deployerAgeMin != null ? secs(f.deployerAgeMin * 60) : "?"} old` + (f.deployerCexFunded ? " · CEX-funded" : "") + (f.deployerFresh ? " · first launch" : "") + (f.deployerDrainedPct != null ? ` · ${fx(f.deployerDrainedPct, 0)}% of prior launches drained` : "") + (f.deployerBalanceSol != null ? ` · ${fx(f.deployerBalanceSol, 2)} SOL` : "")));
  }
  out.push("🌊 " + esc(`Flow: ${fx(f.tradersPerSol, 1)} traders/SOL · size CV ${fx(f.tradeSizeCv, 2)} · vol/mcap 1m ${fx(f.volMcapPct1m, 1)}% · ${fx(f.avgSecBetweenSwaps, 1)}s between swaps` + (f.timeTo10kSec != null ? ` · $10k in ${secs(f.timeTo10kSec)}` : "")));
  if (item.hardNegatives?.length) out.push("⛔ " + esc("Hard negative: " + item.hardNegatives.join(", ")));
  return out;
}

// ── signal performance (worker lib/signal-outcomes.js; site perfChipHTML / perf panel) ──
/** site: fmtPct */
export function perfPct(v, digits) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const d = digits == null ? (Math.abs(v) >= 100 ? 0 : 1) : digits;
  return (v >= 0 ? "+" : "") + Number(v).toFixed(d) + "%";
}
/** site: fmtAgo */
export function perfAgo(iso, now = Date.now()) {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 3_600_000) return Math.max(1, Math.round(ms / 60000)) + "m";
  if (ms < 86_400_000) return Math.round(ms / 3_600_000) + "h";
  return Math.round(ms / 86_400_000) + "d";
}
/** The site's "since signal" chip text, exactly (e.g. "+42.0% since signal · 35m", "☠ -91% since signal · 3h", "⏱ pricing…"). */
export function perfChipText(p, now = Date.now()) {
  if (!p) return null;
  if (p.returnPct == null) return "⏱ " + (p.basis ? "pricing…" : "awaiting first price…");
  const age = perfAgo(p.firstSeenAt, now);
  return ((p.rugged || p.liqCollapsed) ? "☠ " : "") + perfPct(p.returnPct) + " since signal" + (age ? " · " + age : "");
}
/** "Since signal" lines for an alert / coin card from the row's signalPerf. */
export function sinceSignalLines(p, { now = Date.now() } = {}) {
  if (!p) return [];
  const chip = perfChipText(p, now);
  const icon = p.returnPct == null ? "" : (p.rugged || p.liqCollapsed) ? "" : p.returnPct >= 0 ? "📈 " : "📉 ";
  const head = icon + chip + (p.basis ? ` (on ${p.basis}${p.entryMcapUsd ? ", entry mcap " + compactUsd(p.entryMcapUsd) : ""})` : "");
  const lines = [esc(head)];
  const cps = p.checkpoints || {};
  const parts = CHECKPOINTS.filter((k) => cps[k] != null).map((k) => `${k} ${perfPct(cps[k])}`);
  if (p.maxUpPct != null) parts.push(`max ↑ ${perfPct(p.maxUpPct)} / ↓ ${perfPct(p.maxDrawdownPct)}`);
  if (parts.length) lines.push("    " + esc(parts.join(" · ")));
  if (p.rugged) lines.push("    " + esc("☠ RugCheck marked this token rugged."));
  if (p.liqCollapsed) lines.push("    " + esc("☠ Pool liquidity collapsed (≥90% off its peak)."));
  if (p.status && p.status !== "tracking") lines.push("    " + esc(`Tracking finished (${p.status}).`));
  return lines;
}
const CHECKPOINTS = ["5m", "15m", "1h", "6h", "24h"];
/** "Similar signals" line from lib/outcomes.js hitRateFor(). */
export function hitRateLine(h) {
  const rate = h.ratePct == null ? "no resolved signals yet" : `${Math.round(h.ratePct)}% hit +50% (${h.hits}/${h.decided} resolved)`;
  const extra = [];
  if (h.x2Pct != null) extra.push(`2× ${Math.round(h.x2Pct)}%`);
  if (h.rugRatePct != null) extra.push(`rug ${Math.round(h.rugRatePct)}%`);
  if (h.median1h != null) extra.push(`median 1h ${perfPct(h.median1h)}`);
  return "📊 " + esc(`Similar signals (${h.label}, last ${h.windowDays ?? 7}d): ${rate}${extra.length ? " · " + extra.join(" · ") : ""} · n=${h.n}${h.trusted ? "" : " (small sample)"}`);
}

/** Detail lines ("caveats" on the site) for an item. */
export function detailLines(item, { now = Date.now(), hitRate = null } = {}) {
  const lines = [];
  if (item.kind === "signal") {
    const parts = [`MCap ${compactUsd(item.mcapUsd)}`, `Liq ${compactUsd(item.liquidityUsd)}`, `Vol ${compactUsd(item.volume24h)}`];
    if (item.change24h != null) parts.push(`24h ${pct(item.change24h)}`);
    if (item.change1h != null) parts.push(`1h ${pct(item.change1h)}`);
    lines.push("💰 " + esc(parts.join(" · ")));
    if (item.sources?.length) lines.push("🛰 " + esc("Sources: " + item.sources.join(", ")));
    if (item.firstSeenAt) {
      let change = "change not computable yet";
      if (item.firstSeenMcapUsd && item.mcapUsd) change = pct(((item.mcapUsd - item.firstSeenMcapUsd) / item.firstSeenMcapUsd) * 100) + " since (mcap)";
      else if (item.firstSeenPriceUsd && item.priceUsd) change = pct(((item.priceUsd - item.firstSeenPriceUsd) / item.firstSeenPriceUsd) * 100) + " since (price)";
      const entry = item.firstSeenMcapUsd ? compactUsd(item.firstSeenMcapUsd) + " mcap" : item.firstSeenPriceUsd ? "$" + Number(item.firstSeenPriceUsd).toPrecision(3) + " price" : "entry value unavailable";
      lines.push("📍 " + esc(`First flagged ${ago(item.firstSeenAt, now)} at ${entry} — ${change}`));
    }
  } else if (item.kind === "launch") {
    const parts = [];
    if (item.marketCapSol != null) parts.push(`${Number(item.marketCapSol).toFixed(1)} SOL mcap`);
    if (item.at) parts.push(`launched ${ago(item.at, now)}`);
    if (parts.length) lines.push("💰 " + esc(parts.join(" · ")));
  } else if (item.kind === "momentum") {
    const parts = [`MCap ${compactUsd(item.mcapUsd)} (fresh AMM quote${item.quoteStale && item.boardMcapUsd ? "; board showed " + compactUsd(item.boardMcapUsd) : ""})`, `Liq ${compactUsd(item.liquidityUsd)}`];
    if (item.poolAgeMin != null) parts.push(`pool ${item.poolAgeMin < 1 ? Math.round(item.poolAgeMin * 60) + "s" : Number(item.poolAgeMin).toFixed(1) + "m"} old`);
    lines.push("💰 " + esc(parts.join(" · ")));
    const flow = [];
    if (item.buys5m != null || item.sells5m != null) flow.push(`5m ${item.buys5m ?? "?"} buys / ${item.sells5m ?? "?"} sells`);
    if (item.change5m != null) flow.push(`5m ${pct(item.change5m)}`);
    if (flow.length) lines.push("📈 " + esc(flow.join(" · ")));
    if (item.sources?.length) lines.push("🛰 " + esc("Listed via: " + item.sources.join(", ")));
    lines.push("🎯 " + esc("Just migrated + listed. Paper plan: sell 25% at 3x, 15% each at 6x/10x/20x, trail the rest 40%. New arm, small sample."));
  } else if (item.kind === "early") {
    lines.push(...earlyDetailLines(item));
  } else if (item.kind === "graduation") {
    const liq = liquidityUsd(item);
    const parts = [];
    if (item.at) parts.push(`graduated ${ago(item.at, now)}`);
    if (liq != null) parts.push(`liq ${compactUsd(liq)}`);
    if (parts.length) lines.push("💰 " + esc(parts.join(" · ")));
  }
  if (item.rug && item.rug.riskScore != null) {
    lines.push("🛡 " + esc(`RugCheck ${item.rug.riskScore}/100` + (item.rug.risks?.length ? " — " + item.rug.risks.join(", ") : "") +
      (item.rug.checkedAt ? ` (checked ${ago(item.rug.checkedAt, now)})` : "")));
  }
  const bad = badMatches(item);
  const creator = creatorOf(item);
  if (bad.length) {
    lines.push("🚨 " + esc(`Creator ${shortAddr(creator)} matched: ` + bad.map((m) => m.label + (m.reason && !String(m.label).toLowerCase().includes(String(m.reason).toLowerCase()) ? ` (${m.reason})` : "")).join("; ")));
    lines.push("    " + esc(BAD_KIND_EXPLAIN[bad[0].kind] || "A match is a warning signal, not proof."));
  }
  const ins = rugInsights(item);
  if (ins?.creatorTokens?.count >= 3 && ins.creatorTokens.lowCapCount != null) {
    lines.push("🔁 " + esc(`Creator has ${ins.creatorTokens.count} other tokens; ${ins.creatorTokens.lowCapCount} now under ${compactUsd(ins.creatorTokens.lowCapThresholdUsd)} mcap. Not proof of a rug.`));
  }
  const good = item.kind === "signal" || item.kind === "momentum" ? item.creatorFlag?.good : item.kind === "early" ? null : item.devReputation?.good;
  if (good?.winners?.length) {
    lines.push("🏆 " + esc("Prior winners: " + good.winners.slice(0, 3).map((w) => (w.symbol || w.name || shortAddr(w.mint)) + (w.marketCapUsd ? ` (${compactUsd(w.marketCapUsd)})` : "")).join(", ") + (bad.length ? " — creator also on a bad list; bad flag takes priority" : "")));
  }
  if (item.kol?.length) lines.push("🎯 " + esc("Recent KOL buy seen — not a confirmed current holding."));
  lines.push(...sinceSignalLines(item.signalPerf, { now }));
  if (hitRate) lines.push(hitRateLine(hitRate));
  return lines;
}

/** The Telegram alert for one item — same badges as the site, plus a link to the coin on the site. */
export function formatAlert(item, { siteUrl, now = Date.now(), hitRate = null, notes = [] } = {}) {
  const verdict = creatorVerdict(item);
  const vh = verdict ? VERDICT_HEADER[verdict] : null;
  const header = KIND_HEADER[item.kind](item) + (vh ? `  ${vh.emoji} ${vh.label}` : "");
  const lines = [
    `*${esc(header)}*`,
    `*${esc(displayName(item))}*` + (item.symbol ? ` \\(${esc("$" + item.symbol)}\\)` : ""),
    code(item.address),
  ];
  const bl = badgeLine(badgesFor(item));
  if (bl) lines.push(bl);
  lines.push(...detailLines(item, { now, hitRate }));
  for (const n of notes) lines.push("ℹ️ " + esc(n));
  lines.push("", `${link("View on Auspex", siteCoinUrl(siteUrl, item))} · ${link("DexScreener", dexUrl(item))}`);
  lines.push("_" + esc("Signals, not advice. A badge is a warning or a lean, never proof.") + "_");
  return lines.join("\n");
}

export function alertKeyboard(item, siteUrl) {
  return {
    inline_keyboard: [[
      { text: "🔎 View on Auspex", url: siteCoinUrl(siteUrl, item) },
      { text: "📊 DexScreener", url: dexUrl(item) },
    ]],
  };
}

/** /coin card: every item the cache has for this address (signal, graduation, launch). */
export function formatCoinCard(items, { siteUrl, now = Date.now(), updatedAt = null, hitRate = null } = {}) {
  const main = items[0];
  const lines = [formatAlert(main, { siteUrl, now, hitRate }).split("\n").slice(0, -3).join("\n")];
  for (const extra of items.slice(1)) {
    lines.push("", `*${esc(KIND_HEADER[extra.kind](extra))}*`);
    const bl = badgeLine(badgesFor(extra));
    if (bl) lines.push(bl);
    lines.push(...detailLines(extra, { now }).slice(0, 2));
  }
  lines.push("", `${link("View on Auspex", siteCoinUrl(siteUrl, main))} · ${link("DexScreener", dexUrl(main))}`);
  if (updatedAt) lines.push("_" + esc(`Auspex cache updated ${ago(updatedAt, now)}`) + "_");
  return lines.join("\n");
}

/** Fallback /coin card for an address that's not on the Auspex board (site's CA scanner equivalent). */
export function formatScanCard(scan, { siteUrl } = {}) {
  const p = scan.pair;
  const item = { chain: scan.chain, address: scan.address };
  const lines = [
    `*${esc("🔍 CA SCAN · " + scan.chain.toUpperCase())}*  ${esc("(not on the Auspex board right now)")}`,
    `*${esc(p?.baseToken?.name || "unknown")}*` + (p?.baseToken?.symbol ? ` \\(${esc("$" + p.baseToken.symbol)}\\)` : ""),
    code(scan.address),
    "💰 " + esc([`Price ${p?.priceUsd ? "$" + Number(p.priceUsd).toPrecision(4) : "?"}`, `Liq ${compactUsd(p?.liquidity?.usd)}`, `Vol ${compactUsd(p?.volume?.h24)}`, `24h ${pct(p?.priceChange?.h24)}`].join(" · ")),
  ];
  if (scan.rugcheck) {
    const t = scan.rugcheck;
    lines.push(esc(`${t.emoji} RugCheck: ${t.label} (${t.score}/100)`) + (t.risks.length ? "\n" + esc("Flags: " + t.risks.join(", ")) : ""));
  }
  if (scan.goplus) {
    const g = scan.goplus;
    lines.push(esc(`${g.verdictEmoji} GoPlus: ${g.verdict} ${g.score}/10 · buy tax ${g.buyTax}% · sell tax ${g.sellTax}%${g.isHoneypot ? " · HONEYPOT" : ""}`));
  }
  lines.push("", `${link("View on Auspex", siteCoinUrl(siteUrl, item))} · ${link("DexScreener", p?.url || dexUrl(item))}`);
  return lines.join("\n");
}

export function formatFeed(payload, { chain = null, limit = 5, updatedAt = null, now = Date.now(), items = signalItems(payload) } = {}) {
  const groups = {};
  for (const it of items) if (!chain || it.chain === chain) (groups[it.chain] = groups[it.chain] || []).push(it);
  const order = Object.keys(groups).sort((a, b) => (groups[b][0]?.score ?? 0) - (groups[a][0]?.score ?? 0));
  const lines = ["*" + esc("👁 AUSPEX — SIGNAL FEED") + "*"];
  const g = [];
  const r = payload.marketRegime;
  if (r) g.push(`${r.regime === "risk-on" ? "🟢" : r.regime === "risk-off" ? "🔴" : "⚪"} SOL ${pct(r.solChange24h, 0)} — ${String(r.regime).toUpperCase()}`);
  for (const m of payload.activeMetas || []) g.push(`🔥 META: "${m.keyword}" ×${m.distinctCreators ?? m.count}`);
  if (g.length) lines.push(esc(g.join("  ")));
  if (payload.failedSources?.length) lines.push(esc("⚠ Worker couldn't reach: " + payload.failedSources.join(", ")));
  for (const c of order) {
    const rows = groups[c];
    lines.push("", `*${esc(c.toUpperCase() + " · " + rows.length + " signal" + (rows.length === 1 ? "" : "s"))}*`);
    for (const it of rows.slice(0, limit)) {
      const bl = badgeLine(badgesFor(it));
      lines.push(`${esc(it.rank + ".")} *${esc(displayName(it))}*` + (it.symbol ? " " + esc("$" + it.symbol) : "") + ` · ${esc("score " + (it.score ?? "?"))} · ${esc(pct(it.change24h))}` + (it.signalPerf ? " · " + esc(perfChipText(it.signalPerf, now)) : ""));
      lines.push("    " + code(it.address) + (bl ? "\n    " + bl : ""));
    }
  }
  if (!order.length) lines.push("", esc("No signals in the cache yet."));
  if (updatedAt) lines.push("", "_" + esc(`Cache updated ${ago(updatedAt, now)} · /coin <CA> for full badges`) + "_");
  return lines.join("\n");
}

export function formatItemList(title, items, { limit = 10, now = Date.now(), empty = "Nothing yet." } = {}) {
  const lines = [`*${esc(title)}*`];
  if (!items.length) lines.push(esc(empty));
  items.slice(0, limit).forEach((it, i) => {
    const bl = badgeLine(badgesFor(it));
    lines.push("", `${esc(i + 1 + ".")} *${esc(displayName(it))}*` + (it.symbol ? " " + esc("$" + it.symbol) : "") + (it.at ? " · " + esc(ago(it.at, now)) : "") + (it.signalPerf ? " · " + esc(perfChipText(it.signalPerf, now)) : ""));
    lines.push("    " + code(it.address) + (bl ? "\n    " + bl : ""));
  });
  return lines.join("\n");
}

export function formatPaper({ trades, stats, testCount }, { limit = 10 } = {}) {
  const lines = ["*" + esc("📒 AUSPEX — PAPER TRADING") + "*"];
  const s = [`${stats.total} tracked (last 30)`, `${stats.graduated} graduated`, `${stats.completed} completed full cycle`];
  if (stats.completed) s.push(`${stats.wins}/${stats.completed} positive at 24h`);
  if (testCount) s.push(`${testCount} test-mode rows hidden`);
  lines.push(esc(s.join(" · ")));
  if (!trades.length) lines.push("", esc("No paper trades yet."));
  trades.slice(0, limit).forEach((t, i) => {
    const outcome = t.outcome === "graduated" ? "🎓 graduated" : t.outcome === "no_graduation_timeout" ? "✗ never graduated" : "watching…";
    let pnl = "";
    if (t.final_pnl_pct != null) pnl = `${pct(t.final_pnl_pct)} @24h`;
    else {
      const cp = (t.snapshots || []).filter((x) => x.type === "checkpoint").slice(-1)[0];
      if (cp) pnl = `${pct(cp.pnlPctFromGraduation)} @${cp.atMinutes}min`;
    }
    const prec = t.entry_features?.precedent ? ` · 🔍 ${t.entry_features.precedent.winRate}% win rate (n=${t.entry_features.precedent.sampleSize})` : "";
    lines.push(esc(`${i + 1}. ${t.name || t.symbol || "unknown"}${t.symbol ? " $" + t.symbol : ""} · ${outcome}${pnl ? " · " + pnl : ""}${prec}`));
  });
  return lines.join("\n");
}

/** /early: the scanner's EARLY SIGNAL + FINAL STRETCH columns, the about-to-graduate list, and paper stats. */
export function formatEarly(payload, { limit = 6, now = Date.now(), updatedAt = null, items = null } = {}) {
  const board = payload?.earlyScanner;
  const lines = ["*" + esc("⚡ AUSPEX — EARLY SCANNER (bonding curve)") + "*"];
  if (!board) return lines.concat(esc("The early scanner isn't running yet.")).join("\n");
  const st = board.stats || {};
  lines.push(esc(`Tracking ${board.tracked ?? 0} new mints · ${st.signals?.early_curve ?? 0} early / ${st.signals?.final_stretch ?? 0} stretch signals since restart · SOL $${board.solUsd ? Number(board.solUsd).toFixed(2) : "?"}`));
  const all = items || [];
  for (const [title, arm] of [["⚡ EARLY SIGNAL", "early_curve"], ["🏁 FINAL STRETCH", "final_stretch"]]) {
    const rows = all.filter((it) => it.arm === arm).sort((a, b) => new Date(b.at) - new Date(a.at));
    lines.push("", `*${esc(title + " · " + rows.length)}*`);
    if (!rows.length) lines.push(esc("Nothing right now."));
    rows.slice(0, limit).forEach((it, i) => {
      const f = it.f || {};
      const bl = badgeLine(badgesFor(it));
      lines.push(`${esc(i + 1 + ".")} *${esc(displayName(it))}*` + (it.symbol ? " " + esc("$" + it.symbol) : "") + " · " + esc(`score ${it.earlyScore ?? "?"} · ${compactUsd(f.mcapUsd)} · ${f.progress != null ? Math.round(f.progress * 100) + "%" : "?"} · ${fx(f.buyersPerMin, 0)} buy/m · 1st10 ${f.first10Holding ?? "?"}/${f.first10Count ?? 0} · bndl ${fx(f.bundleLaunchPct)}→${fx(f.bundleNowPct)}% · ${ago(it.at, now) || ""}`));
      lines.push("    " + code(it.address) + (bl ? "\n    " + bl : ""));
    });
  }
  const atg = board.aboutToGraduate || [];
  if (atg.length) lines.push("", "*" + esc("🎓 ABOUT TO GRADUATE") + "*", esc(atg.slice(0, 6).map((a) => `${a.symbol || a.mint.slice(0, 6)} ${Math.round((a.progress || 0) * 100)}% ${compactUsd(a.mcapUsd)}`).join(" · ")));
  const ep = payload.earlyPaper?.early_curve;
  if (ep) {
    const p = (v) => (v == null ? "·" : v + "%");
    lines.push("", "*" + esc("🎯 EARLY PAPER (7d)") + "*", esc(`${ep.closed} closed · win ${p(ep.winRatePct)} · 2× ${p(ep.win2xPct)} · peak 3× ${p(ep.hit3xPct)} · 10× ${p(ep.hit10xPct)} · $100k ${p(ep.hit100kPct)} · median peak ${ep.medianPeakMultiple != null ? Number(ep.medianPeakMultiple).toFixed(2) + "×" : "·"} · median exit ${ep.medianRealizedMultiple != null ? Number(ep.medianRealizedMultiple).toFixed(2) + "×" : "·"} · fill ${p(ep.fillRatePct)}`));
  }
  if (updatedAt) lines.push("", "_" + esc(`Cache updated ${ago(updatedAt, now)} · simulated, not advice`) + "_");
  return lines.join("\n");
}

export function formatHallOfFame(rows, { limit = 10 } = {}) {
  const lines = ["*" + esc("🏛 AUSPEX — HALL OF FAME") + "*"];
  if (!rows.length) lines.push(esc("Empty — the backfill hasn't been run yet."));
  rows.slice(0, limit).forEach((r, i) => {
    lines.push(esc(`${i + 1}. ${r.name || r.symbol || "unknown"}${r.symbol ? " $" + r.symbol : ""} · peak ${compactUsd(r.peak_mcap_usd)}${r.current_mcap_usd ? " · now " + compactUsd(r.current_mcap_usd) : ""}`) + " " + code(shortAddr(r.mint)));
  });
  return lines.join("\n");
}

/** Channel auto-post: top signals with the site's badges, optional AI commentary, links to the site. */
export function formatTopPost(items, commentaries = [], { siteUrl, now = Date.now() } = {}) {
  const stamp = new Date(now).toUTCString().replace(/:\d\d GMT/, " UTC");
  const lines = ["*" + esc("👁 AUSPEX — TOP SIGNALS" + (commentaries.some(Boolean) ? " ✦ AI" : "")) + "*", "_" + esc(stamp) + "_"];
  items.forEach((it, i) => {
    lines.push("", `*${esc(`${i + 1}. ${displayName(it)}`)}*` + (it.symbol ? " " + esc("$" + it.symbol) : "") + " " + esc(`· ${it.chain} · score ${it.score ?? "?"}`));
    lines.push(code(it.address));
    const bl = badgeLine(badgesFor(it));
    if (bl) lines.push(bl);
    lines.push(...detailLines(it, { now }).slice(0, 1));
    if (commentaries[i]) lines.push("_" + esc(commentaries[i]) + "_");
    lines.push(link("View on Auspex", siteCoinUrl(siteUrl, it)));
  });
  return lines.join("\n");
}

const PERF_DIMS = { kind: "kind", source: "source", badge: "badge", score: "scoreBand", chain: "chain" };
const PERF_LABEL = {
  kind: (v) => ({ top_signal: "Top signals", launch: "Launches", graduation: "Graduations" }[v] || v),
  scoreBand: (v) => (v === "unscored" ? "unscored" : "score " + v),
  chain: (v) => v.charAt(0).toUpperCase() + v.slice(1),
  source: (v) => (v.startsWith("LAUNCH:") ? "launch " + v.slice(7) : v.startsWith("GRAD:") ? "grad " + v.slice(5) : v),
  badge: (v) => v,
};
/** /perf — the site's Signal Performance panel (payload.signalPerformance or the table, aggregated the same way). */
export function formatPerf(stats, { by = "kind", limit = 14 } = {}) {
  const dim = PERF_DIMS[by] || "kind";
  const head = "*" + esc("📊 AUSPEX — SIGNAL PERFORMANCE") + "*";
  if (!stats || !stats.available) return head + "\n" + esc("No performance data yet — the worker records signals each cycle; the first checkpoint lands 5 minutes later.");
  const rows = stats.rows.filter((r) => r.dim === dim).sort((a, b) => b.n - a.n).slice(0, limit);
  const all = stats.rows.find((r) => r.dim === "all");
  const cell = (h) => (h && h.decided ? `${Math.round(h.ratePct)}% ${h.hits}/${h.decided}` : "—");
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  const table = [pad("Group", 16) + pad("N", 5) + pad("Hit+50%", 12) + pad("2x", 5) + pad("Rug", 5) + pad("Med1h", 8) + "Med24h"];
  for (const r of rows) {
    table.push(pad((r.n < 10 ? "·" : "") + (PERF_LABEL[dim] || String)(r.value), 16) + pad(r.n, 5) + pad(cell(r.hit50), 12) +
      pad(r.hit100?.decided ? Math.round(r.hit100.ratePct) + "%" : "—", 5) + pad(r.rugRatePct == null ? "—" : Math.round(r.rugRatePct) + "%", 5) +
      pad(perfPct(r.median?.["1h"]), 8) + perfPct(r.median?.["24h"]));
  }
  if (!rows.length) table.push("No signals in this breakdown yet.");
  const pre = "```\n" + table.join("\n").replace(/[`\\]/g, (m) => "\\" + m) + "\n```";
  const foot = `Last ${stats.windowDays ?? 7}d · ${all ? all.n : stats.counted} signals · hit = +50% before −50%, resolved only · · = under 10 signals · from ${stats.source === "payload" ? "the worker's aggregate" : "auspex_signal_outcomes"}`;
  return [head, esc("By " + by + " — also: /perf kind|score|source|badge|chain"), pre, "_" + esc(foot) + "_"].join("\n");
}
