import cron from "node-cron";
import { formatTrendingPost } from "./formatter.js";
import { generateTokenCommentary } from "./agents.js";
import { config } from "./config.js";
import { fetchTrendingTokens } from "./lib/auspex.js";
import { formatTopPost } from "./lib/format.js";

/**
 * Posts the top Auspex signals (same feed, scores and badges as the site) to the private channel.
 * AUTOPOST_SOURCE=gecko posts GeckoTerminal trending pools instead (GECKO_NETWORK, default robinhood).
 * Agent 1 (token commentary) enriches each card with a 2-3 sentence read when ANTHROPIC_API_KEY is set.
 */
export async function postTrending(bot) {
  try {
    const tokens = await fetchTrendingTokens(config.POST_TOKEN_COUNT);
    if (tokens.length === 0) {
      console.log("No trending tokens returned — skipping post");
      return;
    }

    // generateTokenCommentary returns null gracefully if API key not set
    const commentaries = await Promise.all(tokens.map((t) => generateTokenCommentary(t)));

    const message = tokens[0].item
      ? formatTopPost(tokens.map((t) => t.item), commentaries, { siteUrl: config.AUSPEX_SITE_URL })
      : formatTrendingPost(tokens.map((t, i) => ({ ...t, commentary: commentaries[i] || null })));

    await bot.telegram.sendMessage(config.CHANNEL_ID, message, {
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    });

    const aiTag = commentaries.some(Boolean) ? " (with AI commentary)" : "";
    console.log(`✅ Posted ${tokens.length} top signals${aiTag}`);
  } catch (err) {
    console.error("Auto-post failed:", err.message);
  }
}

/**
 * Starts the auto-post cron.
 */
export function startAutoPost(bot) {
  const hours    = config.POST_INTERVAL_HOURS;
  const cronExpr = `0 */${hours} * * *`;
  console.log(`📡 Auto-post scheduled: every ${hours} hours (${cronExpr}), source: ${config.AUTOPOST_SOURCE}`);
  cron.schedule(cronExpr, () => {
    console.log("⏰ Auto-post cron fired");
    postTrending(bot);
  });
}
