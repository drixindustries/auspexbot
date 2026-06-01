/**
 * Vigil Caller Ranking System
 *
 * Members make calls with /call 0x...
 * Calls are scored at 24h against entry price.
 * Composite score determines rank.
 * Top 30 callers become elite — their calls are forwarded to the elite channel.
 */

import { supabase } from "./db.js";
import { fetchTokenData } from "./gecko.js";
import { getSmartStats, elfaAvailable } from "./elfaClient.js";
import cron from "node-cron";
import { config } from "./config.js";

// ── Rate limiting ─────────────────────────────────────────────────────────

const callCooldowns = new Map(); // telegramId → lastCallTime
const CALL_COOLDOWN_MS = 60_000; // 1 call per minute per user

export function isCallOnCooldown(telegramId) {
  const last = callCooldowns.get(String(telegramId));
  if (!last) return false;
  return Date.now() - last < CALL_COOLDOWN_MS;
}

export function setCallCooldown(telegramId) {
  callCooldowns.set(String(telegramId), Date.now());
}

/**
 * Check if this user already called this token in the last 24h.
 */
export async function isDuplicateCall(telegramId, tokenAddress) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("vigil_calls")
    .select("id")
    .eq("telegram_id", String(telegramId))
    .eq("token_address", tokenAddress.toLowerCase())
    .gte("called_at", cutoff)
    .limit(1);
  return data && data.length > 0;
}

// ── Constants ──────────────────────────────────────────────────────────────

const MIN_CALLS_TO_RANK  = 5;   // minimum scored calls before entering rankings
const ELITE_COUNT        = 30;  // top N callers get elite tier
const SCORE_WINDOW_HOURS = 24;  // score calls at 24h
const RECENCY_DAYS       = 30;  // recency window for weighting
const MAX_RETURN_CAP     = 200; // cap avg return at 200% to prevent outlier gaming

// ── DB helpers ─────────────────────────────────────────────────────────────

/**
 * Get or create a caller record.
 */
async function ensureCaller(telegramId, telegramUsername) {
  const { data, error } = await supabase
    .from("vigil_callers")
    .upsert({
      telegram_id:       String(telegramId),
      telegram_username: telegramUsername || null,
      updated_at:        new Date().toISOString(),
    }, {
      onConflict:        "telegram_id",
      ignoreDuplicates:  false,
    })
    .select()
    .single();

  if (error) throw new Error(`ensureCaller: ${error.message}`);
  return data;
}

/**
 * Record a new call.
 */
export async function recordCall({ telegramId, telegramUsername, tokenAddress, tokenName, tokenSymbol, priceAtCall, messageId, chatId }) {
  // Ensure caller exists
  await ensureCaller(telegramId, telegramUsername);

  const { error } = await supabase
    .from("vigil_calls")
    .insert({
      telegram_id:    String(telegramId),
      token_address:  tokenAddress.toLowerCase(),
      token_name:     tokenName,
      token_symbol:   tokenSymbol,
      price_at_call:  priceAtCall,
      called_at:      new Date().toISOString(),
      message_id:     messageId,
      chat_id:        String(chatId),
    });

  if (error) throw new Error(`recordCall: ${error.message}`);

  // Increment total_calls on caller — fetch current value then increment
  // (Supabase JS client doesn't support raw SQL expressions in .update())
  const { data: callerRow } = await supabase
    .from("vigil_callers")
    .select("total_calls")
    .eq("telegram_id", String(telegramId))
    .single();

  await supabase
    .from("vigil_callers")
    .update({
      total_calls: (callerRow?.total_calls ?? 0) + 1,
      updated_at:  new Date().toISOString(),
    })
    .eq("telegram_id", String(telegramId));
}

/**
 * Check if a caller is in the elite tier.
 */
export async function isEliteCaller(telegramId) {
  const { data } = await supabase
    .from("vigil_callers")
    .select("is_elite")
    .eq("telegram_id", String(telegramId))
    .single();
  return data?.is_elite === true;
}

/**
 * Store Elfa smart follower stats on a caller row.
 * Called from /call handler so we only fetch once per caller.
 * Refreshes if data is older than 24h.
 */
export async function refreshCallerElfaStats(telegramId, xUsername) {
  if (!elfaAvailable() || !xUsername) return;

  // Check if we need to refresh (older than 24h or never fetched)
  const { data: existing } = await supabase
    .from("vigil_callers")
    .select("elfa_fetched_at")
    .eq("telegram_id", String(telegramId))
    .single();

  const lastFetched = existing?.elfa_fetched_at
    ? new Date(existing.elfa_fetched_at).getTime()
    : 0;

  const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;
  if (lastFetched > staleCutoff) return; // still fresh

  const stats = await getSmartStats(xUsername);
  if (!stats) return;

  await supabase
    .from("vigil_callers")
    .update({
      elfa_smart_followers: stats.smartFollowerCount,
      elfa_smart_score:     stats.smartScore,
      x_username:           xUsername.toLowerCase(),
      elfa_fetched_at:      new Date().toISOString(),
    })
    .eq("telegram_id", String(telegramId));
}

/**
 * Get caller stats for /mystats command.
 */
export async function getCallerStats(telegramId) {
  const { data } = await supabase
    .from("vigil_callers")
    .select("*")
    .eq("telegram_id", String(telegramId))
    .single();
  return data || null;
}

/**
 * Get top N callers for /leaderboard command.
 */
export async function getLeaderboard(limit = 10) {
  const { data } = await supabase
    .from("vigil_callers")
    .select("telegram_username, composite_score, rank, wins, scored_calls, avg_return, is_elite")
    .gte("scored_calls", MIN_CALLS_TO_RANK)
    .order("composite_score", { ascending: false })
    .limit(limit);
  return data || [];
}

// ── Scoring engine ─────────────────────────────────────────────────────────

/**
 * Find all unscored calls that are >= 24h old and score them.
 * Called by cron every hour.
 */
export async function scoreMaturedCalls(bot = null) {
  const cutoff = new Date(Date.now() - SCORE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const { data: calls, error } = await supabase
    .from("vigil_calls")
    .select("id, telegram_id, token_address, price_at_call, called_at")
    .is("scored_at", null)
    .lte("called_at", cutoff);

  if (error || !calls || calls.length === 0) return 0;

  let scored = 0;

  for (const call of calls) {
    try {
      // Fetch current price
      const token = await fetchTokenData(call.token_address);
      const currentPrice = token.priceRaw;

      if (!currentPrice || currentPrice <= 0) continue;

      const returnPct = ((currentPrice - call.price_at_call) / call.price_at_call) * 100;
      const isWin     = returnPct > 0;

      // Update call record
      await supabase
        .from("vigil_calls")
        .update({
          price_24h:  currentPrice,
          return_pct: returnPct,
          is_win:     isWin,
          scored_at:  new Date().toISOString(),
        })
        .eq("id", call.id);

      scored++;

      // Post result back to the standard channel if bot is available
      if (bot) {
        try {
          const { formatCallResult } = await import("./callFormatter.js");
          // Look up caller username
          const { data: caller } = await supabase
            .from("vigil_callers")
            .select("telegram_username")
            .eq("telegram_id", call.telegram_id)
            .single();

          const resultMsg = formatCallResult(
            {
              token_symbol:  call.token_symbol,
              token_name:    call.token_name,
              price_at_call: call.price_at_call,
              price_24h:     currentPrice,
              return_pct:    returnPct,
              is_win:        isWin,
            },
            caller?.telegram_username || null
          );

          const { config } = await import("./config.js");
          await bot.telegram.sendMessage(config.CHANNEL_ID, resultMsg, {
            parse_mode:               "MarkdownV2",
            disable_web_page_preview: true,
          });
        } catch (postErr) {
          console.error(`Failed to post call result for ${call.id}:`, postErr.message);
        }
      }
    } catch (err) {
      console.error(`Failed to score call ${call.id}:`, err.message);
    }
  }

  return scored;
}

/**
 * Recalculate composite scores for all callers with enough data.
 * Called by cron daily.
 */
export async function recalculateRankings() {
  // Fetch all scored calls
  const { data: allCalls, error } = await supabase
    .from("vigil_calls")
    .select("telegram_id, return_pct, is_win, called_at")
    .not("scored_at", "is", null);

  if (error || !allCalls || allCalls.length === 0) return;

  // Group calls by caller
  const callerMap = {};
  for (const call of allCalls) {
    const id = call.telegram_id;
    if (!callerMap[id]) callerMap[id] = [];
    callerMap[id].push(call);
  }

  const now        = Date.now();
  const recencyCut = now - RECENCY_DAYS * 24 * 60 * 60 * 1000;

  const scores = [];

  for (const [telegramId, calls] of Object.entries(callerMap)) {
    const scoredCalls = calls.filter((c) => c.return_pct !== null);
    if (scoredCalls.length < MIN_CALLS_TO_RANK) continue;

    const wins       = scoredCalls.filter((c) => c.is_win).length;
    const winRate    = wins / scoredCalls.length; // 0-1

    // Average return on wins, capped at MAX_RETURN_CAP
    const winReturns  = scoredCalls.filter((c) => c.is_win).map((c) => Math.min(c.return_pct, MAX_RETURN_CAP));
    const avgReturn   = winReturns.length > 0
      ? winReturns.reduce((a, b) => a + b, 0) / winReturns.length
      : 0;

    // Call volume factor — ramps to 100 at MIN_CALLS_TO_RANK * 2
    const volFactor = Math.min(scoredCalls.length / (MIN_CALLS_TO_RANK * 2), 1) * 100;

    // Recency factor — win rate of calls in last 30 days
    const recentCalls = scoredCalls.filter((c) => new Date(c.called_at).getTime() > recencyCut);
    const recentWins  = recentCalls.filter((c) => c.is_win).length;
    const recencyFactor = recentCalls.length > 0
      ? (recentWins / recentCalls.length) * 100
      : winRate * 100; // fall back to overall win rate if no recent calls

    // Smart follower weight factor (0-100)
    // Fetch stored Elfa data for this caller
    const { data: callerRow } = await supabase
      .from("vigil_callers")
      .select("elfa_smart_followers, elfa_smart_score")
      .eq("telegram_id", telegramId)
      .single();

    const storedSmartFollowers = callerRow?.elfa_smart_followers ?? 0;
    const storedElfaScore      = callerRow?.elfa_smart_score      ?? 0;

    // Normalise: 500+ smart followers = full weight (100)
    // Use whichever signal is stronger: raw count or stored Elfa score
    const smartFollowerFactor = Math.min(
      Math.max(
        Math.round((storedSmartFollowers / 500) * 100),
        storedElfaScore
      ),
      100
    );

    // Composite score — updated weights to include smart follower signal
    const composite = Math.round(
      (winRate * 100)      * 0.35 +   // down from 0.40
      avgReturn            * 0.25 +   // down from 0.30
      volFactor            * 0.15 +   // down from 0.20
      recencyFactor        * 0.10 +   // unchanged
      smartFollowerFactor  * 0.15     // new — social proof weight
    );

    scores.push({
      telegram_id:         telegramId,
      composite_score:     composite,
      scored_calls:        scoredCalls.length,
      wins,
      avg_return:          Math.round(avgReturn * 10) / 10,
      smart_follower_factor: smartFollowerFactor,
      updated_at:          new Date().toISOString(),
    });
  }

  if (scores.length === 0) return;

  // Sort by composite score, assign ranks
  scores.sort((a, b) => b.composite_score - a.composite_score);

  const updates = scores.map((s, i) => ({
    ...s,
    rank:     i + 1,
    is_elite: i < ELITE_COUNT,
  }));

  // Batch upsert all scores
  const { error: upsertError } = await supabase
    .from("vigil_callers")
    .upsert(updates, { onConflict: "telegram_id" });

  if (upsertError) {
    console.error("Failed to update rankings:", upsertError.message);
    return;
  }

  const eliteCount = updates.filter((u) => u.is_elite).length;
  console.log(`✅ Rankings updated: ${updates.length} callers ranked, ${eliteCount} elite`);
  return updates;
}

// ── Crons ──────────────────────────────────────────────────────────────────

/**
 * Start all ranking crons.
 */
export function startRankingCrons(bot) {
  // Score matured calls every hour
  cron.schedule("0 * * * *", async () => {
    try {
      const count = await scoreMaturedCalls(bot);
      if (count > 0) {
        console.log(`📊 Scored ${count} calls`);
        // Recalculate rankings after scoring
        await recalculateRankings();
      }
    } catch (err) {
      console.error("Score cron error:", err.message);
    }
  });

  console.log("📊 Call scoring cron scheduled: every hour");
}
