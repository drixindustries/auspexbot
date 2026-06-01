import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { isSubscribed, grantSubscription, txAlreadyUsed } from "./subscribers.js";
import { verifyBaseUSDC, verifySolanaPayment } from "./payments.js";
import { generateInviteLink, startAccessCron } from "./access.js";
import { startAutoPost } from "./autopost.js";
import { startAnomalyWatcher, startDailyDigest } from "./agents.js";
import { addWatchedAccount, removeWatchedAccount, getWatchedAccounts, startFollowWatcher } from "./followWatcher.js";
import { recordCall, isEliteCaller, getCallerStats, getLeaderboard, startRankingCrons, isCallOnCooldown, setCallCooldown, isDuplicateCall, refreshCallerElfaStats } from "./rankings.js";
import { fetchTokenData, calcRugScore, fetchTopPoolAddress } from "./gecko.js";
import { fetchOHLCV, renderDualChart } from "./chartRenderer.js";
import { fetchSafety } from "./safetyCheck.js";
import { getSmartStats } from "./elfaClient.js";
import { formatCallCard, formatEliteCallCard, formatMyStats, formatLeaderboard } from "./callFormatter.js";
import {
  formatPaymentMessage,
  formatSubConfirmed,
  formatAlreadySubbed,
} from "./formatter.js";

// ── Init ──────────────────────────────────────────────────────────────────

const bot = new Telegraf(config.BOT_TOKEN);

// ── /start ────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const telegramId = ctx.from.id;

  // Check if already subscribed
  const subbed = await isSubscribed(telegramId);
  if (subbed) {
    const { data } = await (await import("./db.js")).supabase
      .from("vigil_subscribers")
      .select("expires_at")
      .eq("telegram_id", String(telegramId))
      .single();

    return ctx.reply(formatAlreadySubbed(data?.expires_at), {
      parse_mode: "MarkdownV2",
    });
  }

  // Show payment instructions
  if (!config.BASE_RECEIVE_ADDR || !config.SOLANA_RECEIVE_ADDR) {
    return ctx.reply("⚙️ Bot is not fully configured yet. Check back soon.");
  }

  await ctx.reply(
    formatPaymentMessage(
      config.BASE_RECEIVE_ADDR,
      config.SOLANA_RECEIVE_ADDR,
      config.PRICE_USD
    ),
    { parse_mode: "MarkdownV2" }
  );
});

// ── /paid <txhash> ────────────────────────────────────────────────────────

bot.command("paid", async (ctx) => {
  const telegramId = ctx.from.id;
  const args       = ctx.message.text.split(/\s+/).slice(1);
  const txHash     = args[0]?.trim();

  if (!txHash) {
    return ctx.reply(
      "Please include your transaction hash\\.\n\nExample:\n`/paid 0x1234...abcd`\nor for Solana:\n`/paid 5JuE...xYz`",
      { parse_mode: "MarkdownV2" }
    );
  }

  // Already subscribed?
  const subbed = await isSubscribed(telegramId);
  if (subbed) {
    const { data } = await (await import("./db.js")).supabase
      .from("vigil_subscribers")
      .select("expires_at")
      .eq("telegram_id", String(telegramId))
      .single();
    return ctx.reply(formatAlreadySubbed(data?.expires_at), { parse_mode: "MarkdownV2" });
  }

  // Check if tx already used
  const used = await txAlreadyUsed(txHash);
  if (used) {
    return ctx.reply("❌ This transaction has already been used to activate a subscription\\.", {
      parse_mode: "MarkdownV2",
    });
  }

  // Show verifying message
  const verifyMsg = await ctx.reply("🔍 Verifying payment on\\-chain\\.\\.\\.", {
    parse_mode: "MarkdownV2",
  });

  let paymentResult;
  let verifyError;

  // Try Base USDC first (0x prefix = EVM tx hash)
  if (txHash.startsWith("0x")) {
    try {
      paymentResult = await verifyBaseUSDC(txHash);
    } catch (err) {
      verifyError = err.message;
    }
  } else {
    // Assume Solana signature
    try {
      paymentResult = await verifySolanaPayment(txHash);
    } catch (err) {
      verifyError = err.message;
    }
  }

  // Delete the "verifying..." message
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, verifyMsg.message_id);
  } catch {}

  if (!paymentResult || !paymentResult.valid) {
    return ctx.reply(
      `❌ Payment verification failed\\.\n\n${(verifyError || "Unknown error").replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&")}`,
      { parse_mode: "MarkdownV2" }
    );
  }

  // Grant subscription
  let expiresAt;
  try {
    expiresAt = await grantSubscription({
      telegramId,
      telegramUsername: ctx.from.username,
      chain:            paymentResult.chain,
      txHash,
      amountUsd:        paymentResult.amountUsd,
    });
  } catch (err) {
    console.error("Failed to grant subscription:", err.message);
    return ctx.reply("❌ Payment verified but failed to activate subscription\\. Please contact support\\.", {
      parse_mode: "MarkdownV2",
    });
  }

  // Generate invite link
  const inviteLink = await generateInviteLink(bot);
  if (!inviteLink) {
    return ctx.reply(
      `✅ *Payment verified\\!* Subscription active until ${new Date(expiresAt).toDateString().replace(/[.!]/g, "\\$&")}\\.\n\nContact @admin for channel access\\.`,
      { parse_mode: "MarkdownV2" }
    );
  }

  await ctx.reply(formatSubConfirmed(expiresAt, inviteLink), {
    parse_mode: "MarkdownV2",
  });

  console.log(`✅ New subscriber: ${telegramId} (@${ctx.from.username}) via ${paymentResult.chain}`);
});

// ── /status ───────────────────────────────────────────────────────────────

bot.command("status", async (ctx) => {
  const telegramId = ctx.from.id;
  const subbed     = await isSubscribed(telegramId);

  if (!subbed) {
    return ctx.reply(
      "❌ No active subscription\\.\n\nSend `/start` to subscribe\\.",
      { parse_mode: "MarkdownV2" }
    );
  }

  const { data } = await (await import("./db.js")).supabase
    .from("vigil_subscribers")
    .select("expires_at, paid_chain, paid_amount")
    .eq("telegram_id", String(telegramId))
    .single();

  const expires   = new Date(data?.expires_at).toDateString();
  const chain     = data?.paid_chain || "unknown";
  const amount    = data?.paid_amount ? `$${parseFloat(data.paid_amount).toFixed(2)}` : "?";

  await ctx.reply(
    [
      `✅ *Subscription Active*`,
      ``,
      `├ Expires: \`${expires}\``,
      `├ Chain:   \`${chain}\``,
      `└ Paid:    \`${amount}\``,
      ``,
      `_Send \`/start\` to renew before expiry\\._`,
    ].join("\n"),
    { parse_mode: "MarkdownV2" }
  );
});

// ── /help ─────────────────────────────────────────────────────────────────

bot.help((ctx) => {
  ctx.reply(
    [
      `👁 *VIGIL — Base Token Intelligence*`,
      ``,
      `*Commands:*`,
      `\`/start\` — subscribe or view payment info`,
      `\`/register\` — create a free caller account`,
      `\`/verify @handle\` — link X handle \($20/month\) for public Augur profile`,
      `\`/check 0x\.\.\.\` — scan any token \(works in groups\)`,
      `\`/call 0x\.\.\.\` — submit a tracked call`,
      `\`/mystats\` — your caller stats and rank`,
      `\`/leaderboard\` — top 10 callers`,
      `\`/paid <txhash>\` — verify your payment`,
      `\`/status\` — check your subscription`,
      `\`/help\` — show this message`,
      ``,
      `*Payment:*`,
      `$${config.PRICE_USD}/month\\. Accepts USDC on Base, USDC on Solana, or SOL\\.`,
      ``,
      `*Channel:*`,
      `Top Base tokens posted every ${config.POST_INTERVAL_HOURS} hours with price, liquidity, and rug score\\.`,
    ].join("\n"),
    { parse_mode: "MarkdownV2" }
  );
});

// ── /check 0x... ──────────────────────────────────────────────────────────
// Works in groups and DMs — no registration required

bot.command("check", async (ctx) => {
  const text    = ctx.message.text;
  const match   = text.match(/0x[a-fA-F0-9]{40}/);
  const address = match ? match[0] : null;

  if (!address) {
    return ctx.reply(
      "Usage: `/check 0x1234\.\.\.abcd`",
      { parse_mode: "MarkdownV2" }
    );
  }

  // Send typing indicator
  ctx.sendChatAction("typing");

  // Fetch all data in parallel
  let token, safety, smartStats, poolAddress;
  try {
    [token, safety, poolAddress] = await Promise.all([
      fetchTokenData(address),
      fetchSafety(address),
      fetchTopPoolAddress(address),
    ]);
  } catch (err) {
    return ctx.reply(`❌ ${err.message || "Token not found on Base"}`, {});
  }

  const rugScore = calcRugScore(token);

  // Fetch smart follows if Elfa configured + token has a twitter handle
  // (Elfa smart follows on token addresses requires their token endpoint — use N/A for now)
  const smartFollows = null;

  // Build the caption
  const changeArrow = token.changeUp ? "▲" : "▼";

  function esc(str) {
    if (!str) return "N/A";
    return String(str).replace(/[_*[\]()~\`>#+=|{}.!\\-]/g, "\\$&");
  }

  const safetyLine = safety
    ? `${safety.verdictEmoji} Safety: ${safety.score}/10 ${safety.verdict === "SAFE" ? "✅" : ""} \| Buy: ${esc(safety.buyTax + "%")} Sell: ${esc(safety.sellTax + "%")}`
    : `🛡 Safety: N/A`;

  const smartLine = smartFollows !== null
    ? `🧠 Smart follows: ${smartFollows}`
    : "";

  const caption = [
    `*${esc(token.name)}* \($${esc(token.symbol)}\)`,
    `\`${address}\``,
    ``,
    `💰 *Price:* \`${esc(token.price)}\``,
    `💧 *Liq:* \`${esc(token.liquidity)}\` 📊 *MCap:* \`${esc(token.marketCap)}\``,
    `🏷 *FDV:* \`${esc(token.fdv)}\``,
    ``,
    safetyLine,
    smartLine,
  ].filter(Boolean).join("\n");

  // Build inline keyboard
  const keyboard = {
    inline_keyboard: [
      [
        { text: "📊 DexScreener", url: `https://dexscreener.com/base/${address}` },
        { text: "🦎 GeckoTerminal", url: `https://www.geckoterminal.com/base/pools/${poolAddress || address}` },
        { text: "🫧 BubbleMaps", url: `https://app.bubblemaps.io/base/token/${address}` },
      ],
      [
        { text: "🤖 AI Analysis", callback_data: `analyze_${address}` },
        { text: "📣 Make a Call", callback_data: `makecall_${address}` },
      ],
    ],
  };

  // Try to render chart — send as photo with caption
  // Fall back to text-only if chart fails
  try {
    if (!poolAddress) throw new Error("No pool found");

    ctx.sendChatAction("upload_photo");

    const [hourlyCandles, dailyCandles] = await Promise.all([
      fetchOHLCV(poolAddress, "hour", 48),
      fetchOHLCV(poolAddress, "day", 30),
    ]);

    const chartBuf = await renderDualChart(hourlyCandles, dailyCandles, token.symbol);

    await ctx.replyWithPhoto(
      { source: chartBuf, filename: `${token.symbol}_chart.png` },
      {
        caption,
        parse_mode:   "MarkdownV2",
        reply_markup: keyboard,
      }
    );
  } catch (chartErr) {
    console.error("Chart render failed, sending text-only:", chartErr.message);
    // Text-only fallback
    await ctx.reply(caption, {
      parse_mode:   "MarkdownV2",
      reply_markup: keyboard,
    });
  }
});

// ── /check callback: AI Analysis ──────────────────────────────────────────

bot.action(/^analyze_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Analyzing...");
  const address = ctx.match[1];

  let token;
  try {
    token = await fetchTokenData(address);
  } catch {
    return ctx.reply("❌ Could not fetch token data for analysis.");
  }

  const safety  = await fetchSafety(address);
  const rugScore = calcRugScore(token);

  if (!process.env.ANTHROPIC_API_KEY) {
    return ctx.reply("❌ AI Analysis requires ANTHROPIC\_API\_KEY to be configured.", {
      parse_mode: "MarkdownV2",
    });
  }

  ctx.sendChatAction("typing");

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-20250514",
        max_tokens: 300,
        system:     "You are a sharp crypto analyst. Write a 3-4 sentence analysis of this Base token. Be direct, data-driven, no hype, no disclaimers. Flag any red flags immediately. Speak like a trader.",
        messages: [{
          role: "user",
          content: `Token: ${token.name} (${token.symbol}) on Base
Price: ${token.price} | 24h Change: ${token.change}
Volume: ${token.volume24h} | Liquidity: ${token.liquidity}
Holders: ${token.holders} | MCap: ${token.marketCap} | FDV: ${token.fdv}
Rug Score: ${rugScore}/100
Safety: ${safety ? `${safety.score}/10 — ${safety.verdict} | Buy tax: ${safety.buyTax}% | Sell tax: ${safety.sellTax}% | Honeypot: ${safety.isHoneypot}` : "N/A"}

Write your analysis.`,
        }],
      }),
    });

    const json     = await res.json();
    const analysis = json?.content?.[0]?.text?.trim();

    if (!analysis) throw new Error("Empty response");

    function esc(s) { return String(s || "").replace(/[_*[\]()~\`>#+=|{}.!\\-]/g, "\\$&"); }

    await ctx.reply(
      `🤖 *AI Analysis — ${esc(token.name)}*

${esc(analysis)}`,
      { parse_mode: "MarkdownV2" }
    );
  } catch (err) {
    console.error("AI analysis error:", err.message);
    await ctx.reply("❌ Analysis failed. Try again.");
  }
});

// ── /check callback: Make a Call ──────────────────────────────────────────

bot.action(/^makecall_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const address = ctx.match[1];
  // Redirect them to use the /call command
  await ctx.reply(
    `To make a call on this token, send:
\`/call ${address}\``,
    { parse_mode: "MarkdownV2" }
  );
});

// ── /call 0x... ───────────────────────────────────────────────────────────

bot.command("call", async (ctx) => {
  const telegramId = ctx.from.id;

  // Auto-register on first call if not already registered
  const { supabase } = await import("./db.js");
  const { data: callerCheck } = await supabase
    .from("vigil_callers")
    .select("is_registered")
    .eq("telegram_id", String(telegramId))
    .single();

  if (!callerCheck?.is_registered) {
    await supabase
      .from("vigil_callers")
      .upsert({
        telegram_id:       String(telegramId),
        telegram_username: ctx.from.username || null,
        is_registered:     true,
        registered_at:     new Date().toISOString(),
        updated_at:        new Date().toISOString(),
      }, { onConflict: "telegram_id" });
  }

  // Rate limit — 1 call per minute per user
  if (isCallOnCooldown(telegramId)) {
    return ctx.reply("⏳ Slow down — one call per minute\.", { parse_mode: "MarkdownV2" });
  }

  const text    = ctx.message.text;
  const match   = text.match(/0x[a-fA-F0-9]{40}/);
  const address = match ? match[0] : null;

  if (!address) {
    return ctx.reply("❌ No valid address found\.

Usage: `/call 0x1234\.\.\.abcd`", { parse_mode: "MarkdownV2" });
  }

  // Duplicate call check — same token in last 24h
  const duplicate = await isDuplicateCall(telegramId, address);
  if (duplicate) {
    return ctx.reply("⚠️ You already called this token in the last 24h\. Wait for the score before calling it again\.", { parse_mode: "MarkdownV2" });
  }

  // Fetch token data
  let token;
  try {
    token = await fetchTokenData(address);
  } catch (err) {
    return ctx.reply(`❌ ${err.message || "Token not found"}\. Make sure this is a Base token\.`, { parse_mode: "MarkdownV2" });
  }

  if (!token.priceRaw || token.priceRaw <= 0) {
    return ctx.reply("❌ Could not fetch a valid price for this token\. Try again later\.", { parse_mode: "MarkdownV2" });
  }

  const rugScore = calcRugScore(token);
  setCallCooldown(telegramId);

  // Refresh Elfa stats for this caller in background — non-blocking
  // Uses their X username if available, falls back silently if not
  if (ctx.from.username) {
    refreshCallerElfaStats(telegramId, ctx.from.username).catch((err) => {
      console.error("Elfa refresh error (non-fatal):", err.message);
    });
  }

  // Record the call
  try {
    await recordCall({
      telegramId,
      telegramUsername: ctx.from.username,
      tokenAddress:     address,
      tokenName:        token.name,
      tokenSymbol:      token.symbol,
      priceAtCall:      token.priceRaw,
      messageId:        ctx.message.message_id,
      chatId:           ctx.chat.id,
    });
  } catch (err) {
    console.error("Failed to record call:", err.message);
    return ctx.reply("❌ Failed to record call\. Try again\.", { parse_mode: "MarkdownV2" });
  }

  // Post call card to standard channel
  const callCard = formatCallCard(token, { telegramId, username: ctx.from.username }, rugScore);
  await bot.telegram.sendMessage(config.CHANNEL_ID, callCard, {
    parse_mode: "MarkdownV2", disable_web_page_preview: true,
  });

  // If elite caller — also forward to elite channel with full stats
  const elite = await isEliteCaller(telegramId);
  if (elite) {
    const stats    = await getCallerStats(telegramId);
    const eliteCard = formatEliteCallCard(
      token,
      { telegramId, username: ctx.from.username },
      rugScore,
      stats?.rank,
      stats
    );
    await bot.telegram.sendMessage(config.ELITE_CHANNEL_ID, eliteCard, {
      parse_mode: "MarkdownV2", disable_web_page_preview: true,
    });
  }

  // Acknowledge in DM/group
  await ctx.reply(
    `✅ Call recorded\: *${(token.name || "").replace(/[_*[\]()~\`>#+=|{}.!\\-]/g, "\\$&")}* at \`${(token.price || "").replace(/[_*[\]()~\`>#+=|{}.!\\-]/g, "\\$&")}\`\. Scored in 24h\.${elite ? " ⚡ Forwarded to elite channel\." : ""}`,
    { parse_mode: "MarkdownV2" }
  );
});

// ── /mystats ───────────────────────────────────────────────────────────────

bot.command("mystats", async (ctx) => {
  const stats = await getCallerStats(ctx.from.id);
  await ctx.reply(formatMyStats(stats, ctx.from.username), { parse_mode: "MarkdownV2" });
});

// ── /leaderboard ───────────────────────────────────────────────────────────

bot.command("leaderboard", async (ctx) => {
  const callers = await getLeaderboard(10);
  await ctx.reply(formatLeaderboard(callers), { parse_mode: "MarkdownV2" });
});

// ── /register ────────────────────────────────────────────────────────────────

bot.command("register", async (ctx) => {
  const telegramId = ctx.from.id;

  // Check if already registered
  const { data: existing } = await (await import("./db.js")).supabase
    .from("vigil_callers")
    .select("is_registered, is_verified, telegram_username")
    .eq("telegram_id", String(telegramId))
    .single();

  if (existing?.is_registered) {
    const status = existing.is_verified ? "✓ Verified" : "Unverified";
    return ctx.reply(
      [
        `✅ *Already registered\!*`,
        ``,
        `Status: \`${status}\``,
        ``,
        `_To get verified and appear on the public leaderboard, send \`/verify @yourxhandle\` \($20/month\)\._`,
      ].join("\n"),
      { parse_mode: "MarkdownV2" }
    );
  }

  // Create caller record
  const { supabase } = await import("./db.js");
  await supabase
    .from("vigil_callers")
    .upsert({
      telegram_id:       String(telegramId),
      telegram_username: ctx.from.username || null,
      is_registered:     true,
      registered_at:     new Date().toISOString(),
      updated_at:        new Date().toISOString(),
    }, { onConflict: "telegram_id" });

  await ctx.reply(
    [
      `👁 *Welcome to Augur\!*`,
      ``,
      `You're registered as a caller\.`,
      `Make calls with \`/call 0x\.\.\.\` — every call is scored at 24h\.`,
      ``,
      `*Want a public leaderboard profile?*`,
      `Send \`/verify @yourxhandle\` to link your X handle and go live on \`augur\.gg\``,
      ``,
      `_Minimum 5 scored calls needed to appear in rankings\._`,
    ].join("\n"),
    { parse_mode: "MarkdownV2" }
  );
});

// ── /verify @xhandle ──────────────────────────────────────────────────────

bot.command("verify", async (ctx) => {
  const telegramId = ctx.from.id;
  const args       = ctx.message.text.split(/\s+/).slice(1);
  const xHandle    = args[0]?.replace(/^@/, "").toLowerCase();

  if (!xHandle) {
    return ctx.reply(
      "Usage: `/verify @yourxhandle`

Costs $20/month\. Adds Elfa smart follower weighting and a public Augur profile\.",
      { parse_mode: "MarkdownV2" }
    );
  }

  // Must be registered first
  const { supabase } = await import("./db.js");
  const { data: caller } = await supabase
    .from("vigil_callers")
    .select("is_registered, is_verified, x_username")
    .eq("telegram_id", String(telegramId))
    .single();

  if (!caller?.is_registered) {
    return ctx.reply("❌ You need to `/register` first\.", { parse_mode: "MarkdownV2" });
  }

  if (caller?.is_verified) {
    const handle = (caller.x_username || xHandle).replace(/[_*[\]()~\`>#+=|{}.!\\-]/g, "\\$&");
    return ctx.reply(`✅ Already verified as @${handle}\.`, { parse_mode: "MarkdownV2" });
  }

  // Show payment instructions for verification tier
  const escHandle = xHandle.replace(/[_*[\]()~\`>#+=|{}.!\\-]/g, "\\$&");
  await ctx.reply(
    [
      `👁 *Verify @${escHandle}*`,
      ``,
      `Verification costs *$20/month*\.`,
      ``,
      `*Base \(USDC\)*`,
      `\`${config.BASE_RECEIVE_ADDR || "Address not configured"}\``,
      ``,
      `*Solana \(USDC or SOL\)*`,
      `\`${config.SOLANA_RECEIVE_ADDR || "Address not configured"}\``,
      ``,
      `After sending, reply with:`,
      `\`/verifypaid ${escHandle} <txhash>\``,
    ].join("\n"),
    { parse_mode: "MarkdownV2" }
  );
});

// ── /verifypaid @xhandle <txhash> ────────────────────────────────────────

bot.command("verifypaid", async (ctx) => {
  const telegramId = ctx.from.id;
  const parts      = ctx.message.text.split(/\s+/).slice(1);
  const xHandle    = parts[0]?.replace(/^@/, "").toLowerCase();
  const txHash     = parts[1]?.trim();

  if (!xHandle || !txHash) {
    return ctx.reply(
      "Usage: `/verifypaid @xhandle <txhash>`",
      { parse_mode: "MarkdownV2" }
    );
  }

  const verifyMsg = await ctx.reply("🔍 Verifying payment\.\.\.", { parse_mode: "MarkdownV2" });

  let paymentResult;
  try {
    if (txHash.startsWith("0x")) {
      paymentResult = await verifyBaseUSDC(txHash);
    } else {
      paymentResult = await verifySolanaPayment(txHash);
    }
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, verifyMsg.message_id, undefined,
      `❌ ${err.message.replace(/[_*[\]()~\`>#+=|{}.!\\-]/g, "\\$&")}`,
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  // Minimum $18 for verify tier (allow slight slippage from $20)
  if (paymentResult.amountUsd < 18) {
    await ctx.telegram.editMessageText(ctx.chat.id, verifyMsg.message_id, undefined,
      `❌ Insufficient payment: received $${paymentResult.amountUsd.toFixed(2)}\. Verification requires $20\.`,
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  // Mark as verified and store X handle
  const { supabase } = await import("./db.js");
  await supabase
    .from("vigil_callers")
    .update({
      is_verified:    true,
      x_username:     xHandle,
      verify_paid_at: new Date().toISOString(),
      updated_at:     new Date().toISOString(),
    })
    .eq("telegram_id", String(telegramId));

  // Trigger Elfa stats fetch for the verified X handle
  refreshCallerElfaStats(telegramId, xHandle).catch(() => {});

  const escHandle = xHandle.replace(/[_*[\]()~\`>#+=|{}.!\\-]/g, "\\$&");
  await ctx.telegram.editMessageText(ctx.chat.id, verifyMsg.message_id, undefined,
    [
      `✅ *Verified\!*`,
      ``,
      `Your X handle \`@${escHandle}\` is now linked\.`,
      `Your profile is live at: \`augur\.gg/@${escHandle}\``,
      ``,
      `_Smart follower weighting will apply to your next ranking update\._`,
    ].join("\n"),
    { parse_mode: "MarkdownV2" }
  );
});

// ── /addaccount @handle ───────────────────────────────────────────────────

bot.command("addaccount", async (ctx) => {
  // Owner-only command — only the bot owner (you) can add accounts
  const ownerId = process.env.OWNER_TELEGRAM_ID;
  if (ownerId && String(ctx.from.id) !== String(ownerId)) {
    return ctx.reply("❌ Only the bot owner can add watched accounts\.", { parse_mode: "MarkdownV2" });
  }

  const args   = ctx.message.text.split(/\s+/).slice(1);
  const handle = args[0]?.replace(/^@/, "");

  if (!handle) {
    return ctx.reply("Usage: `/addaccount @handle`", { parse_mode: "MarkdownV2" });
  }

  const msg = await ctx.reply(`🔍 Adding @${handle.replace(/[_*[\]()~\`>#+=|{}.!\\-]/g, "\\$&")}\.\.\. resolving account\.`, { parse_mode: "MarkdownV2" });

  try {
    const result = await addWatchedAccount(handle, ctx.from.id);
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined,
      `✅ Now watching *${result.displayName.replace(/[_*[\]()~\`>#+=|{}.!\\-]/g, "\\$&")}* \(@${result.handle}\)\.

_Seeding initial following list — new follows will be alerted from now on\._`,
      { parse_mode: "MarkdownV2" }
    );
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined,
      `❌ ${err.message.replace(/[_*[\]()~\`>#+=|{}.!\\-]/g, "\\$&")}`,
      { parse_mode: "MarkdownV2" }
    );
  }
});

// ── /removeaccount @handle ────────────────────────────────────────────────

bot.command("removeaccount", async (ctx) => {
  const ownerId = process.env.OWNER_TELEGRAM_ID;
  if (ownerId && String(ctx.from.id) !== String(ownerId)) {
    return ctx.reply("❌ Only the bot owner can remove watched accounts\.", { parse_mode: "MarkdownV2" });
  }

  const args   = ctx.message.text.split(/\s+/).slice(1);
  const handle = args[0]?.replace(/^@/, "");

  if (!handle) {
    return ctx.reply("Usage: `/removeaccount @handle`", { parse_mode: "MarkdownV2" });
  }

  try {
    await removeWatchedAccount(handle);
    await ctx.reply(`✅ Stopped watching @${handle.replace(/[_*[\]()~\`>#+=|{}.!\\-]/g, "\\$&")}\.`, { parse_mode: "MarkdownV2" });
  } catch (err) {
    await ctx.reply(`❌ ${err.message.replace(/[_*[\]()~\`>#+=|{}.!\\-]/g, "\\$&")}`, { parse_mode: "MarkdownV2" });
  }
});

// ── /watchlist ────────────────────────────────────────────────────────────

bot.command("watchlist", async (ctx) => {
  const ownerId = process.env.OWNER_TELEGRAM_ID;
  if (ownerId && String(ctx.from.id) !== String(ownerId)) {
    return ctx.reply("❌ Only the bot owner can view the watchlist\.", { parse_mode: "MarkdownV2" });
  }

  const accounts = await getWatchedAccounts();

  if (accounts.length === 0) {
    return ctx.reply(
      "👁 *X Watchlist*

_No accounts being watched yet\._

Add one with `/addaccount @handle`",
      { parse_mode: "MarkdownV2" }
    );
  }

  const lines = [
    "👁 *X Watchlist*",
    `_${accounts.length} account${accounts.length === 1 ? "" : "s"} being monitored_`,
    "",
    ...accounts.map((a, i) => {
      const name = (a.display_name || a.handle).replace(/[_*[\]()~\`>#+=|{}.!\\-]/g, "\\$&");
      return `${i + 1}\. *${name}* \(@${a.handle}\)`;
    }),
    "",
    "_Polls every 15 minutes for new follows\._",
  ];

  await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
});

// ── Error handler ─────────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  console.error(`Bot error [${ctx.updateType}]:`, err.message);
});

// ── Launch ────────────────────────────────────────────────────────────────

console.log("👁  Vigil Bot starting...");
console.log(`   Price:    $${config.PRICE_USD}/month`);
console.log(`   Channel:  ${config.CHANNEL_ID}`);
console.log(`   RPC:      ${config.ALCHEMY_BASE_URL.includes("alchemy") ? "Alchemy" : "Public"}`);
console.log(`   Helius:   ${config.HELIUS_API_KEY ? "configured" : "not set (public RPC)"}`);
console.log(`   AI:       ${process.env.ANTHROPIC_API_KEY ? "enabled (all 4 agents)" : "disabled (set ANTHROPIC_API_KEY)"}`);
console.log(`   Elite:    ${config.ELITE_CHANNEL_ID}`);
console.log(`   Follow:   ${process.env.FOLLOW_CHANNEL_ID || "not set"}`);
console.log(`   X API:    ${process.env.X_BEARER_TOKEN ? "configured" : "not set (Nitter fallback only)"}`);
console.log(`   Elfa:     ${process.env.ELFA_API_KEY ? "configured" : "not set (get free key at elfa.ai/api)"}`);

// Start crons
startAutoPost(bot);
startAccessCron(bot);
startAnomalyWatcher(bot);
startDailyDigest(bot);
startRankingCrons(bot);
startFollowWatcher(bot);

// Launch bot
bot.launch({ allowedUpdates: ["message", "callback_query"] });

process.once("SIGINT",  () => { console.log("Shutting down..."); bot.stop("SIGINT"); });
process.once("SIGTERM", () => { console.log("Shutting down..."); bot.stop("SIGTERM"); });
