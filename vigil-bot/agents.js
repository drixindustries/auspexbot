/**
 * Vigil AI Agents
 *
 * Agent 1: Token Commentary    — 2-3 sentence read on each trending token
 * Agent 2: Anomaly Detection   — watches for volume/liquidity spikes or crashes
 * Agent 3: Rug Post-Mortem     — autopsy when a token craters
 * Agent 4: Daily Market Digest — morning summary of Base activity
 *
 * All agents call claude-sonnet-4-20250514 via the Anthropic API.
 * ANTHROPIC_API_KEY must be set in env. If not set, agents are skipped gracefully.
 */

import cron from "node-cron";
import { fetchTrendingBase, fetchTokenData, calcRugScore, formatUSD, formatPrice } from "./gecko.js";
import { config } from "./config.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function escMd(str) {
  if (!str) return "";
  return String(str).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

function agentsEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Single Claude API call. Returns the text response.
 * Never throws — returns null on failure so agents degrade gracefully.
 */
async function callClaude(systemPrompt, userPrompt, maxTokens = 300) {
  if (!agentsEnabled()) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":         "application/json",
        "x-api-key":            process.env.ANTHROPIC_API_KEY,
        "anthropic-version":    "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-20250514",
        max_tokens: maxTokens,
        system:     systemPrompt,
        messages:   [{ role: "user", content: userPrompt }],
      }),
    });

    if (!res.ok) {
      console.error(`Claude API error: ${res.status}`);
      return null;
    }

    const json = await res.json();
    return json?.content?.[0]?.text?.trim() || null;
  } catch (err) {
    console.error("Claude API call failed:", err.message);
    return null;
  }
}

// ── Agent 1: Token Commentary ───────────────────────────────────────────────

const COMMENTARY_SYSTEM = `You are a sharp, no-hype crypto analyst writing for a private Base chain alpha group.
You write 2-3 sentence reads on tokens — direct, data-driven, zero fluff.
Never use phrases like "it's important to note" or "please be aware".
Never add disclaimers. Never say "DYOR". Speak like a trader, not a compliance officer.
If the data looks suspicious (low liquidity, high rug score, few holders), say so bluntly.
If it looks solid, say why. Keep it under 60 words.`;

/**
 * Generates a 2-3 sentence analyst commentary for a single token.
 * Returns the commentary string, or null if agents disabled.
 */
export async function generateTokenCommentary(token) {
  const rugScore = calcRugScore(token);

  const prompt = `Token: ${token.name} (${token.symbol}) on Base
Price: ${token.price} | 24h Change: ${token.change}
24h Volume: ${token.volume24h} | Liquidity: ${token.liquidity}
Holders: ${token.holders} | Market Cap: ${token.marketCap}
Rug Score: ${rugScore}/100

Write a 2-3 sentence analyst read on this token. Be direct.`;

  return callClaude(COMMENTARY_SYSTEM, prompt, 150);
}

// ── Agent 2: Anomaly Detection ──────────────────────────────────────────────

const ANOMALY_SYSTEM = `You are a real-time market surveillance agent for Base chain tokens.
You detect and explain anomalies in token data — sudden volume spikes, liquidity crashes, 
holder collapses, or price manipulation patterns.
Write 1-2 sentences explaining the anomaly and what it likely means. Be blunt and specific.
If it looks like a rug pull in progress, say so. Never hedge excessively.`;

// In-memory snapshot of last known token states for comparison
// Structure: { address: { liquidity, volume24h, price, holders, lastChecked } }
const tokenSnapshots = new Map();

/**
 * Checks a token for anomalies by comparing to its last known state.
 * Returns an anomaly object if detected, null otherwise.
 */
async function checkTokenAnomaly(token) {
  const prev = tokenSnapshots.get(token.address);

  // Update snapshot
  tokenSnapshots.set(token.address, {
    liquidity:  parseMoney(token.liquidity),
    volume24h:  parseMoney(token.volume24h),
    price:      parseFloat(token.priceRaw ?? 0),
    holders:    parseHolders(token.holders),
    lastChecked: Date.now(),
  });

  // No previous snapshot — nothing to compare yet
  if (!prev) return null;

  const curr = tokenSnapshots.get(token.address);
  const anomalies = [];

  // Liquidity drop >= 30% in one cycle = critical
  if (prev.liquidity > 0 && curr.liquidity > 0) {
    const liqDrop = (prev.liquidity - curr.liquidity) / prev.liquidity;
    if (liqDrop >= 0.30) {
      anomalies.push(`Liquidity dropped ${Math.round(liqDrop * 100)}% (${formatUSD(prev.liquidity)} → ${formatUSD(curr.liquidity)})`);
    }
  }

  // Volume spike >= 5x in one cycle = unusual activity
  if (prev.volume24h > 0 && curr.volume24h > 0) {
    const volSpike = curr.volume24h / prev.volume24h;
    if (volSpike >= 5) {
      anomalies.push(`Volume spiked ${volSpike.toFixed(1)}x (${formatUSD(prev.volume24h)} → ${formatUSD(curr.volume24h)})`);
    }
  }

  // Holder collapse >= 20%
  if (prev.holders > 0 && curr.holders > 0) {
    const holderDrop = (prev.holders - curr.holders) / prev.holders;
    if (holderDrop >= 0.20) {
      anomalies.push(`Holders collapsed ${Math.round(holderDrop * 100)}% (${prev.holders} → ${curr.holders})`);
    }
  }

  if (anomalies.length === 0) return null;

  return { token, anomalies };
}

/**
 * Generates an AI-written anomaly alert for posting to channel.
 */
async function generateAnomalyAlert(token, anomalies) {
  const rugScore = calcRugScore(token);
  const signals  = anomalies.join("; ");

  const prompt = `Token: ${token.name} (${token.symbol}) on Base
Address: ${token.address}
Rug Score: ${rugScore}/100
Detected anomalies: ${signals}

Write 1-2 sentences explaining what this likely means. Be direct.`;

  const commentary = await callClaude(ANOMALY_SYSTEM, prompt, 100);

  const lines = [
    `🚨 *VIGIL ALERT — ${escMd(token.name)} \\(${escMd(token.symbol)}\\)*`,
    ``,
    ...anomalies.map((a) => `⚠️ ${escMd(a)}`),
  ];

  if (commentary) {
    lines.push(``, `_${escMd(commentary)}_`);
  }

  lines.push(``, `[Basescan](https://basescan.org/token/${token.address})`);

  return lines.join("\n");
}

/**
 * Starts the anomaly detection watcher.
 * Checks top 20 Base tokens every 30 minutes.
 */
export function startAnomalyWatcher(bot) {
  // Run every 30 minutes
  cron.schedule("*/30 * * * *", async () => {
    try {
      const tokens = await fetchTrendingBase(20);

      for (const token of tokens) {
        const prev    = tokenSnapshots.get(token.address);
        const anomaly = await checkTokenAnomaly(token);
        if (!anomaly) continue;

        console.log(`🚨 Anomaly detected: ${token.name} — ${anomaly.anomalies.join(", ")}`);

        // Agent 3: if liquidity dropped >= 70%, post a full rug post-mortem
        // instead of a generic anomaly alert
        const curr       = tokenSnapshots.get(token.address);
        const liqBefore  = prev?.liquidity ?? 0;
        const liqAfter   = curr?.liquidity ?? 0;
        const isRug      = liqBefore > 0 && liqAfter >= 0 &&
                           (liqBefore - liqAfter) / liqBefore >= 0.70;

        let message;
        if (isRug) {
          console.log(`💀 Rug detected: ${token.name} — triggering post-mortem`);
          message = await generateRugPostMortem(token, liqBefore, liqAfter);
        } else {
          message = await generateAnomalyAlert(anomaly.token, anomaly.anomalies);
        }

        await bot.telegram.sendMessage(config.CHANNEL_ID, message, {
          parse_mode:               "MarkdownV2",
          disable_web_page_preview: true,
        });
      }
    } catch (err) {
      console.error("Anomaly watcher error:", err.message);
    }
  });

  console.log("👁 Anomaly watcher scheduled: every 30 minutes");
}

// ── Agent 3: Rug Post-Mortem ────────────────────────────────────────────────

const POSTMORTEM_SYSTEM = `You are a forensic analyst writing rug pull post-mortems for a crypto research channel.
You explain what happened clearly: when liquidity was pulled, which wallets exited first, 
what the warning signs were, and what the total damage was.
Write 3-5 sentences. Be specific, factual, and educational. No moralizing.
Format for Telegram — plain sentences, no bullet points.`;

/**
 * Generates a rug post-mortem when a token's liquidity craters.
 * Called by the anomaly watcher when liq drop >= 70%.
 */
export async function generateRugPostMortem(token, liquidityBefore, liquidityAfter) {
  const rugScore = calcRugScore(token);
  const liqDropPct = Math.round(((liquidityBefore - liquidityAfter) / liquidityBefore) * 100);

  const prompt = `Token: ${token.name} (${token.symbol}) on Base
Address: ${token.address}
Liquidity before: ${formatUSD(liquidityBefore)}
Liquidity after:  ${formatUSD(liquidityAfter)}
Drop:             ${liqDropPct}%
Holders:          ${token.holders}
Rug Score was:    ${rugScore}/100

Write a 3-5 sentence post-mortem. What happened, what were the warning signs, what's the damage.`;

  const analysis = await callClaude(POSTMORTEM_SYSTEM, prompt, 250);

  const lines = [
    `💀 *RUG POST\\-MORTEM — ${escMd(token.name)} \\(${escMd(token.symbol)}\\)*`,
    ``,
    `Liquidity: \`${escMd(formatUSD(liquidityBefore))}\` → \`${escMd(formatUSD(liquidityAfter))}\` \\(\\-${liqDropPct}%\\)`,
    `Rug Score was: \`${rugScore}/100\``,
    ``,
  ];

  if (analysis) {
    lines.push(escMd(analysis));
  } else {
    lines.push(`_Liquidity pulled\\. Exercise caution with any remaining position\\._`);
  }

  lines.push(``, `[Basescan](https://basescan.org/token/${token.address})`);

  return lines.join("\n");
}

// ── Agent 4: Daily Market Digest ────────────────────────────────────────────

const DIGEST_SYSTEM = `You are a morning briefing writer for a Base chain alpha channel.
You write a concise daily digest: what happened on Base yesterday, what to watch today.
Cover total DEX activity vibe, notable movers, and any patterns worth knowing.
Write 4-6 sentences. Be direct, no hype, no FUD. Sound like a seasoned trader, not a newsletter.
Do not use bullet points. Write in flowing sentences.`;

/**
 * Generates and posts the daily market digest to the channel.
 */
export async function postDailyDigest(bot) {
  try {
    // Fetch current top tokens as context
    const tokens = await fetchTrendingBase(10);

    if (tokens.length === 0) {
      console.log("No data for daily digest — skipping");
      return;
    }

    // Build context string for the agent
    const tokenLines = tokens
      .map((t, i) => `${i + 1}. ${t.name} (${t.symbol}): ${t.price} ${t.change} | Vol: ${t.volume24h} | Liq: ${t.liquidity}`)
      .join("\n");

    const topGainer = [...tokens].sort((a, b) => {
      const aChange = parseFloat(a.change.replace(/[^-\d.]/g, ""));
      const bChange = parseFloat(b.change.replace(/[^-\d.]/g, ""));
      return bChange - aChange;
    })[0];

    const topLoser = [...tokens].sort((a, b) => {
      const aChange = parseFloat(a.change.replace(/[^-\d.]/g, ""));
      const bChange = parseFloat(b.change.replace(/[^-\d.]/g, ""));
      return aChange - bChange;
    })[0];

    const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

    const prompt = `Date: ${date}
Top 10 Base tokens right now:
${tokenLines}

Top gainer: ${topGainer?.name} (${topGainer?.change})
Top loser:  ${topLoser?.name} (${topLoser?.change})

Write the morning digest for this Base alpha channel. 4-6 sentences covering market vibe, notable movers, and what to watch.`;

    const digest = await callClaude(DIGEST_SYSTEM, prompt, 300);

    const now = new Date().toUTCString().replace(/:\d\d GMT/, " UTC");

    const lines = [
      `🌅 *VIGIL — DAILY DIGEST*`,
      `_${escMd(now)}_`,
      ``,
    ];

    if (digest) {
      lines.push(escMd(digest));
    } else {
      // Fallback: data-only digest if Claude unavailable
      lines.push(
        `Top gainer: *${escMd(topGainer?.name)}* ${escMd(topGainer?.change)}`,
        `Top loser: *${escMd(topLoser?.name)}* ${escMd(topLoser?.change)}`,
        ``,
        `_AI digest unavailable — API key not configured\\._`
      );
    }

    lines.push(
      ``,
      `─────────────────`,
      ``,
      ...tokens.slice(0, 3).map((t) => {
        const arrow = t.changeUp ? "▲" : "▼";
        return `${escMd(t.symbol)} \`${escMd(t.price)}\` ${arrow} \`${escMd(t.change)}\``;
      })
    );

    await bot.telegram.sendMessage(config.CHANNEL_ID, lines.join("\n"), {
      parse_mode:               "MarkdownV2",
      disable_web_page_preview: true,
    });

    console.log("✅ Daily digest posted");
  } catch (err) {
    console.error("Daily digest error:", err.message);
  }
}

/**
 * Starts the daily digest cron.
 * Posts every morning at 08:00 UTC.
 */
export function startDailyDigest(bot) {
  cron.schedule("0 8 * * *", () => {
    console.log("🌅 Daily digest cron fired");
    postDailyDigest(bot);
  });

  console.log("🌅 Daily digest scheduled: 08:00 UTC daily");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseMoney(val) {
  if (!val || val === "N/A") return 0;
  const s = String(val).replace(/[$,]/g, "");
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  if (val.includes("M")) return n * 1_000_000;
  if (val.includes("K")) return n * 1_000;
  return n;
}

function parseHolders(val) {
  if (!val || val === "N/A") return 0;
  return parseInt(String(val).replace(/,/g, ""), 10) || 0;
}
