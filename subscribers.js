import { supabase } from "./db.js";
import { config } from "./config.js";

/**
 * Check if a telegram user has an active subscription.
 */
export async function isSubscribed(telegramId) {
  const { data, error } = await supabase
    .from("vigil_subscribers")
    .select("expires_at, active")
    .eq("telegram_id", String(telegramId))
    .single();

  if (error || !data) return false;
  if (!data.active) return false;
  return new Date(data.expires_at) > new Date();
}

/**
 * Create or renew a subscription after payment is verified.
 */
export async function grantSubscription({ telegramId, telegramUsername, chain, txHash, amountUsd }) {
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + config.SUB_DAYS * 24 * 60 * 60 * 1000);

  const { error } = await supabase
    .from("vigil_subscribers")
    .upsert({
      telegram_id:       String(telegramId),
      telegram_username: telegramUsername || null,
      paid_chain:        chain,
      paid_tx:           txHash,
      paid_amount:       amountUsd,
      subscribed_at:     now.toISOString(),
      expires_at:        expiresAt.toISOString(),
      active:            true,
    }, { onConflict: "telegram_id" });

  if (error) throw new Error(`Failed to grant subscription: ${error.message}`);
  return expiresAt;
}

/**
 * Atomically claim a payment tx for one Telegram user. vigil_payments.tx_hash is UNIQUE, so the first
 * claim wins and any replay (same tx for another user, or for /paid and /verifypaid) is refused.
 * Previously logPayment was never called and txAlreadyUsed only looked at vigil_subscribers.paid_tx,
 * which is overwritten on renewal — so an old tx could be reused. Returns true if this call claimed it.
 */
export async function claimPayment({ telegramId, chain, fromAddress, toAddress, amountUsd, txHash }) {
  const { error } = await supabase
    .from("vigil_payments")
    .insert({
      chain,
      from_address: fromAddress || null,
      to_address:   toAddress || null,
      amount_usd:   amountUsd,
      tx_hash:      txHash,
      telegram_id:  String(telegramId),
      detected_at:  new Date().toISOString(),
    });
  if (!error) return true;
  if (error.code === "23505" || /duplicate key/i.test(error.message || "")) return false;
  throw new Error(`Failed to record payment: ${error.message}`);
}

/** Back-compat alias kept for callers outside this repo. */
export async function logPayment(p) {
  try { await claimPayment(p); } catch (e) { console.error("Failed to log payment:", e.message); }
}

/**
 * Check if a tx hash has already been used (payments ledger or a subscriber's latest paid_tx).
 */
export async function txAlreadyUsed(txHash) {
  const [{ data: pay }, { data: sub }] = await Promise.all([
    supabase.from("vigil_payments").select("tx_hash").eq("tx_hash", txHash).limit(1),
    supabase.from("vigil_subscribers").select("telegram_id").eq("paid_tx", txHash).limit(1),
  ]);
  return Boolean((pay && pay.length) || (sub && sub.length));
}

/**
 * Get all subscribers whose subscription has expired.
 */
export async function getExpiredSubscribers() {
  const { data, error } = await supabase
    .from("vigil_subscribers")
    .select("telegram_id")
    .eq("active", true)
    .lt("expires_at", new Date().toISOString());

  if (error) return [];
  return data || [];
}

/**
 * Mark a subscriber as inactive (expired/kicked).
 */
export async function deactivateSubscriber(telegramId) {
  await supabase
    .from("vigil_subscribers")
    .update({ active: false })
    .eq("telegram_id", String(telegramId));
}
