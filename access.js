import cron from "node-cron";
import { getExpiredSubscribers, deactivateSubscriber } from "./subscribers.js";
import { config } from "./config.js";

/**
 * Generates a Telegram channel invite link (single use, expires after join).
 * Bot must be an admin in the channel with invite link permission.
 */
export async function generateInviteLink(bot) {
  try {
    const link = await bot.telegram.createChatInviteLink(config.CHANNEL_ID, {
      creates_join_request: false,
      member_limit: 1,
      // Expires in 1 hour
      expire_date: Math.floor(Date.now() / 1000) + 3600,
    });
    return link.invite_link;
  } catch (err) {
    console.error("Failed to create invite link:", err.message);
    // Fall back to static link if set
    return process.env.CHANNEL_LINK || null;
  }
}

/**
 * Kicks a user from the channel and bans temporarily (then unbans so they
 * can rejoin if they resubscribe).
 */
export async function revokeAccess(bot, telegramId) {
  try {
    // Ban them from the channel
    await bot.telegram.banChatMember(config.CHANNEL_ID, telegramId);
    // Immediately unban so they can rejoin after resubscribing
    await bot.telegram.unbanChatMember(config.CHANNEL_ID, telegramId);
    console.log(`Revoked access for ${telegramId}`);
  } catch (err) {
    // User may have already left — non-fatal
    console.error(`Failed to revoke access for ${telegramId}:`, err.message);
  }
}

/**
 * Daily cron: checks for expired subscribers and kicks them from the channel.
 */
export function startAccessCron(bot) {
  // Run daily at 00:05 UTC
  cron.schedule("5 0 * * *", async () => {
    console.log("🔍 Checking for expired subscribers...");
    try {
      const expired = await getExpiredSubscribers();
      if (expired.length === 0) {
        console.log("No expired subscribers");
        return;
      }
      for (const sub of expired) {
        await revokeAccess(bot, sub.telegram_id);
        await deactivateSubscriber(sub.telegram_id);
        // Notify them via DM
        try {
          await bot.telegram.sendMessage(
            sub.telegram_id,
            "⏰ Your Vigil subscription has expired\\. Send `/start` to renew\\.",
            { parse_mode: "MarkdownV2" }
          );
        } catch {
          // User may have blocked the bot — non-fatal
        }
      }
      console.log(`✅ Processed ${expired.length} expired subscribers`);
    } catch (err) {
      console.error("Access cron error:", err.message);
    }
  });

  console.log("🔒 Access expiry cron scheduled: daily at 00:05 UTC");
}
