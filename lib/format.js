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
};

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
  const good = item.kind === "signal" ? item.creatorFlag?.good : item.devReputation?.good;
  if (good?.winners?.length) {
    lines.push("🏆 " + esc("Prior winners: " + good.winners.slice(0, 3).map((w) => (w.symbol || w.name || shortAddr(w.mint)) + (w.marketCapUsd ? ` (${compactUsd(w.marketCapUsd)})` : "")).join(", ") + (bad.length ? " — creator also on a bad list; bad flag takes priority" : "")));
  }
  if (item.kol?.length) lines.push("🎯 " + esc("Recent KOL buy seen — not a confirmed current holding."));
  if (hitRate) {
    lines.push("📈 " + esc(`Similar signals (${hitRate.cohort.replace(/\|/g, " / ")}): ${hitRate.rate}% hit rate, n=${hitRate.n}${hitRate.trusted ? "" : " (small sample)"}`));
  }
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
      lines.push(`${esc(it.rank + ".")} *${esc(displayName(it))}*` + (it.symbol ? " " + esc("$" + it.symbol) : "") + ` · ${esc("score " + (it.score ?? "?"))} · ${esc(pct(it.change24h))}`);
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
    lines.push("", `${esc(i + 1 + ".")} *${esc(displayName(it))}*` + (it.symbol ? " " + esc("$" + it.symbol) : "") + (it.at ? " · " + esc(ago(it.at, now)) : ""));
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
