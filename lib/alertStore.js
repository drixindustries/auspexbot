// Persistence for alert rules and the per-coin sent log (dedup survives restarts).
// Tables: auspex_bot_alert_rules, auspex_bot_alerts_sent (migrations/002_auspex_alerts.sql).
// If the tables don't exist yet the store falls back to memory and says so once.

import { normalizeFilters } from "./rules.js";

export function coinKey(chain, address) {
  return `${chain}:${chain === "solana" ? address : String(address).toLowerCase()}`;
}

export function createMemoryStore() {
  const rules = new Map();
  const sent = new Map(); // `${chatId}|${coinKey}` -> row
  return {
    kind: "memory",
    async listRules() { return [...rules.values()].map((r) => ({ ...r })); },
    async getRule(chatId) { const r = rules.get(String(chatId)); return r ? { ...r } : null; },
    async saveRule(rule) {
      const row = { ...rule, chatId: String(rule.chatId), filters: normalizeFilters(rule.filters), updatedAt: new Date().toISOString() };
      rules.set(row.chatId, row);
      return { ...row };
    },
    async recordSent(row) { sent.set(`${row.chatId}|${coinKey(row.chain, row.address)}`, { ...row }); },
    async loadSentSince(sinceIso) {
      return [...sent.values()].filter((r) => r.sentAt >= sinceIso);
    },
  };
}

function isMissingTable(error) {
  return error && (error.code === "42P01" || error.code === "PGRST205" || /does not exist|Could not find the table/i.test(error.message || ""));
}

export function createSupabaseStore(supabase, { log = console } = {}) {
  const mem = createMemoryStore();
  let fallback = false;
  const fall = (error) => {
    if (!fallback) log.warn?.(`[alerts] alert tables missing (${error.message}) — using in-memory rules; run migrations/002_auspex_alerts.sql`);
    fallback = true;
  };
  const fromRow = (r) => ({
    chatId: String(r.chat_id), enabled: !!r.enabled, filters: normalizeFilters(r.filters || {}),
    createdBy: r.created_by || null, chatTitle: r.chat_title || null, updatedAt: r.updated_at,
  });
  return {
    get kind() { return fallback ? "memory (tables missing)" : "supabase"; },
    async listRules() {
      if (fallback) return mem.listRules();
      const { data, error } = await supabase.from("auspex_bot_alert_rules").select("*").eq("enabled", true);
      if (error) { if (isMissingTable(error)) { fall(error); return mem.listRules(); } throw new Error(error.message); }
      return (data || []).map(fromRow);
    },
    async getRule(chatId) {
      if (fallback) return mem.getRule(chatId);
      const { data, error } = await supabase.from("auspex_bot_alert_rules").select("*").eq("chat_id", String(chatId)).maybeSingle();
      if (error) { if (isMissingTable(error)) { fall(error); return mem.getRule(chatId); } throw new Error(error.message); }
      return data ? fromRow(data) : null;
    },
    async saveRule(rule) {
      if (fallback) return mem.saveRule(rule);
      const row = {
        chat_id: String(rule.chatId), enabled: !!rule.enabled, filters: normalizeFilters(rule.filters),
        created_by: rule.createdBy ? String(rule.createdBy) : null, chat_title: rule.chatTitle || null, updated_at: new Date().toISOString(),
      };
      const { data, error } = await supabase.from("auspex_bot_alert_rules").upsert(row, { onConflict: "chat_id" }).select().single();
      if (error) { if (isMissingTable(error)) { fall(error); return mem.saveRule(rule); } throw new Error(error.message); }
      return fromRow(data);
    },
    async recordSent(r) {
      if (fallback) return mem.recordSent(r);
      const { error } = await supabase.from("auspex_bot_alerts_sent").upsert({
        chat_id: String(r.chatId), coin_key: coinKey(r.chain, r.address), chain: r.chain, address: r.address, kind: r.kind,
        primed: !!r.primed, message_id: r.messageId ?? null, sent_at: r.sentAt,
      }, { onConflict: "chat_id,coin_key" });
      if (error) { if (isMissingTable(error)) { fall(error); return mem.recordSent(r); } log.error?.("[alerts] recordSent failed:", error.message); }
    },
    async loadSentSince(sinceIso) {
      if (fallback) return mem.loadSentSince(sinceIso);
      const { data, error } = await supabase.from("auspex_bot_alerts_sent").select("chat_id,chain,address,kind,primed,sent_at").gte("sent_at", sinceIso).limit(50_000);
      if (error) { if (isMissingTable(error)) { fall(error); return mem.loadSentSince(sinceIso); } throw new Error(error.message); }
      return (data || []).map((r) => ({ chatId: String(r.chat_id), chain: r.chain, address: r.address, kind: r.kind, primed: r.primed, sentAt: r.sent_at }));
    },
  };
}
