import { calcRugScore } from "./gecko.js";

function escMd(str) {
  if (!str) return "";
  return String(str).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

function riskEmoji(score) {
  if (score >= 65) return "🔴";
  if (score >= 35) return "🟡";
  return "🟢";
}

function riskLabel(score) {
  if (score >= 65) return "HIGH RISK";
  if (score >= 35) return "MODERATE";
  return "LOW RISK";
}

/**
 * Single token card — used in auto-posts.
 * Optionally includes AI commentary from Agent 1.
 */
export function formatTokenCard(token, index = null) {
  const rugScore    = calcRugScore(token);
  const changeArrow = token.changeUp ? "▲" : "▼";
  const prefix      = index !== null
    ? `*${index}\\. ${escMd(token.name)}*`
    : `*${escMd(token.name)}*`;

  const lines = [
    `${prefix} \\(${escMd(token.symbol)}\\)`,
    `💰 \`${escMd(token.price)}\`  ${changeArrow} \`${escMd(token.change)}\``,
    `├ Vol:  \`${escMd(token.volume24h)}\`  Liq: \`${escMd(token.liquidity)}\``,
    `├ Holders: \`${escMd(token.holders)}\`  MCap: \`${escMd(token.marketCap)}\``,
    `└ ${riskEmoji(rugScore)} Rug Score: \`${rugScore}/100\` — ${riskLabel(rugScore)}`,
  ];

  // Agent 1: AI commentary — shown in italics if present
  if (token.commentary) {
    lines.push(``, `_${escMd(token.commentary)}_`);
  }

  lines.push(`[Basescan](https://basescan.org/token/${token.address})`);

  return lines.join("\n");
}

/**
 * Auto-post: top N trending tokens with optional AI commentary.
 */
export function formatTrendingPost(tokens) {
  const now    = new Date().toUTCString().replace(/:\d\d GMT/, " UTC");
  const aiTag  = tokens.some((t) => t.commentary) ? " ✦ AI" : "";
  const header = `👁 *VIGIL — BASE TRENDING${escMd(aiTag)}*\n_${escMd(now)}_\n`;
  const cards  = tokens.map((t, i) => formatTokenCard(t, i + 1)).join("\n\n─────────────────\n\n");
  return `${header}\n${cards}`;
}

/**
 * Payment instructions message.
 */
export function formatPaymentMessage(baseAddr, solAddr, price) {
  return [
    `👁 *VIGIL — Subscribe*`,
    ``,
    `Get access to the private channel for *$${price}/month*\\.`,
    `Accepts USDC on Base, USDC on Solana, or SOL\\.`,
    ``,
    `*Base \\(USDC\\)*`,
    `\`${escMd(baseAddr)}\``,
    ``,
    `*Solana \\(USDC or SOL\\)*`,
    `\`${escMd(solAddr)}\``,
    ``,
    `After sending, reply with:`,
    `\`/paid <your transaction hash or signature>\``,
    ``,
    `_Your subscription will be activated automatically once verified\\._`,
  ].join("\n");
}

/**
 * Subscription confirmed message.
 */
export function formatSubConfirmed(expiresAt, channelLink) {
  const expires = new Date(expiresAt).toDateString();
  return [
    `✅ *Payment verified\\!*`,
    ``,
    `Your subscription is active until *${escMd(expires)}*\\.`,
    ``,
    `👉 [Join the channel](${channelLink})`,
    ``,
    `_The bot posts top Base tokens every 4 hours with AI commentary\\._`,
  ].join("\n");
}

/**
 * Already subscribed message.
 */
export function formatAlreadySubbed(expiresAt) {
  const expires = new Date(expiresAt).toDateString();
  return `✅ You're already subscribed until *${escMd(expires)}*\\.`;
}
