// Alert engine: every pollMs it reads the same Auspex cache the site reads, evaluates each chat's rules,
// and sends one alert per coin per chat (deduped over dedupWindowMs, persisted), rate-limited per chat.

import { allItems } from "./normalize.js";
import { evaluate, normalizeFilters } from "./rules.js";
import { coinKey } from "./alertStore.js";
import { formatAlert, alertKeyboard } from "./format.js";

export const DEFAULTS = {
  pollMs: 60_000,                 // worker writes every 90s; polling faster only re-reads the same row
  dedupWindowMs: 24 * 3_600_000,  // one alert per coin per chat per 24h
  launchFreshMs: 15 * 60_000,     // launches older than this are never alerted (stale by then)
  graduationFreshMs: 60 * 60_000,
  staleCacheMs: 10 * 60_000,      // don't alert off a cache the worker stopped updating
  perChatGapMs: 1_100,            // Telegram: ~1 msg/s per chat
  globalGapMs: 40,                // Telegram: ~30 msg/s overall
};

/** Compact per-tick report for logs: who got what, and why the rest was held back. */
export function summarizeReport(r) {
  const by = (reason) => r.suppressed.filter((s) => s.reason === reason).map((s) => `${s.chatId}:${s.coin}`);
  return {
    stale: !!r.stale,
    sent: r.sent.map((s) => `${s.chatId}:${s.coin}(${s.kind})`),
    duplicate: by("duplicate"), rate_limited: by("rate_limited"), not_allowed: by("not_allowed"),
    filtered: r.suppressed.filter((s) => s.reason === "filtered").length,
  };
}

const KIND_PRIORITY = { graduation: 0, launch: 1, signal: 2 };

export function createAlertEngine({
  data, outcomes = null, store, telegram, siteUrl, log = console, now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), isChatAllowed = async () => true, options = {},
}) {
  const opt = { ...DEFAULTS, ...options };
  const sent = new Map();        // `${chatId}|${coinKey}` -> sentAt ms
  const history = new Map();     // chatId -> [sentAt ms] (real sends only, last hour)
  const lastSendAt = new Map();  // chatId -> ms
  let lastGlobalSend = 0;
  let pausedUntil = 0;
  let loaded = false;
  let timer = null;
  let running = false;
  const stats = { ticks: 0, sent: 0, suppressed: { duplicate: 0, rate_limited: 0, filtered: 0, stale: 0, not_allowed: 0 }, errors: 0, lastTickAt: null, lastError: null };

  const key = (chatId, it) => `${chatId}|${coinKey(it.chain, it.address)}`;

  async function loadSent() {
    if (loaded) return;
    const since = new Date(now() - opt.dedupWindowMs).toISOString();
    for (const r of await store.loadSentSince(since)) {
      const t = new Date(r.sentAt).getTime();
      sent.set(key(r.chatId, r), t);
      if (!r.primed && now() - t < 3_600_000) (history.get(r.chatId) || history.set(r.chatId, []).get(r.chatId)).push(t);
    }
    loaded = true;
  }

  function isDuplicate(chatId, it) {
    const t = sent.get(key(chatId, it));
    return t != null && now() - t < opt.dedupWindowMs;
  }

  function withinRate(chatId, maxPerHour) {
    const cutoff = now() - 3_600_000;
    const h = (history.get(chatId) || []).filter((t) => t > cutoff);
    history.set(chatId, h);
    return h.length < maxPerHour;
  }

  function isFresh(it) {
    if (it.kind === "signal") return true;
    const at = it.at ? new Date(it.at).getTime() : NaN;
    if (!Number.isFinite(at)) return false;
    return now() - at <= (it.kind === "launch" ? opt.launchFreshMs : opt.graduationFreshMs);
  }

  async function pace(chatId) {
    const waitChat = (lastSendAt.get(chatId) || 0) + opt.perChatGapMs - now();
    const waitGlobal = lastGlobalSend + opt.globalGapMs - now();
    const waitPause = pausedUntil - now();
    const w = Math.max(waitChat, waitGlobal, waitPause, 0);
    if (w > 0) await sleep(w);
  }

  /** Items that currently pass a filter set, best first. */
  function matching(items, filters, outcomeStats) {
    return items
      .filter(isFresh)
      .map((it) => ({ it, ev: evaluate(it, filters, { outcomes: outcomeStats }) }))
      .filter((x) => x.ev.pass)
      .sort((a, b) => KIND_PRIORITY[a.it.kind] - KIND_PRIORITY[b.it.kind] || (b.it.score ?? 0) - (a.it.score ?? 0));
  }

  async function snapshot() {
    const cache = await data.getSignalCache({ force: true });
    const age = cache.updatedAt ? now() - new Date(cache.updatedAt).getTime() : Infinity;
    let outcomeStats = null;
    if (outcomes) { try { outcomeStats = await outcomes.getStats(); } catch (e) { outcomeStats = { available: false, reason: e.message }; } }
    // de-duplicate within the snapshot: a coin that's both a signal and a graduation is one coin
    const seen = new Set();
    const items = allItems(cache.payload).filter((it) => {
      const k = `${it.kind}|${coinKey(it.chain, it.address)}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    return { cache, items, outcomeStats, stale: age > opt.staleCacheMs, age };
  }

  /** Mark everything currently matching as already seen, so enabling alerts doesn't flood the chat. */
  async function prime(chatId, filters) {
    await loadSent();
    const { items, outcomeStats } = await snapshot();
    const m = matching(items, filters, outcomeStats);
    const at = now();
    for (const { it } of m) {
      if (isDuplicate(chatId, it)) continue;
      sent.set(key(chatId, it), at);
      await store.recordSent({ chatId, chain: it.chain, address: it.address, kind: it.kind, primed: true, sentAt: new Date(at).toISOString() });
    }
    return m.length;
  }

  /** One pass over every enabled rule. Returns a per-tick report (used by tests and logs). */
  async function tick() {
    const report = { sent: [], suppressed: [] };
    stats.ticks += 1; stats.lastTickAt = new Date(now()).toISOString();
    await loadSent();
    const snap = await snapshot();
    if (snap.stale) {
      stats.suppressed.stale += 1;
      report.stale = true;
      log.warn?.(`[alerts] cache is ${Math.round(snap.age / 60000)} min old — worker down? Not alerting.`);
      return report;
    }
    const rules = (await store.listRules()).filter((r) => r.enabled);
    for (const rule of rules) {
      const chatId = String(rule.chatId);
      if (!(await isChatAllowed(rule))) { stats.suppressed.not_allowed += 1; report.suppressed.push({ chatId, reason: "not_allowed" }); continue; }
      const filters = normalizeFilters(rule.filters);
      for (const it of snap.items) {
        if (!isFresh(it)) continue;
        const ev = evaluate(it, filters, { outcomes: snap.outcomeStats });
        if (!ev.pass) { stats.suppressed.filtered += 1; report.suppressed.push({ chatId, coin: it.symbol || it.address, kind: it.kind, reason: "filtered", why: ev.reasons }); }
      }
      for (const { it, ev } of matching(snap.items, filters, snap.outcomeStats)) {
        const base = { chatId, coin: it.symbol || it.address, address: it.address, kind: it.kind };
        if (isDuplicate(chatId, it)) { stats.suppressed.duplicate += 1; report.suppressed.push({ ...base, reason: "duplicate" }); continue; }
        if (!withinRate(chatId, filters.maxPerHour)) { stats.suppressed.rate_limited += 1; report.suppressed.push({ ...base, reason: "rate_limited" }); continue; }
        const text = formatAlert(it, { siteUrl, now: now(), hitRate: ev.hitRate, notes: ev.notes });
        await pace(chatId);
        try {
          const msg = await telegram.sendMessage(chatId, text, { parse_mode: "MarkdownV2", disable_web_page_preview: true, reply_markup: alertKeyboard(it, siteUrl) });
          const at = now();
          lastSendAt.set(chatId, at); lastGlobalSend = at;
          sent.set(key(chatId, it), at);
          history.get(chatId)?.push(at) ?? history.set(chatId, [at]);
          stats.sent += 1;
          report.sent.push({ ...base, text, messageId: msg?.message_id ?? null });
          await store.recordSent({ chatId, chain: it.chain, address: it.address, kind: it.kind, primed: false, messageId: msg?.message_id ?? null, sentAt: new Date(at).toISOString() });
        } catch (e) {
          stats.errors += 1; stats.lastError = e.message;
          const code = e?.response?.error_code ?? e?.code;
          if (code === 429) {
            const ra = Number(e?.response?.parameters?.retry_after) || 30;
            pausedUntil = now() + ra * 1000;
            log.warn?.(`[alerts] Telegram 429 — pausing ${ra}s`);
            break;
          }
          if (code === 403 || /bot was blocked|chat not found|kicked/i.test(e.message || "")) {
            log.warn?.(`[alerts] chat ${chatId} unreachable (${e.message}) — disabling its alerts`);
            await store.saveRule({ ...rule, enabled: false });
            break;
          }
          log.error?.(`[alerts] send to ${chatId} failed: ${e.message}`);
        }
      }
    }
    return report;
  }

  function start() {
    if (timer) return;
    const loop = async () => {
      if (!running) {
        running = true;
        try {
          const r = await tick();
          if (r.sent.length) log.log?.(`[alerts] sent ${r.sent.length} alert(s)`);
          if (opt.debug) log.log?.("[alerts] tick " + JSON.stringify(summarizeReport(r)));
        }
        catch (e) { stats.errors += 1; stats.lastError = e.message; log.error?.("[alerts] tick failed:", e.message); }
        finally { running = false; }
      }
      timer = setTimeout(loop, opt.pollMs);
    };
    timer = setTimeout(loop, 1_000);
  }
  function stop() { if (timer) clearTimeout(timer); timer = null; }

  return { tick, prime, start, stop, stats, matching, snapshot, options: opt };
}
