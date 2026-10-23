// The Auspex badge set, ported 1:1 from the site (auspex-site index.html: renderSignalRowHTML,
// badActorBadgesHTML, goodDevBadgeHTML, rugInsightBadgesHTML, renderLaunchedPanel, renderGraduatedPanel).
// Labels, emoji, ordering and thresholds are identical so a coin reads the same in Telegram and on the web.
// test/parity.site.test.js runs the site's own badge functions against the same payload and diffs the text.

import { badMatches, goodDev, rugInsights, rugTier } from "./normalize.js";

export const RUG_TIER = {
  safe: { emoji: "🟢", label: "SAFE", tone: "good" },
  caution: { emoji: "🟡", label: "CAUTION", tone: "warn" },
  danger: { emoji: "🔴", label: "DANGER", tone: "bad" },
};

// Bad-list kinds, strongest first (site: BAD_KIND_STYLE).
export const BAD_KINDS = ["sanctioned", "confirmed", "suspected", "heuristic"];
export const BAD_KIND = {
  sanctioned: { emoji: "⛔", label: "SANCTIONED", tone: "bad" },
  confirmed: { emoji: "🚨", label: "RUG DEV · CONFIRMED", tone: "bad" },
  suspected: { emoji: "⚠️", label: "SUSPECTED RUG DEV", tone: "bad" },
  heuristic: { emoji: "⚠️", label: "HEURISTIC LIST · UNVERIFIED", tone: "warn" },
};
export const BAD_KIND_EXPLAIN = {
  sanctioned: "On an official sanctions list (US Treasury OFAC SDN). Legal flag, not a rug finding.",
  confirmed: "Auspex's own rug-dev list: RugCheck marked one of this wallet's tokens rugged, or 2+ of its graduations lost ≥90% of liquidity within 24h.",
  suspected: "Auspex's own rug-dev list: one graduation lost ≥90% of liquidity within 24h. One event, not proof.",
  heuristic: "Third-party automated list (AllenHark). Unverified, known false positives — a hint only.",
};

export const SERIAL_LAUNCHER_MIN = 3; // site: SERIAL_LAUNCHER_MIN

const WALLET_AGE = {
  "brand-new": { emoji: "🔴", label: "BRAND-NEW WALLET", tone: "bad" },
  young: { emoji: "🟡", label: "YOUNG WALLET", tone: "warn" },
  established: { emoji: "🟢", label: "ESTABLISHED WALLET", tone: "good" },
};
const X_AGE = {
  "brand-new": { emoji: "🔴", label: "NEW X ACCT", tone: "bad" },
  young: { emoji: "🟡", label: "YOUNG X ACCT", tone: "warn" },
  established: { emoji: "🟢", label: "OLD X ACCT", tone: "good" },
};
const BUNDLE = {
  high: { emoji: "🔴", label: "BUNDLE RISK: HIGH", tone: "bad" },
  medium: { emoji: "🟡", label: "BUNDLE RISK: MED", tone: "warn" },
  low: { emoji: "🟢", label: "BUNDLE RISK: LOW", tone: "good" },
  unknown: { emoji: "⚪", label: "NO EARLY BUYS SEEN", tone: "info" },
};
const HYPE = {
  organic: { emoji: "✅", tone: "good" },
  mixed: { emoji: "⚠️", tone: "warn" },
  manufactured: { emoji: "🤖", tone: "bad" },
};

function b(id, emoji, label, tone, extra = {}) {
  return { id, emoji, label, tone, text: emoji ? `${emoji} ${label}` : label, ...extra };
}

/** One badge per bad kind, strongest first; "×N" when several sources of that kind matched. */
export function badActorBadges(matches) {
  if (!matches || !matches.length) return [];
  const byKind = {};
  for (const m of matches) (byKind[m.kind] = byKind[m.kind] || []).push(m);
  return BAD_KINDS.filter((k) => byKind[k]).map((k) => {
    const s = BAD_KIND[k];
    const label = s.label + (byKind[k].length > 1 ? " ×" + byKind[k].length : "");
    return b(`bad:${k}`, s.emoji, label, s.tone, { kind: k, sources: byKind[k].map((m) => m.label) });
  });
}

/** Good-dev badge; muted (struck through) when the wallet is also on a bad list — bad always wins. */
export function goodDevBadge(good, alsoBad) {
  if (!good || !good.tier) return null;
  const proven = good.tier === "proven";
  const n = (good.winners || []).length;
  const label = (proven ? "PROVEN DEV" : "PROMISING DEV") + (n ? " · " + n + " winner" + (n === 1 ? "" : "s") : "");
  return b(`good:${good.tier}`, proven ? "🏆" : "⭐", label, alsoBad ? "muted" : "good", { muted: !!alsoBad, tier: good.tier });
}

export function rugInsightBadges(ins) {
  if (!ins) return [];
  const out = [];
  if (ins.rugged) out.push(b("rugged", "☠", "RUGGED", "bad"));
  if (ins.insidersDetected > 0) out.push(b("insiders", "🕸", `INSIDERS DETECTED (${ins.insidersDetected})`, "warn", { count: ins.insidersDetected }));
  const ct = ins.creatorTokens;
  if (ct && ct.count >= SERIAL_LAUNCHER_MIN) out.push(b("serial", "🔁", `SERIAL LAUNCHER: ${ct.count} TOKENS`, "warn", { count: ct.count }));
  if (ins.creatorKnownAs) out.push(b("knownAs", "🏷", String(ins.creatorKnownAs), "info"));
  return out;
}

export function rugTierBadge(item) {
  const tier = rugTier(item);
  if (tier) {
    const t = RUG_TIER[tier];
    return b(`rug:${tier}`, t.emoji, t.label, t.tone, { tier, riskScore: item.rug?.riskScore ?? null, risks: item.rug?.risks || [] });
  }
  if (item.kind === "graduation") {
    if (item.rug && item.rug.tier === "unavailable") return b("rug:unavailable", "", "no RugCheck report", "info");
  }
  return null;
}

/**
 * Full ordered badge list for an item, in the same order the site renders them.
 * Signal row: rug tier, ×N confirmed, creator bad, good dev, RugCheck insights, KOL, LunarCrush, AltRank, hype.
 * Launch row: creator bad (or legacy bad actor), good dev (or legacy serial winner), insights, wallet age, X age, bundle, meta.
 * Graduation row: rug tier, venue, launchpad, insights, creator bad, good dev.
 */
export function badgesFor(item) {
  const out = [];
  const bad = badMatches(item);
  const good = goodDev(item);
  const push = (x) => { if (Array.isArray(x)) out.push(...x); else if (x) out.push(x); };

  if (item.kind === "signal") {
    push(rugTierBadge(item));
    if (item.providerCount > 1) push(b("confirmed", "", `×${item.providerCount} confirmed — same CA`, "good"));
    if (item.creatorFlag) {
      push(badActorBadges(bad));
      push(goodDevBadge(good, bad.length > 0));
    }
    push(rugInsightBadges(rugInsights(item)));
    const kol = item.kol;
    if (kol && kol.length) {
      const names = kol.slice(0, 2).map((h) => h.kol).join(", ");
      push(b("kol", "🎯", "KOL BUY: " + names + (kol.length > 2 ? " +" + (kol.length - 2) : ""), "good"));
    }
    const lunar = item.lunar;
    if (lunar) {
      const score = lunar.galaxyScore != null ? "GS " + lunar.galaxyScore : "";
      const sent = lunar.sentiment != null ? " · " + Math.round(lunar.sentiment) + "% pos" : "";
      push(b("lunar", "📡", score + sent, "info"));
      if (lunar.altRankDelta != null) {
        const up = lunar.altRankDelta > 0;
        push(b("altrank", up ? "📈" : "📉", (up ? "+" : "") + lunar.altRankDelta + " AltRank", up ? "good" : "bad"));
      }
      if (lunar.hype && lunar.hype.spiking) {
        const h = HYPE[lunar.hype.verdict] || { emoji: "?", tone: "info" };
        push(b(`hype:${lunar.hype.verdict}`, h.emoji, String(lunar.hype.verdict).toUpperCase(), h.tone));
      }
    }
  } else if (item.kind === "launch") {
    if (bad.length) push(badActorBadges(bad));
    else if (item.isBadActor) push(b("bad:legacy", "🚨", "KNOWN BAD ACTOR WALLET", "bad"));
    const isBad = bad.length > 0 || item.isBadActor;
    if (item.devReputation && item.devReputation.good) push(goodDevBadge(item.devReputation.good, isBad));
    else if (item.serialWinner && item.serialWinner.length) push(b("good:legacy", "🏆", "SERIAL WINNER", isBad ? "muted" : "good"));
    push(rugInsightBadges(item.rugInsights));
    const w = item.creatorWallet && WALLET_AGE[item.creatorWallet.ageLabel];
    if (w) push(b(`wallet:${item.creatorWallet.ageLabel}`, w.emoji, w.label, w.tone));
    const x = item.xAccountAge && X_AGE[item.xAccountAge.ageLabel];
    if (x) push(b(`x:${item.xAccountAge.ageLabel}`, x.emoji, x.label, x.tone));
    if (item.bundleCheck) {
      const bs = BUNDLE[item.bundleCheck.riskLabel] || BUNDLE.unknown;
      push(b(`bundle:${item.bundleCheck.riskLabel || "unknown"}`, bs.emoji, bs.label, bs.tone));
    }
    if (item.matchedMetas && item.matchedMetas.length) push(b("meta", "🔥", item.matchedMetas.join(", "), "info"));
  } else if (item.kind === "graduation") {
    push(rugTierBadge(item));
    if (item.venue) push(b("venue", "→", item.venue, "info"));
    if (item.launchpad) push(b("launchpad", "", item.launchpad, "info"));
    push(rugInsightBadges(rugInsights(item)));
    push(badActorBadges(bad));
    if (item.devReputation) push(goodDevBadge(good, bad.length > 0));
  }
  return out;
}

/**
 * Creator verdict, the same rule the site uses for the row border:
 * any non-heuristic bad match → "bad"; heuristic-only → "heuristic"; good dev (and not bad) → "good"; else null.
 */
export function creatorVerdict(item) {
  const bad = badMatches(item);
  if (bad.length || item.isBadActor) {
    const kinds = bad.map((m) => m.kind);
    return kinds.length && kinds.every((k) => k === "heuristic") ? "heuristic" : "bad";
  }
  if (goodDev(item)) return "good";
  return null;
}

export const VERDICT_HEADER = {
  bad: { emoji: "🚨", label: "FLAGGED CREATOR" },
  heuristic: { emoji: "⚠️", label: "HEURISTIC FLAG" },
  good: { emoji: "🏆", label: "GOOD DEV" },
};

/** Plain-text badge line (for logs / tests). */
export function badgeText(badges) {
  return badges.map((x) => x.text).join(" | ");
}
