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
 * Log a raw detected payment (before it's linked to a user).
 */
export async function logPayment({ chain, fromAddress, toAddress, amountUsd, txHash }) {
  const { error } = await supabase
    .from("vigil_payments")
    .upsert({
      chain,
      from_address: fromAddress,
      to_address:   toAddress,
      amount_usd:   amountUsd,
      tx_hash:      txHash,
      detected_at:  new Date().toISOString(),
    }, { onConflict: "tx_hash" });

  if (error) console.error("Failed to log payment:", error.message);
}

/**
 * Check if a tx hash has already been used to grant a subscription.
 */
export async function txAlreadyUsed(txHash) {
  const { data } = await supabase
    .from("vigil_subscribers")
    .select("telegram_id")
    .eq("paid_tx", txHash)
    .single();
  return Boolean(data);
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
