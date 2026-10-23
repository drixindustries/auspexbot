/**
 * smartCallWatcher.js
 *
 * Monitors source Telegram groups for token calls.
 * For each call detected:
 *   1. Extracts @xhandle + contract address from the message
 *   2. Looks up the caller's smart follower count via Elfa API
 *   3. If smart followers >= SMART_FOLLOWER_THRESHOLD → broadcasts to your channel
 *   4. If below threshold → silently drops it
 *
 * Required env vars:
 *   SOURCE_CHAT_IDS          — comma-separated Telegram group IDs to monitor
 *   SMART_FOLLOWER_THRESHOLD — minimum smart followers to broadcast (default: 10)
 *
 * Optional env vars:
 *   SMART_CALL_CHANNEL_ID    — channel to post filtered calls (falls back to CHANNEL_ID)
 */

import { getSmartStats, elfaAvailable } from "./elfaClient.js";
import { tokenSnapshot } from "./lib/scan.js";
import { lookupCoin } from "./lib/auspex.js";
import { badgesFor } from "./lib/badges.js";
import { badgeLine, compactUsd, pct, siteCoinUrl } from "./lib/format.js";
import { itemFlags } from "./lib/rules.js";
import { config } from "./config.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function escMd(str) {
  if (!str) return "";
  return String(str).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

/** Parse source chat IDs from env — returns a Set of strings */
function getSourceChatIds() {
  const raw = process.env.SOURCE_CHAT_IDS || "";
  if (!raw.trim()) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** Extract first EVM (0x...) or Solana (base58, 32-44 chars) contract address */
function extractCA(text) {
  // EVM first
  const evm = text.match(/0x[a-fA-F0-9]{40}/);
  if (evm) return { ca: evm[0], chain: "base" };

  // Solana base58 (32-44 alphanumeric, no 0/O/I/l)
  const sol = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
  if (sol) return { ca: sol[0], chain: "solana" };

  return null;
}

/** Extract X/Twitter handle from message text */
function extractHandle(text) {
  // @handle mention
  const mention = text.match(/@([A-Za-z0-9_]{1,15})/);
  if (mention) return mention[1];

  // Full x.com or twitter.com URL
  const url = text.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/);
  if (url) return url[1];

  return null;
}

// Without Elfa (no key, or after the smart-stats endpoint's removal on 28 Oct 2026) calls are gated by
// Auspex instead: the CA must be on the Auspex board and carry no hard flags. SMART_CALL_UNGATED=1 passes all.
const HARD_FLAGS = ["sanctioned", "confirmed", "suspected", "rugged", "danger"];

/** Build the broadcast message (token block uses the same Auspex badges as the site). */
function formatSmartCallCard({ handle, smartStats, token, auspexItem, sourceLink, threshold, gate }) {
  const tierLine = smartStats?.influenceTier ? ` \\| ${escMd(smartStats.influenceTier)}` : "";
  const sourceLine = sourceLink ? `\n[View original](${sourceLink})` : "";
  const lines = [
    `📡 *SMART CALL DETECTED*`,
    ``,
    `Caller: @${escMd(handle)}`,
    gate === "elfa"
      ? `Smart Followers: \`${smartStats?.smartFollowerCount ?? "?"}\`${tierLine}\nThreshold: \`≥ ${threshold}\``
      : escMd(gate === "auspex" ? "Gate: on the Auspex board, no hard flags (Elfa unavailable)" : "Gate: none (SMART_CALL_UNGATED)"),
  ];
  if (token) {
    lines.push(
      ``,
      `💰 ${escMd([`Price $${token.priceRaw ? Number(token.priceRaw).toPrecision(4) : "?"}`, `Liq ${compactUsd(token.liquidityUsd)}`, `Vol ${compactUsd(token.volume24h)}`, `24h ${pct(token.change24h)}`].join(" · "))}`,
    );
  }
  if (auspexItem) {
    const bl = badgeLine(badgesFor(auspexItem));
    lines.push(escMd(`Auspex: ${auspexItem.kind}${auspexItem.score != null ? " · score " + auspexItem.score : ""}`) + (bl ? "\n" + bl : ""));
    lines.push(`[View on Auspex](${siteCoinUrl(config.AUSPEX_SITE_URL, auspexItem)})`);
  }
  if (token?.address) lines.push(``, `\`${token.address}\``);
  return lines.join("\n") + sourceLine;
}

// ── Dedup — avoid rebroadcasting same CA within 1 hour ───────────────────

const recentCAs = new Map(); // ca → timestamp
const DEDUP_TTL_MS = 60 * 60 * 1000; // 1 hour

function isDuplicate(ca) {
  const last = recentCAs.get(ca.toLowerCase());
  if (!last) return false;
  return Date.now() - last < DEDUP_TTL_MS;
}

function markSeen(ca) {
  recentCAs.set(ca.toLowerCase(), Date.now());
  // Prune old entries
  for (const [k, v] of recentCAs) {
    if (Date.now() - v > DEDUP_TTL_MS) recentCAs.delete(k);
  }
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Wire the smart call watcher into an existing Telegraf bot instance.
 * Call this once during bot setup — it registers a middleware that
 * intercepts messages from your source groups.
 *
 * @param {import('telegraf').Telegraf} bot
 */
export function startSmartCallWatcher(bot) {
  const sourceChatIds = getSourceChatIds();
  const threshold = parseInt(process.env.SMART_FOLLOWER_THRESHOLD ?? "10", 10);
  const outputChannelId = process.env.SMART_CALL_CHANNEL_ID || config.CHANNEL_ID;

  if (sourceChatIds.size === 0) {
    console.log("📡 Smart Call Watcher: no SOURCE_CHAT_IDS set — watcher inactive");
    return;
  }

  if (!elfaAvailable()) {
    console.warn("📡 Smart Call Watcher: Elfa unavailable (no ELFA_API_KEY, or smart-stats retired 28 Oct 2026) — gating by Auspex board + flags");
  }

  console.log(`📡 Smart Call Watcher: monitoring ${sourceChatIds.size} source group(s)`);
  console.log(`   Threshold: ≥${threshold} smart followers`);
  console.log(`   Output:    ${outputChannelId}`);

  bot.on("message", async (ctx, next) => {
    try {
      const chatId = String(ctx.chat?.id);

      // Only process messages from our source groups
      if (!sourceChatIds.has(chatId)) return next();

      const text = ctx.message?.text || ctx.message?.caption || "";
      if (!text) return next();

      // Must have both a CA and an X handle to be a call
      const caResult = extractCA(text);
      if (!caResult) return next();

      const handle = extractHandle(text);
      if (!handle) return next();

      const { ca, chain } = caResult;

      // Dedup — don't broadcast same CA twice within 1 hour
      if (isDuplicate(ca)) {
        console.log(`[SmartCall] ⏭  Duplicate CA skipped: ${ca}`);
        return next();
      }

      console.log(`[SmartCall] 📨 Call detected from @${handle} — CA: ${ca}`);

      // Auspex view of this CA (same badges as the site), if it's on the board
      let auspexItem = null;
      try { auspexItem = (await lookupCoin(ca)).items[0] || null; } catch { /* cache unavailable */ }

      // Gate: Elfa smart followers when available, otherwise Auspex
      let smartStats = null;
      let gate = "ungated";
      if (elfaAvailable()) {
        gate = "elfa";
        smartStats = await getSmartStats(handle);
        const smartCount = smartStats?.smartFollowerCount ?? 0;
        if (smartCount < threshold) {
          console.log(`[SmartCall] ❌ @${handle} filtered — ${smartCount} smart followers (need ≥${threshold})`);
          return next();
        }
        console.log(`[SmartCall] ✅ @${handle} passed — ${smartCount} smart followers`);
      } else if (!/^(1|true)$/i.test(process.env.SMART_CALL_UNGATED || "")) {
        gate = "auspex";
        const hard = auspexItem ? HARD_FLAGS.filter((f) => itemFlags(auspexItem).has(f)) : [];
        if (!auspexItem || hard.length) {
          console.log(`[SmartCall] ❌ ${ca} filtered — ${auspexItem ? "flagged: " + hard.join(", ") : "not on the Auspex board"}`);
          return next();
        }
      }

      // Mark as seen before async work to prevent race condition
      markSeen(ca);

      // Token data, chain-agnostic (best-effort)
      let token = null;
      try {
        token = await tokenSnapshot(ca, { chain: chain === "base" ? "base" : "solana" });
      } catch (e) {
        console.warn(`[SmartCall] Token fetch failed for ${ca}:`, e.message);
      }

      // Build source link
      const sourceLink = ctx.chat.username
        ? `https://t.me/${ctx.chat.username}/${ctx.message.message_id}`
        : null;

      // Broadcast
      const card = formatSmartCallCard({ handle, smartStats, token, auspexItem, sourceLink, threshold, gate });

      await bot.telegram.sendMessage(outputChannelId, card, {
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      });

      console.log(`[SmartCall] 📣 Broadcast: @${handle} → ${ca}`);

    } catch (err) {
      console.error("[SmartCall] Error:", err.message);
    }

    return next();
  });
}
