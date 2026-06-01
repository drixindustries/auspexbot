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

/**
 * Standard channel call card — posted when any member makes a call.
 */
export function formatCallCard(token, caller, rugScore) {
  const changeArrow = token.changeUp ? "▲" : "▼";
  const callerTag   = caller.username ? `@${escMd(caller.username)}` : `User ${escMd(String(caller.telegramId))}`;

  return [
    `📣 *CALL — ${escMd(token.name)} \\(${escMd(token.symbol)}\\)*`,
    ``,
    `By: ${callerTag}`,
    `💰 Entry: \`${escMd(token.price)}\`  ${changeArrow} \`${escMd(token.change)}\``,
    `├ Vol:  \`${escMd(token.volume24h)}\`  Liq: \`${escMd(token.liquidity)}\``,
    `└ ${riskEmoji(rugScore)} Rug Score: \`${rugScore}/100\``,
    ``,
    `[Basescan](https://basescan.org/token/${token.address})`,
    `\`${token.address}\``,
  ].join("\n");
}

/**
 * Elite channel forward card — forwarded when a top 30 caller makes a call.
 */
export function formatEliteCallCard(token, caller, rugScore, callerRank, callerStats) {
  const changeArrow = token.changeUp ? "▲" : "▼";
  const callerTag   = caller.username ? `@${escMd(caller.username)}` : `Rank \\#${callerRank}`;
  const winRate     = callerStats.scored_calls > 0
    ? Math.round((callerStats.wins / callerStats.scored_calls) * 100)
    : 0;

  const smartLine = (callerStats.elfa_smart_followers > 0)
    ? `Smart Followers: \`${callerStats.elfa_smart_followers.toLocaleString()}\` \\| `
    : "";

  return [
    `⚡ *ELITE CALL — ${escMd(token.name)} \\(${escMd(token.symbol)}\\)*`,
    ``,
    `By: ${callerTag} \\| Rank \\#${callerRank} \\| Win Rate: ${winRate}%`,
    `${smartLine}Score: \`${callerStats.composite_score}/100\` \\| Calls: \`${callerStats.scored_calls}\` \\| Avg Win: \`+${escMd(String(callerStats.avg_return))}%\``,
    ``,
    `💰 Entry: \`${escMd(token.price)}\`  ${changeArrow} \`${escMd(token.change)}\``,
    `├ Vol:  \`${escMd(token.volume24h)}\`  Liq: \`${escMd(token.liquidity)}\``,
    `└ ${riskEmoji(rugScore)} Rug Score: \`${rugScore}/100\``,
    ``,
    `[Basescan](https://basescan.org/token/${token.address})`,
    `\`${token.address}\``,
  ].join("\n");
}

/**
 * /mystats reply.
 */
export function formatMyStats(stats, username) {
  if (!stats || stats.scored_calls < 1) {
    return [
      `📊 *Your Stats*`,
      ``,
      `No scored calls yet\\. Make calls with \`/call 0x\\.\\.\\.\``,
      `Calls are scored 24h after you post them\\.`,
      `You need ${5} scored calls to enter the rankings\\.`,
    ].join("\n");
  }

  const winRate  = stats.scored_calls > 0 ? Math.round((Math.min(stats.wins, stats.scored_calls) / stats.scored_calls) * 100) : 0;
  const rankLine = stats.rank
    ? `├ Rank:       \\#${stats.rank}${stats.is_elite ? " ⚡ *ELITE*" : ""}`
    : `├ Rank:       _Not yet ranked \\(need ${Math.max(0, 5 - stats.scored_calls)} more scored calls\\)_`;

  return [
    `📊 *Your Stats*${stats.is_elite ? " ⚡" : ""}`,
    ``,
    rankLine,
    `├ Score:      \`${stats.composite_score ?? 0}/100\``,
    `├ Calls:      \`${stats.scored_calls}\``,
    `├ Wins:       \`${stats.wins}\``,
    `├ Win Rate:   \`${winRate}%\``,
    `└ Avg Win:    \`+${stats.avg_return ?? 0}%\``,
    ...(stats.elfa_smart_followers > 0 ? [
      ``,
      `*📊 Smart Follower Weight*`,
      `├ Smart Followers: \`${stats.elfa_smart_followers.toLocaleString()}\``,
      `└ Elfa Score:      \`${stats.elfa_smart_score ?? 0}/100\``,
    ] : []),
    ``,
    stats.is_elite
      ? `_Your calls are forwarded to the elite channel\\. 🏆_`
      : `_Top 30 callers get forwarded to the elite channel\\._`,
  ].join("\n");
}

/**
 * /leaderboard reply.
 */
export function formatLeaderboard(callers) {
  if (!callers || callers.length === 0) {
    return `📊 *Leaderboard*\n\n_No ranked callers yet\\. Be the first\\!_`;
  }

  const rows = callers.map((c, i) => {
    const name     = c.telegram_username ? `@${escMd(c.telegram_username)}` : `Caller ${i + 1}`;
    const winRate  = c.scored_calls > 0 ? Math.round((c.wins / c.scored_calls) * 100) : 0;
    const eliteTag = c.is_elite ? " ⚡" : "";
    return `${i + 1}\\. ${name}${eliteTag} — \`${c.composite_score}\` pts \\| ${winRate}% WR \\| ${c.scored_calls} calls`;
  });

  return [
    `🏆 *VIGIL LEADERBOARD*`,
    `_Top callers by composite score_`,
    ``,
    ...rows,
    ``,
    `_⚡ = Elite tier \\(calls forwarded to premium channel\\)_`,
  ].join("\n");
}

/**
 * Call result — posted when a call is scored at 24h.
 */
export function formatCallResult(call, callerUsername) {
  const emoji      = call.is_win ? "✅" : "❌";
  const returnStr  = call.return_pct >= 0
    ? `+${call.return_pct.toFixed(1)}%`
    : `${call.return_pct.toFixed(1)}%`;
  const callerTag  = callerUsername ? `@${escMd(callerUsername)}` : "Caller";

  return [
    `${emoji} *CALL RESULT — ${escMd(call.token_symbol ?? call.token_name)}*`,
    ``,
    `By: ${callerTag}`,
    `Entry: \`${escMd(String(call.price_at_call))}\` → 24h: \`${escMd(String(call.price_24h?.toFixed(8) ?? "?"))}\``,
    `Result: \`${escMd(returnStr)}\` ${call.is_win ? "🎯" : "💀"}`,
  ].join("\n");
}
