/**
 * Vigil Follow Watcher
 *
 * Monitors X following lists for a set of tracked accounts.
 * Primary:  X API v2 (official, reliable)
 * Fallback: Nitter scraper (free, less reliable)
 *
 * On each poll cycle:
 *  1. Fetch current following list (API or Nitter)
 *  2. Compare to stored snapshot in Supabase
 *  3. New accounts = new follows → fire Telegram alert
 *  4. Update snapshot
 */

import cron from "node-cron";
import { supabase } from "./db.js";
import { fetchFollowing, fetchRecentTweets, resolveHandle, xApiAvailable, RateLimitError } from "./xApi.js";
import { fetchFollowingNitter } from "./nitterScraper.js";
import { config } from "./config.js";
import { getSmartStats, elfaAvailable } from "./elfaClient.js";

// ── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL_MINUTES = 15;

// ── DB helpers ─────────────────────────────────────────────────────────────

/**
 * Get all accounts currently being watched.
 */
export async function getWatchedAccounts() {
  const { data } = await supabase
    .from("vigil_watched_accounts")
    .select("handle, x_user_id, display_name, added_at")
    .order("added_at", { ascending: true });
  return data || [];
}

/**
 * Add an account to the watchlist.
 * Resolves the handle to an X user ID (if API available).
 */
export async function addWatchedAccount(handle, addedBy) {
  const clean = handle.replace(/^@/, "").toLowerCase();

  // Check if already watched
  const { data: existing } = await supabase
    .from("vigil_watched_accounts")
    .select("handle")
    .eq("handle", clean)
    .single();

  if (existing) throw new Error(`@${clean} is already being watched`);

  let xUserId   = null;
  let displayName = clean;

  // Try to resolve via X API
  if (xApiAvailable()) {
    try {
      const user = await resolveHandle(clean);
      xUserId     = user.id;
      displayName = user.name;
    } catch (err) {
      console.warn(`Could not resolve @${clean} via X API: ${err.message}`);
      // Non-fatal — we'll still add them, just without the ID
    }
  }

  const { error } = await supabase
    .from("vigil_watched_accounts")
    .insert({
      handle:       clean,
      x_user_id:    xUserId,
      display_name: displayName,
      added_by:     String(addedBy),
      added_at:     new Date().toISOString(),
    });

  if (error) throw new Error(`Failed to add @${clean}: ${error.message}`);

  // Seed the initial snapshot so we only alert on NEW follows from this point
  await seedInitialSnapshot(clean, xUserId);

  return { handle: clean, displayName };
}

/**
 * Remove an account from the watchlist.
 */
export async function removeWatchedAccount(handle) {
  const clean = handle.replace(/^@/, "").toLowerCase();

  const { error } = await supabase
    .from("vigil_watched_accounts")
    .delete()
    .eq("handle", clean);

  if (error) throw new Error(`Failed to remove @${clean}: ${error.message}`);

  // Clean up snapshot
  await supabase
    .from("vigil_following_snapshots")
    .delete()
    .eq("watched_handle", clean);
}

/**
 * Seed the initial following snapshot for a new watched account.
 * This prevents firing alerts for all existing follows on first run.
 */
async function seedInitialSnapshot(handle, xUserId) {
  let following = [];

  try {
    if (xApiAvailable() && xUserId) {
      following = await fetchFollowing(xUserId);
    } else {
      following = await fetchFollowingNitter(handle);
    }
  } catch (err) {
    console.warn(`Could not seed snapshot for @${handle}: ${err.message}`);
    return; // Non-fatal — will seed on first poll
  }

  if (following.length === 0) return;

  // Batch insert all current follows as the baseline
  const rows = following.map((f) => ({
    watched_handle:    handle,
    following_x_id:    f.id   || null,
    following_handle:  f.username,
    following_name:    f.name,
    first_seen_at:     new Date().toISOString(),
    is_initial:        true, // mark as seeded — won't trigger alerts
  }));

  // Insert in batches of 100 to avoid Supabase payload limits
  for (let i = 0; i < rows.length; i += 100) {
    await supabase
      .from("vigil_following_snapshots")
      .upsert(rows.slice(i, i + 100), {
        onConflict: "watched_handle,following_handle",
        ignoreDuplicates: true,
      });
  }

  console.log(`Seeded ${following.length} follows for @${handle}`);
}

/**
 * Get the stored following set for a watched account.
 * Returns a Set of lowercase usernames.
 */
async function getStoredFollowing(handle) {
  const { data } = await supabase
    .from("vigil_following_snapshots")
    .select("following_handle")
    .eq("watched_handle", handle);

  return new Set((data || []).map((r) => r.following_handle.toLowerCase()));
}

/**
 * Store new follows in the snapshot.
 */
async function storeNewFollows(handle, newFollows) {
  const rows = newFollows.map((f) => ({
    watched_handle:   handle,
    following_x_id:   f.id || null,
    following_handle: f.username.toLowerCase(),
    following_name:   f.name,
    first_seen_at:    new Date().toISOString(),
    is_initial:       false,
  }));

  for (let i = 0; i < rows.length; i += 100) {
    await supabase
      .from("vigil_following_snapshots")
      .upsert(rows.slice(i, i + 100), { onConflict: "watched_handle,following_handle" });
  }
}

// ── Convergence detection ──────────────────────────────────────────────────

/**
 * Check how many watched accounts also follow a given handle.
 * Returns { count, watchers: [{handle, displayName}] }
 */
async function getConvergence(followingHandle) {
  const clean = followingHandle.toLowerCase();

  const { data } = await supabase
    .from("vigil_following_snapshots")
    .select("watched_handle")
    .eq("following_handle", clean)
    .eq("is_initial", false); // only count post-seed follows

  if (!data || data.length === 0) return { count: 0, watchers: [] };

  // Get display names for matched watched accounts
  const watchedHandles = [...new Set(data.map((r) => r.watched_handle))];
  const { data: accounts } = await supabase
    .from("vigil_watched_accounts")
    .select("handle, display_name")
    .in("handle", watchedHandles);

  return {
    count:    watchedHandles.length,
    watchers: accounts || [],
  };
}

/**
 * Get total watched account count for convergence ratio display.
 */
async function getWatchedCount() {
  const { count } = await supabase
    .from("vigil_watched_accounts")
    .select("handle", { count: "exact", head: true });
  return count || 0;
}

// ── Poll logic ─────────────────────────────────────────────────────────────

/**
 * Poll a single watched account for new follows.
 * Returns array of new follow objects.
 */
async function pollAccount(account) {
  let currentFollowing = [];
  let source           = "unknown";

  // Try X API first
  if (xApiAvailable() && account.x_user_id) {
    try {
      currentFollowing = await fetchFollowing(account.x_user_id);
      source           = "x_api";
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.warn(`X API rate limited for @${account.handle}, falling back to Nitter. Wait: ${Math.ceil(err.waitMs / 1000)}s`);
      } else {
        console.warn(`X API failed for @${account.handle}: ${err.message}, falling back to Nitter`);
      }
    }
  }

  // Fallback to Nitter if X API failed or not available
  if (currentFollowing.length === 0) {
    try {
      currentFollowing = await fetchFollowingNitter(account.handle);
      source           = "nitter";
    } catch (err) {
      console.error(`Both X API and Nitter failed for @${account.handle}: ${err.message}`);
      return [];
    }
  }

  if (currentFollowing.length === 0) return [];

  // Compare to stored snapshot
  const storedSet  = await getStoredFollowing(account.handle);
  const newFollows = currentFollowing.filter(
    (f) => !storedSet.has(f.username.toLowerCase())
  );

  if (newFollows.length === 0) return [];

  console.log(`@${account.handle} (${source}): ${newFollows.length} new follows detected`);

  // Store new follows so we don't alert again
  await storeNewFollows(account.handle, newFollows);

  return newFollows.map((f) => ({ ...f, watchedHandle: account.handle, watchedName: account.display_name }));
}

// ── Alert formatting ────────────────────────────────────────────────────────

function escMd(str) {
  if (!str) return "";
  return String(str).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

/**
 * Format a new follow alert for Telegram.
 */
async function formatFollowAlert(watchedName, watchedHandle, newAccount) {
  // Fetch in parallel: recent tweets, Elfa stats, convergence
  const [tweets, elfaStats, convergence, totalWatched] = await Promise.all([
    xApiAvailable() && newAccount.id
      ? fetchRecentTweets(newAccount.id, 3).catch(() => [])
      : Promise.resolve([]),
    getSmartStats(newAccount.username),
    getConvergence(newAccount.username),
    getWatchedCount(),
  ]);

  const followerCount = newAccount.followers
    ? newAccount.followers.toLocaleString()
    : "N/A";

  // Determine conviction level
  const isHighConviction = (
    (convergence.count >= 3) ||
    (elfaStats && elfaStats.smartScore >= 60) ||
    (elfaStats && elfaStats.smartFollowerCount >= 200)
  );

  const header = isHighConviction
    ? `👁 *NEW FOLLOW — HIGH CONVICTION*`
    : `👁 *NEW FOLLOW DETECTED*`;

  const lines = [header, ``];

  // Convergence — show if multiple watched accounts follow
  if (convergence.count >= 2) {
    const watcherNames = convergence.watchers
      .map((w) => `*${escMd(w.display_name || w.handle)}*`)
      .join(", ");
    lines.push(
      `⚡ *CONVERGENCE: ${convergence.count}/${totalWatched} watched accounts*`,
      `${watcherNames} all followed this account`,
      ``
    );
  } else {
    lines.push(
      `*${escMd(watchedName)}* \\(@${escMd(watchedHandle)}\\) just followed:`,
      ``
    );
  }

  // New account identity
  lines.push(
    `*${escMd(newAccount.name || newAccount.username)}* \\(@${escMd(newAccount.username)}\\)`
  );

  if (newAccount.bio) {
    lines.push(`_${escMd(newAccount.bio.slice(0, 120))}_`);
  }

  // Account stats
  lines.push(``);
  lines.push(`├ Followers: \`${escMd(followerCount)}\``);

  if (newAccount.followers && newAccount.following > 0) {
    const ratio = (newAccount.followers / newAccount.following).toFixed(1);
    lines.push(`├ Ratio:     \`${escMd(ratio)}x\` \\(following ${newAccount.following.toLocaleString()}\\)`);
  }

  if (newAccount.createdAt) {
    const joined = new Date(newAccount.createdAt).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    lines.push(`└ Joined:    \`${escMd(joined)}\``);
  }

  // Elfa smart follower stats
  if (elfaStats) {
    lines.push(
      ``,
      `*📊 ELFA Smart Follower Weight*`,
      `├ Smart Followers: \`${elfaStats.smartFollowerCount.toLocaleString()}\``,
      `├ Smart Score:     \`${elfaStats.smartScore}/100\``,
      `├ Engagement:      \`${(elfaStats.engagementRate * 100).toFixed(2)}%\``,
      `└ Influence Tier:  \`${escMd(elfaStats.influenceTier)}\``
    );
  }

  // Recent posts
  if (tweets.length > 0) {
    lines.push(``, `*Recent posts:*`);
    for (const tweet of tweets.slice(0, 2)) {
      const preview = tweet.length > 100 ? tweet.slice(0, 97) + "…" : tweet;
      lines.push(`_"${escMd(preview)}"_`);
    }
  }

  lines.push(``, `[View on X](https://twitter.com/${newAccount.username})`);

  return lines.join("\n");
}

// ── Main poll cycle ────────────────────────────────────────────────────────

/**
 * Run one full poll cycle across all watched accounts.
 * Posts alerts to the follow channel.
 */
export async function runPollCycle(bot) {
  const accounts = await getWatchedAccounts();
  if (accounts.length === 0) return;

  const followChannelId = process.env.FOLLOW_CHANNEL_ID;
  if (!followChannelId) {
    console.warn("FOLLOW_CHANNEL_ID not set — follow alerts will not be posted");
    return;
  }

  for (const account of accounts) {
    try {
      const newFollows = await pollAccount(account);

      for (const follow of newFollows) {
        const message = await formatFollowAlert(
          account.display_name,
          account.handle,
          follow
        );

        await bot.telegram.sendMessage(followChannelId, message, {
          parse_mode:               "MarkdownV2",
          disable_web_page_preview: true,
        });

        // Small delay between alerts to avoid Telegram rate limits
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err) {
      console.error(`Poll failed for @${account.handle}:`, err.message);
    }

    // Delay between accounts to spread out API calls
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ── Cron ───────────────────────────────────────────────────────────────────

/**
 * Starts the follow watcher cron.
 * Polls every POLL_INTERVAL_MINUTES minutes.
 */
export function startFollowWatcher(bot) {
  const expr = `*/${POLL_INTERVAL_MINUTES} * * * *`;

  cron.schedule(expr, () => {
    console.log("👁 Follow watcher poll cycle started");
    runPollCycle(bot).catch((err) => {
      console.error("Follow watcher cycle error:", err.message);
    });
  });

  console.log(`👁 Follow watcher scheduled: every ${POLL_INTERVAL_MINUTES} minutes`);
}
