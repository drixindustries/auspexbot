import cron from "node-cron";
import { fetchTrendingBase } from "./gecko.js";
import { formatTrendingPost } from "./formatter.js";
import { generateTokenCommentary } from "./agents.js";
import { config } from "./config.js";

/**
 * Posts top trending Base tokens to the private channel.
 * Agent 1 (token commentary) enriches each card with a 2-3 sentence read.
 */
export async function postTrending(bot) {
  try {
    const tokens = await fetchTrendingBase(config.POST_TOKEN_COUNT);
    if (tokens.length === 0) {
      console.log("No trending tokens returned — skipping post");
      return;
    }

    // Enrich each token with AI commentary in parallel
    // generateTokenCommentary returns null gracefully if API key not set
    const commentaries = await Promise.all(
      tokens.map((t) => generateTokenCommentary(t))
    );

    // Attach commentary to each token
    const enrichedTokens = tokens.map((t, i) => ({
      ...t,
      commentary: commentaries[i] || null,
    }));

    const message = formatTrendingPost(enrichedTokens);
    await bot.telegram.sendMessage(config.CHANNEL_ID, message, {
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    });

    const aiTag = commentaries.some(Boolean) ? " (with AI commentary)" : "";
    console.log(`✅ Posted ${tokens.length} trending tokens${aiTag}`);
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
  console.log(`📡 Auto-post scheduled: every ${hours} hours (${cronExpr})`);
  cron.schedule(cronExpr, () => {
    console.log("⏰ Auto-post cron fired");
    postTrending(bot);
  });
}
