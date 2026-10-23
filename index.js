import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { supabase } from "./db.js";
import { isSubscribed, grantSubscription, txAlreadyUsed, claimPayment } from "./subscribers.js";
import { verifyBaseUSDC, verifySolanaPayment } from "./payments.js";
import { generateInviteLink, startAccessCron } from "./access.js";
import { startAutoPost } from "./autopost.js";
import { startAnomalyWatcher, startDailyDigest } from "./agents.js";
import { addWatchedAccount, removeWatchedAccount, getWatchedAccounts, startFollowWatcher } from "./followWatcher.js";
import { recordCall, isEliteCaller, getCallerStats, getLeaderboard, startRankingCrons, isCallOnCooldown, setCallCooldown, isDuplicateCall, refreshCallerElfaStats } from "./rankings.js";
import { fetchOHLCV, renderDualChart } from "./chartRenderer.js";
import { formatMyStats, formatLeaderboard } from "./callFormatter.js";
import { startSmartCallWatcher } from "./smartCallWatcher.js";
import { formatPaymentMessage, formatSubConfirmed, formatAlreadySubbed } from "./formatter.js";
import { esc, code } from "./lib/md.js";
import { auspexData, outcomes, lookupCoin } from "./lib/auspex.js";
import { signalItems, launchItems, graduationItems } from "./lib/normalize.js";
import { badgesFor } from "./lib/badges.js";
import { formatCoinCard, formatScanCard, formatFeed, formatItemList, formatPaper, formatHallOfFame, formatPerf, badgeLine, siteCoinUrl, compactUsd, pct } from "./lib/format.js";
import { extractAddress, scanAddress, tokenSnapshot } from "./lib/scan.js";
import { applyFilterCommand, describeFilters, normalizeFilters, DEFAULT_FILTERS } from "./lib/rules.js";
import { createSupabaseStore } from "./lib/alertStore.js";
import { createAlertEngine } from "./lib/alertEngine.js";
import { hitRateFor } from "./lib/outcomes.js";

// ── Init ──────────────────────────────────────────────────────────────────

const bot = new Telegraf(config.BOT_TOKEN, { telegram: { apiRoot: config.TELEGRAM_API_ROOT } });
const MD = { parse_mode: "MarkdownV2", disable_web_page_preview: true };
const reply = (ctx, text, extra = {}) => ctx.reply(text, { ...MD, ...extra });
const isOwner = (id) => Boolean(config.OWNER_TELEGRAM_ID) && String(id) === String(config.OWNER_TELEGRAM_ID);
const argsOf = (ctx) => (ctx.message?.text || "").split(/\s+/).slice(1);

async function subscriberRow(telegramId, cols = "expires_at") {
  const { data } = await supabase.from("vigil_subscribers").select(cols).eq("telegram_id", String(telegramId)).maybeSingle();
  return data;
}

// ── /start ────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  if (await isSubscribed(telegramId)) {
    const data = await subscriberRow(telegramId);
    return reply(ctx, formatAlreadySubbed(data?.expires_at) + "\n\n" + esc("Set up alerts with /alerts on — see /help."));
  }
  if (!config.BASE_RECEIVE_ADDR || !config.SOLANA_RECEIVE_ADDR) {
    return ctx.reply("⚙️ Bot is not fully configured yet. Check back soon.");
  }
  await reply(ctx, formatPaymentMessage(config.BASE_RECEIVE_ADDR, config.SOLANA_RECEIVE_ADDR, config.PRICE_USD));
});

// ── payment verification (shared by /paid and /verifypaid) ────────────────

async function verifyPayment(txHash) {
  return txHash.startsWith("0x") ? verifyBaseUSDC(txHash) : verifySolanaPayment(txHash);
}

// ── /paid <txhash> ────────────────────────────────────────────────────────

bot.command("paid", async (ctx) => {
  const telegramId = ctx.from.id;
  const txHash = argsOf(ctx)[0]?.trim();
  if (!txHash) {
    return reply(ctx, esc("Please include your transaction hash.") + "\n\n" + esc("Example:") + "\n" + code("/paid 0x1234...abcd") + "\n" + esc("or for Solana:") + "\n" + code("/paid 5JuE...xYz"));
  }
  if (await isSubscribed(telegramId)) {
    const data = await subscriberRow(telegramId);
    return reply(ctx, formatAlreadySubbed(data?.expires_at));
  }
  if (await txAlreadyUsed(txHash)) {
    return reply(ctx, esc("❌ This transaction has already been used to activate a subscription."));
  }
  const verifyMsg = await reply(ctx, esc("🔍 Verifying payment on-chain..."));
  let paymentResult, verifyError;
  try { paymentResult = await verifyPayment(txHash); } catch (err) { verifyError = err.message; }
  try { await ctx.telegram.deleteMessage(ctx.chat.id, verifyMsg.message_id); } catch { /* already gone */ }

  if (!paymentResult || !paymentResult.valid) {
    return reply(ctx, esc("❌ Payment verification failed.") + "\n\n" + esc(verifyError || "Unknown error"));
  }
  // Claim the tx atomically before granting, so the same tx can't be replayed by anyone (incl. /verifypaid).
  const claimed = await claimPayment({
    telegramId, chain: paymentResult.chain, fromAddress: paymentResult.fromAddress,
    toAddress: txHash.startsWith("0x") ? config.BASE_RECEIVE_ADDR : config.SOLANA_RECEIVE_ADDR, amountUsd: paymentResult.amountUsd, txHash,
  }).catch((e) => { console.error(e.message); return null; });
  if (claimed === false) return reply(ctx, esc("❌ This transaction has already been used to activate a subscription."));
  if (claimed === null) return reply(ctx, esc("❌ Payment verified but could not be recorded. Please contact support."));

  let expiresAt;
  try {
    expiresAt = await grantSubscription({ telegramId, telegramUsername: ctx.from.username, chain: paymentResult.chain, txHash, amountUsd: paymentResult.amountUsd });
  } catch (err) {
    console.error("Failed to grant subscription:", err.message);
    return reply(ctx, esc("❌ Payment verified but failed to activate subscription. Please contact support."));
  }
  const inviteLink = await generateInviteLink(bot);
  if (!inviteLink) {
    return reply(ctx, `✅ *${esc("Payment verified!")}* ` + esc(`Subscription active until ${new Date(expiresAt).toDateString()}. Contact the admin for channel access.`));
  }
  await reply(ctx, formatSubConfirmed(expiresAt, inviteLink));
  console.log(`✅ New subscriber: ${telegramId} via ${paymentResult.chain}`);
});

// ── /status ───────────────────────────────────────────────────────────────

bot.command("status", async (ctx) => {
  const telegramId = ctx.from.id;
  if (!(await isSubscribed(telegramId))) {
    return reply(ctx, esc("❌ No active subscription.") + "\n\n" + esc("Send /start to subscribe."));
  }
  const data = await subscriberRow(telegramId, "expires_at, paid_chain, paid_amount");
  const expires = new Date(data?.expires_at).toDateString();
  const amount = data?.paid_amount ? `$${parseFloat(data.paid_amount).toFixed(2)}` : "?";
  await reply(ctx, [
    `✅ *Subscription Active*`, ``,
    `├ Expires: ${code(expires)}`,
    `├ Chain:   ${code(data?.paid_chain || "unknown")}`,
    `└ Paid:    ${code(amount)}`, ``,
    `_${esc("Send /start to renew before expiry.")}_`,
  ].join("\n"));
});

// ── /help ─────────────────────────────────────────────────────────────────

const HELP = [
  ["Auspex feed (same data as the site)", [
    ["/feed [solana|base]", "top signals with badges"],
    ["/coin <CA>", "full badges for any coin (alias /check; works in groups)"],
    ["/launches", "recent pump.fun / LetsBonk launches"],
    ["/grads", "recent graduations"],
    ["/paper", "paper-trading results"],
    ["/hof", "Hall of Fame"],
    ["/perf [kind|score|source|badge|chain]", "signal performance: hit rates and returns since signal"],
  ]],
  ["Alerts", [
    ["/alerts on|off", "DM / group alerts for coins matching your filters"],
    ["/alerts", "show your filters"],
    ["/filter <key> <value>", "e.g. score 70, chains solana, kinds graduation, dev proven, rugsafe on, liq 20k, exclude heuristic, include heuristic, hitrate 40, rate 5, reset"],
  ]],
  ["Callers", [
    ["/call <CA>", "submit a tracked call (Solana or Base), scored at 24h"],
    ["/mystats", "your caller stats and rank"],
    ["/leaderboard", "top 10 callers"],
    ["/register", "create a free caller account"],
    ["/verify @handle", "link your X handle ($20/month)"],
  ]],
  ["Subscription", [
    ["/start", "subscribe or view payment info"],
    ["/paid <txhash>", "verify your payment"],
    ["/status", "check your subscription"],
  ]],
];

bot.help((ctx) => {
  const lines = [`👁 *${esc("AUSPEX — early signals for Solana & Base")}*`];
  for (const [title, cmds] of HELP) {
    lines.push("", `*${esc(title)}*`);
    for (const [c, d] of cmds) lines.push(`${code(c)} — ${esc(d)}`);
  }
  lines.push("", esc(`$${config.PRICE_USD}/month. Accepts USDC on Base, USDC on Solana, or SOL. Site: ${config.AUSPEX_SITE_URL}`));
  return reply(ctx, lines.join("\n"));
});

// ── /coin <CA> (and /check) ───────────────────────────────────────────────

async function sendChart(ctx, snapshot) {
  if (!snapshot?.pairAddress || !["solana", "base"].includes(snapshot.chain)) return;
  try {
    const [hourly, daily] = await Promise.all([
      fetchOHLCV(snapshot.pairAddress, "hour", 48, snapshot.chain),
      fetchOHLCV(snapshot.pairAddress, "day", 30, snapshot.chain),
    ]);
    if (!hourly.length && !daily.length) return;
    const buf = await renderDualChart(hourly, daily, snapshot.symbol);
    await ctx.replyWithPhoto({ source: buf, filename: `${snapshot.symbol}_chart.png` }, { caption: `$${snapshot.symbol} · hourly / daily` });
  } catch (err) {
    console.error("Chart render failed:", err.message);
  }
}

async function coinCommand(ctx) {
  const found = extractAddress(ctx.message.text.replace(/^\/\S+/, ""));
  if (!found) return reply(ctx, esc("Usage: ") + code("/coin <contract address>") + esc(" (Solana or Base)"));
  ctx.sendChatAction("typing").catch(() => {});
  const keyboard = (item) => ({
    inline_keyboard: [
      [{ text: "🔎 View on Auspex", url: siteCoinUrl(config.AUSPEX_SITE_URL, item) }, { text: "📊 DexScreener", url: `https://dexscreener.com/${item.chain}/${item.address}` }],
      [{ text: "🤖 AI Analysis", callback_data: `analyze_${item.address}` }, { text: "📣 Make a Call", callback_data: `makecall_${item.address}` }],
    ],
  });
  let coin = null;
  try { coin = await lookupCoin(found.address); } catch (e) { console.error("Auspex cache read failed:", e.message); }
  if (coin && coin.items.length) {
    const main = coin.items[0];
    let hitRate = null;
    try { hitRate = hitRateFor(await outcomes.getStats(), main); } catch { /* optional */ }
    if (!main.signalPerf) { try { main.signalPerf = await outcomes.sinceSignal(main); } catch { /* optional */ } }
    await reply(ctx, formatCoinCard(coin.items, { siteUrl: config.AUSPEX_SITE_URL, updatedAt: coin.updatedAt, hitRate }), { reply_markup: keyboard(main) });
    if (["solana", "base"].includes(main.chain)) sendChart(ctx, await tokenSnapshot(main.address, { chain: main.chain }).catch(() => null));
    return;
  }
  const scan = await scanAddress(found.address, { family: found.family });
  if (!scan) return reply(ctx, esc("No DexScreener pair found on Solana or Base for this address — check it's correct, or it may be too new."));
  await reply(ctx, formatScanCard(scan, { siteUrl: config.AUSPEX_SITE_URL }), { reply_markup: keyboard({ chain: scan.chain, address: found.address }) });
  sendChart(ctx, { chain: scan.chain, pairAddress: scan.pair?.pairAddress, symbol: scan.pair?.baseToken?.symbol || "TOKEN" });
}
bot.command("coin", coinCommand);
bot.command("check", coinCommand);

// ── /coin callback: AI Analysis ───────────────────────────────────────────

bot.action(/^analyze_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Analyzing...");
  const address = ctx.match[1];
  if (!process.env.ANTHROPIC_API_KEY) return reply(ctx, esc("❌ AI Analysis requires ANTHROPIC_API_KEY to be configured."));
  const token = await tokenSnapshot(address).catch(() => null) || await tokenSnapshot(address, { chain: "base" }).catch(() => null);
  if (!token) return ctx.reply("❌ Could not fetch token data for analysis.");
  let item = null;
  try { item = (await lookupCoin(address)).items[0] || null; } catch { /* optional */ }
  const badges = item ? badgesFor(item).map((x) => x.text).join(", ") : "not on the Auspex board";
  ctx.sendChatAction("typing").catch(() => {});
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: config.ANTHROPIC_MODEL,
        max_tokens: 300,
        system: "You are a sharp crypto analyst. Write a 3-4 sentence analysis of this token. Be direct, data-driven, no hype, no disclaimers. Flag any red flags immediately. Speak like a trader.",
        messages: [{
          role: "user",
          content: `Token: ${token.name} (${token.symbol}) on ${token.chain}
Price: $${token.priceRaw} | 24h Change: ${pct(token.change24h)}
Volume: ${compactUsd(token.volume24h)} | Liquidity: ${compactUsd(token.liquidityUsd)} | MCap: ${compactUsd(token.mcapUsd)}
Auspex score: ${item?.score ?? "n/a"} | Auspex badges: ${badges}

Write your analysis.`,
        }],
      }),
    });
    const json = await res.json();
    const analysis = json?.content?.[0]?.text?.trim();
    if (!analysis) throw new Error("Empty response");
    await reply(ctx, `🤖 *${esc("AI Analysis — " + token.name)}*\n\n${esc(analysis)}`);
  } catch (err) {
    console.error("AI analysis error:", err.message);
    await ctx.reply("❌ Analysis failed. Try again.");
  }
});

bot.action(/^makecall_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await reply(ctx, esc("To make a call on this token, send:") + "\n" + code(`/call ${ctx.match[1]}`));
});

// ── /call <CA> ────────────────────────────────────────────────────────────

bot.command("call", async (ctx) => {
  const telegramId = ctx.from.id;
  const { data: callerCheck } = await supabase.from("vigil_callers").select("is_registered").eq("telegram_id", String(telegramId)).maybeSingle();
  if (!callerCheck?.is_registered) {
    await supabase.from("vigil_callers").upsert({
      telegram_id: String(telegramId), telegram_username: ctx.from.username || null, is_registered: true,
      registered_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: "telegram_id" });
  }
  if (isCallOnCooldown(telegramId)) return reply(ctx, esc("⏳ Slow down — one call per minute."));

  const found = extractAddress(ctx.message.text.replace(/^\/\S+/, ""));
  if (!found) return reply(ctx, esc("❌ No valid address found.") + "\n\n" + esc("Usage: ") + code("/call <contract address>"));
  const address = found.address;
  if (await isDuplicateCall(telegramId, address)) {
    return reply(ctx, esc("⚠️ You already called this token in the last 24h. Wait for the score before calling it again."));
  }
  const token = await tokenSnapshot(address, { chain: found.family === "evm" ? "base" : "solana" }).catch(() => null);
  if (!token) return reply(ctx, esc("❌ Token not found on Solana or Base (DexScreener)."));
  if (!token.priceRaw || token.priceRaw <= 0) return reply(ctx, esc("❌ Could not fetch a valid price for this token. Try again later."));
  setCallCooldown(telegramId);
  if (ctx.from.username) refreshCallerElfaStats(telegramId, ctx.from.username).catch((err) => console.error("Elfa refresh error (non-fatal):", err.message));

  try {
    await recordCall({
      telegramId, telegramUsername: ctx.from.username, tokenAddress: address, tokenName: token.name, tokenSymbol: token.symbol,
      priceAtCall: token.priceRaw, messageId: ctx.message.message_id, chatId: ctx.chat.id,
    });
  } catch (err) {
    console.error("Failed to record call:", err.message);
    return reply(ctx, esc("❌ Failed to record call. Try again."));
  }

  // Call card: market data + the same Auspex badges the site shows for this coin
  let item = null;
  try { item = (await lookupCoin(address)).items[0] || null; } catch { /* cache optional */ }
  const callerTag = ctx.from.username ? `@${esc(ctx.from.username)}` : esc(`User ${telegramId}`);
  const card = (eliteLine) => [
    `📣 *${esc(`${eliteLine ? "ELITE " : ""}CALL — ${token.name} ($${token.symbol})`)}*`, ``,
    `By: ${callerTag}` + (eliteLine ? " " + eliteLine : ""),
    "💰 " + esc([`Entry $${Number(token.priceRaw).toPrecision(4)}`, `Liq ${compactUsd(token.liquidityUsd)}`, `Vol ${compactUsd(token.volume24h)}`, `24h ${pct(token.change24h)}`, token.chain].join(" · ")),
    item ? (badgeLine(badgesFor(item)) || esc("No Auspex badges")) + esc(item.score != null ? `  · Auspex score ${item.score}` : "") : esc("Not on the Auspex board right now"),
    ``, `[View on Auspex](${siteCoinUrl(config.AUSPEX_SITE_URL, { chain: token.chain, address })})`, code(address),
  ].join("\n");
  await bot.telegram.sendMessage(config.CHANNEL_ID, card(null), MD);

  const elite = config.ELITE_CHANNEL_ID ? await isEliteCaller(telegramId) : false;
  if (elite) {
    const stats = await getCallerStats(telegramId);
    const winRate = stats?.scored_calls > 0 ? Math.round((stats.wins / stats.scored_calls) * 100) : 0;
    await bot.telegram.sendMessage(config.ELITE_CHANNEL_ID, card(esc(`| Rank #${stats?.rank ?? "?"} | Win Rate ${winRate}% | Score ${stats?.composite_score ?? 0}/100`)), MD);
  }
  await reply(ctx, esc(`✅ Call recorded: ${token.name} at $${Number(token.priceRaw).toPrecision(4)}. Scored in 24h.${elite ? " ⚡ Forwarded to elite channel." : ""}`));
});

// ── /mystats, /leaderboard ────────────────────────────────────────────────

bot.command("mystats", async (ctx) => reply(ctx, formatMyStats(await getCallerStats(ctx.from.id), ctx.from.username)));
bot.command("leaderboard", async (ctx) => reply(ctx, formatLeaderboard(await getLeaderboard(10))));

// ── /register ─────────────────────────────────────────────────────────────

bot.command("register", async (ctx) => {
  const telegramId = ctx.from.id;
  const { data: existing } = await supabase.from("vigil_callers").select("is_registered, is_verified").eq("telegram_id", String(telegramId)).maybeSingle();
  if (existing?.is_registered) {
    return reply(ctx, [
      `✅ *${esc("Already registered!")}*`, ``,
      `Status: ${code(existing.is_verified ? "✓ Verified" : "Unverified")}`, ``,
      `_${esc("To get verified and appear on the public leaderboard, send /verify @yourxhandle ($20/month).")}_`,
    ].join("\n"));
  }
  await supabase.from("vigil_callers").upsert({
    telegram_id: String(telegramId), telegram_username: ctx.from.username || null, is_registered: true,
    registered_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: "telegram_id" });
  await reply(ctx, [
    `👁 *${esc("Welcome to Auspex callers!")}*`, ``,
    esc("You're registered as a caller."),
    esc("Make calls with ") + code("/call <CA>") + esc(" — every call is scored at 24h."), ``,
    `*${esc("Want a public leaderboard profile?")}*`,
    esc("Send ") + code("/verify @yourxhandle") + esc(" to link your X handle."), ``,
    `_${esc("Minimum 5 scored calls needed to appear in rankings.")}_`,
  ].join("\n"));
});

// ── /verify @xhandle ──────────────────────────────────────────────────────

bot.command("verify", async (ctx) => {
  const telegramId = ctx.from.id;
  const xHandle = argsOf(ctx)[0]?.replace(/^@/, "").toLowerCase();
  if (!xHandle) return reply(ctx, esc("Usage: ") + code("/verify @yourxhandle") + "\n\n" + esc("Costs $20/month. Adds a public caller profile."));
  const { data: caller } = await supabase.from("vigil_callers").select("is_registered, is_verified, x_username").eq("telegram_id", String(telegramId)).maybeSingle();
  if (!caller?.is_registered) return reply(ctx, esc("❌ You need to /register first."));
  if (caller?.is_verified) return reply(ctx, esc(`✅ Already verified as @${caller.x_username || xHandle}.`));
  await reply(ctx, [
    `👁 *${esc(`Verify @${xHandle}`)}*`, ``,
    `${esc("Verification costs")} *${esc("$20/month")}*${esc(".")}`, ``,
    `*${esc("Base (USDC)")}*`, code(config.BASE_RECEIVE_ADDR || "Address not configured"), ``,
    `*${esc("Solana (USDC or SOL)")}*`, code(config.SOLANA_RECEIVE_ADDR || "Address not configured"), ``,
    esc("After sending, reply with:"), code(`/verifypaid ${xHandle} <txhash>`),
  ].join("\n"));
});

// ── /verifypaid @xhandle <txhash> ─────────────────────────────────────────

bot.command("verifypaid", async (ctx) => {
  const telegramId = ctx.from.id;
  const [h, t] = argsOf(ctx);
  const xHandle = h?.replace(/^@/, "").toLowerCase();
  const txHash = t?.trim();
  if (!xHandle || !txHash) return reply(ctx, esc("Usage: ") + code("/verifypaid @xhandle <txhash>"));
  const edit = (text) => ctx.telegram.editMessageText(ctx.chat.id, verifyMsg.message_id, undefined, text, MD);
  const verifyMsg = await reply(ctx, esc("🔍 Verifying payment..."));
  if (await txAlreadyUsed(txHash)) return edit(esc("❌ This transaction has already been used."));
  let paymentResult;
  try { paymentResult = await verifyPayment(txHash); } catch (err) { return edit(esc(`❌ ${err.message}`)); }
  if (paymentResult.amountUsd < 18) return edit(esc(`❌ Insufficient payment: received $${paymentResult.amountUsd.toFixed(2)}. Verification requires $20.`));
  const claimed = await claimPayment({ telegramId, chain: paymentResult.chain, fromAddress: paymentResult.fromAddress, amountUsd: paymentResult.amountUsd, txHash }).catch(() => null);
  if (!claimed) return edit(esc("❌ This transaction has already been used (or could not be recorded)."));
  await supabase.from("vigil_callers").update({
    is_verified: true, x_username: xHandle, verify_paid_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("telegram_id", String(telegramId));
  refreshCallerElfaStats(telegramId, xHandle).catch(() => {});
  await edit([`✅ *${esc("Verified!")}*`, ``, esc("Your X handle ") + code(`@${xHandle}`) + esc(" is now linked."), ``,
    `_${esc("Your profile appears on the leaderboard once you have 5 scored calls.")}_`].join("\n"));
});

// ── /addaccount, /removeaccount, /watchlist (owner only) ──────────────────
// Previously these were open to everyone when OWNER_TELEGRAM_ID was unset; now they require it.

const ownerOnly = (handler) => async (ctx) => {
  if (!isOwner(ctx.from.id)) return reply(ctx, esc("❌ Owner only (set OWNER_TELEGRAM_ID)."));
  return handler(ctx);
};

bot.command("addaccount", ownerOnly(async (ctx) => {
  const handle = argsOf(ctx)[0]?.replace(/^@/, "");
  if (!handle) return reply(ctx, esc("Usage: ") + code("/addaccount @handle"));
  const msg = await reply(ctx, esc(`🔍 Adding @${handle}... resolving account.`));
  try {
    const result = await addWatchedAccount(handle, ctx.from.id);
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined,
      esc(`✅ Now watching ${result.displayName} (@${result.handle}).`) + "\n\n_" + esc("Seeding initial following list — new follows will be alerted from now on.") + "_", MD);
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, esc(`❌ ${err.message}`), MD);
  }
}));

bot.command("removeaccount", ownerOnly(async (ctx) => {
  const handle = argsOf(ctx)[0]?.replace(/^@/, "");
  if (!handle) return reply(ctx, esc("Usage: ") + code("/removeaccount @handle"));
  try {
    await removeWatchedAccount(handle);
    await reply(ctx, esc(`✅ Stopped watching @${handle}.`));
  } catch (err) {
    await reply(ctx, esc(`❌ ${err.message}`));
  }
}));

bot.command("watchlist", ownerOnly(async (ctx) => {
  const accounts = await getWatchedAccounts();
  if (!accounts.length) return reply(ctx, `👁 *X Watchlist*\n\n_${esc("No accounts being watched yet.")}_\n\n${esc("Add one with ")}${code("/addaccount @handle")}`);
  await reply(ctx, [
    "👁 *X Watchlist*", `_${esc(`${accounts.length} account${accounts.length === 1 ? "" : "s"} being monitored`)}_`, "",
    ...accounts.map((a, i) => esc(`${i + 1}. ${a.display_name || a.handle} (@${a.handle})`)), "",
    `_${esc("Polls every 15 minutes for new follows.")}_`,
  ].join("\n"));
}));

// ── Auspex feed commands (same data as the site) ──────────────────────────

async function withCache(ctx, fn) {
  try {
    const cache = await auspexData.getSignalCache();
    return await fn(cache);
  } catch (e) {
    console.error("Auspex cache read failed:", e.message);
    return reply(ctx, esc("⚠️ Couldn't read the Auspex signal cache right now. Try again in a minute."));
  }
}

bot.command("feed", (ctx) => withCache(ctx, ({ payload, updatedAt }) => {
  const arg = (argsOf(ctx)[0] || "").toLowerCase();
  const chain = arg === "sol" ? "solana" : ["solana", "base"].includes(arg) ? arg : null;
  const items = signalItems(payload).filter((it) => chain || ["solana", "base"].includes(it.chain));
  return reply(ctx, formatFeed(payload, { chain, limit: 5, updatedAt, items }));
}));

bot.command("launches", (ctx) => withCache(ctx, ({ payload }) =>
  reply(ctx, formatItemList("🚀 JUST LAUNCHED (pump.fun / LetsBonk)", launchItems(payload), { limit: 10, empty: "Waiting for the next launch." }))));

bot.command("grads", (ctx) => withCache(ctx, ({ payload }) =>
  reply(ctx, formatItemList("🎓 JUST GRADUATED", graduationItems(payload), { limit: 10, empty: "No graduations in the cache yet." }))));

bot.command("perf", async (ctx) => {
  const by = (argsOf(ctx)[0] || "kind").toLowerCase();
  try { await reply(ctx, formatPerf(await outcomes.getStats(), { by })); } catch (e) { await reply(ctx, esc(`⚠️ ${e.message}`)); }
});

bot.command("paper", async (ctx) => {
  try { await reply(ctx, formatPaper(await auspexData.getPaperTrades(30))); } catch (e) { await reply(ctx, esc(`⚠️ ${e.message}`)); }
});

bot.command("hof", async (ctx) => {
  try { await reply(ctx, formatHallOfFame(await auspexData.getHallOfFame(20))); } catch (e) { await reply(ctx, esc(`⚠️ ${e.message}`)); }
});

// ── Alerts ────────────────────────────────────────────────────────────────

const alertStore = createSupabaseStore(supabase);
const allowCache = new Map(); // userId -> { ok, at }

async function userMayUseAlerts(userId) {
  if (isOwner(userId) || !config.ALERTS_REQUIRE_SUBSCRIPTION) return true;
  const c = allowCache.get(String(userId));
  if (c && Date.now() - c.at < 10 * 60_000) return c.ok;
  const ok = await isSubscribed(userId).catch(() => false);
  allowCache.set(String(userId), { ok, at: Date.now() });
  return ok;
}

async function mayConfigure(ctx) {
  if (ctx.chat.type === "private") return true;
  if (isOwner(ctx.from.id)) return true;
  const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id).catch(() => null);
  return m && ["creator", "administrator"].includes(m.status);
}

const engine = createAlertEngine({
  data: auspexData, outcomes, store: alertStore, telegram: bot.telegram, siteUrl: config.AUSPEX_SITE_URL,
  isChatAllowed: (rule) => userMayUseAlerts(rule.createdBy || rule.chatId), options: { pollMs: config.ALERT_POLL_MS, debug: /^(1|true)$/i.test(process.env.ALERTS_DEBUG || "") },
});

async function alertsStatusText(rule) {
  const stats = await outcomes.getStats().catch(() => ({ available: false, reason: "error" }));
  const f = normalizeFilters(rule?.filters || DEFAULT_FILTERS);
  const lines = [
    `🔔 *${esc("Auspex alerts: " + (rule?.enabled ? "ON" : "OFF"))}*`, "",
    ...describeFilters(f).map((l) => esc("• " + l)), "",
    esc(`Signal performance: ${stats.available ? `${stats.counted} signals in the last ${stats.windowDays}d (${stats.source === "payload" ? "worker aggregate" : "auspex_signal_outcomes"}) — hit rate = +50% before −50%, by score band (signals) or kind (launches/grads)` : "not available yet — hit-rate filters are skipped"}`),
    esc(`One alert per coin per chat per 24h. Store: ${alertStore.kind}.`),
    esc(`Engine: ${engine.stats.sent} sent · held back: ${engine.stats.suppressed.duplicate} duplicate, ${engine.stats.suppressed.rate_limited} rate-limited${engine.stats.lastTickAt ? "" : " · not polled yet"}`), "",
    esc("Change with ") + code("/filter <key> <value>") + esc(" — see /help."),
  ];
  return lines.join("\n");
}

bot.command("alerts", async (ctx) => {
  const sub = (argsOf(ctx)[0] || "").toLowerCase();
  const chatId = String(ctx.chat.id);
  let rule = await alertStore.getRule(chatId);
  if (sub === "on" || sub === "off") {
    if (!(await mayConfigure(ctx))) return reply(ctx, esc("❌ Only group admins can change alerts here."));
    if (sub === "on" && !(await userMayUseAlerts(ctx.from.id))) return reply(ctx, esc("🔒 Alerts are for subscribers. Send /start to subscribe."));
    rule = await alertStore.saveRule({ chatId, enabled: sub === "on", filters: rule?.filters || DEFAULT_FILTERS, createdBy: String(ctx.from.id), chatTitle: ctx.chat.title || ctx.from.username || null });
    if (sub === "on") {
      let primed = 0;
      try { primed = await engine.prime(chatId, rule.filters); } catch (e) { console.error("prime failed:", e.message); }
      await reply(ctx, (await alertsStatusText(rule)) + "\n\n" + esc(`${primed} coin(s) match right now — use /feed to see them. You'll be alerted on new matches.`));
      return;
    }
  }
  return reply(ctx, await alertsStatusText(rule));
});
bot.command("filters", async (ctx) => reply(ctx, await alertsStatusText(await alertStore.getRule(String(ctx.chat.id)))));

bot.command("filter", async (ctx) => {
  const [key, ...rest] = argsOf(ctx);
  if (!key) return reply(ctx, esc("Usage: ") + code("/filter <key> <value>") + "\n" + esc("Keys: score, chains, kinds, dev, rugsafe, liq, providers, exclude, include, hitrate, rate, reset"));
  if (!(await mayConfigure(ctx))) return reply(ctx, esc("❌ Only group admins can change alerts here."));
  const chatId = String(ctx.chat.id);
  const rule = (await alertStore.getRule(chatId)) || { chatId, enabled: false, filters: DEFAULT_FILTERS, createdBy: String(ctx.from.id) };
  const r = applyFilterCommand(rule.filters, key, rest.join(" "));
  if (r.error) return reply(ctx, esc("❌ " + r.error));
  const saved = await alertStore.saveRule({ ...rule, filters: r.filters, createdBy: rule.createdBy || String(ctx.from.id) });
  if (saved.enabled) { try { await engine.prime(chatId, saved.filters); } catch { /* best effort */ } }
  return reply(ctx, esc("✅ " + r.message) + "\n\n" + (await alertsStatusText(saved)));
});

// ── Error handler ─────────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  console.error(`Bot error [${ctx.updateType}]:`, err.message);
});

// ── Launch ────────────────────────────────────────────────────────────────

console.log("👁  Auspex bot starting...");
console.log(`   Price:    $${config.PRICE_USD}/month`);
console.log(`   Telegram: ${config.TELEGRAM_API_ROOT === "https://api.telegram.org" ? "api.telegram.org" : "custom API root (test/mock)"}`);
console.log(`   Supabase: key role ${config.SUPABASE_KEY_ROLE}${config.SUPABASE_KEY_ROLE === "anon" ? " ⚠ use SUPABASE_SERVICE_KEY (see migrations/003)" : ""}`);
console.log(`   Auspex:   cache at ${config.AUSPEX_SUPABASE_URL === config.SUPABASE_URL ? "same project as bot tables" : "separate project"}; site ${config.AUSPEX_SITE_URL}`);
console.log(`   Alerts:   ${config.ALERTS_ENABLED ? `on (poll ${config.ALERT_POLL_MS / 1000}s, subscription ${config.ALERTS_REQUIRE_SUBSCRIPTION ? "required" : "not required"})` : "off"}`);
console.log(`   AI:       ${process.env.ANTHROPIC_API_KEY ? `enabled (${config.ANTHROPIC_MODEL})` : "disabled (set ANTHROPIC_API_KEY)"}`);
console.log(`   Elite:    ${config.ELITE_CHANNEL_ID || "not set"}`);
console.log(`   X API:    ${process.env.X_BEARER_TOKEN ? "configured" : "not set"}; Nitter fallback ${config.NITTER_FALLBACK ? "on" : "off"}`);

if (!/^(1|true)$/i.test(process.env.DISABLE_CRONS || "")) {
  startSmartCallWatcher(bot);
  startAutoPost(bot);
  startAccessCron(bot);
  startAnomalyWatcher(bot);
  startDailyDigest(bot);
  startRankingCrons(bot);
  startFollowWatcher(bot);
}
if (config.ALERTS_ENABLED) engine.start();

bot.launch({ allowedUpdates: ["message", "callback_query"] });

const shutdown = (sig) => { console.log("Shutting down..."); engine.stop(); bot.stop(sig); };
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
