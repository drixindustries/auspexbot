// ── Auspex Telegram bot config ──────────────────────────────────────────────

const flag = (v, dflt) => (v == null || v === "" ? dflt : /^(1|true|yes|on)$/i.test(String(v)));

// Validate required env vars at startup. ELITE_CHANNEL_ID used to be required here even though it was
// missing from .env.example, so a fresh deploy exited immediately; it is optional now.
const required = ["BOT_TOKEN", "SUPABASE_URL", "CHANNEL_ID"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
}
if (!process.env.SUPABASE_SERVICE_KEY && !process.env.SUPABASE_ANON_KEY) {
  console.error("❌ Missing SUPABASE_SERVICE_KEY (preferred) or SUPABASE_ANON_KEY");
  process.exit(1);
}

export const config = {
  // Telegram
  BOT_TOKEN:          process.env.BOT_TOKEN,
  TELEGRAM_API_ROOT:  process.env.TELEGRAM_API_ROOT || "https://api.telegram.org", // point at a mock for local tests
  CHANNEL_ID:         process.env.CHANNEL_ID,        // standard channel
  ELITE_CHANNEL_ID:   process.env.ELITE_CHANNEL_ID || null, // elite channel (top 30 callers' calls), optional
  FOLLOW_CHANNEL_ID:  process.env.FOLLOW_CHANNEL_ID,  // X follow alerts channel (optional)
  OWNER_TELEGRAM_ID:  process.env.OWNER_TELEGRAM_ID || null,

  // Bot's own Supabase tables (vigil_*, auspex_bot_*). The service_role key is preferred: the vigil_*
  // tables' original policies let the anon key read/write everything (see migrations/003).
  SUPABASE_URL:       process.env.SUPABASE_URL,
  SUPABASE_KEY:       process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
  SUPABASE_KEY_ROLE:  process.env.SUPABASE_SERVICE_KEY ? "service_role" : "anon",

  // Auspex data (the worker's cache the site reads). Defaults to the bot's own project; set these if the
  // bot's tables live in a different Supabase project than the site (qwykkcsyoghljgndnvaz).
  AUSPEX_SUPABASE_URL: process.env.AUSPEX_SUPABASE_URL || process.env.SUPABASE_URL,
  AUSPEX_SUPABASE_KEY: process.env.AUSPEX_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY,
  AUSPEX_SITE_URL:     process.env.AUSPEX_SITE_URL || "https://auspex-site.vercel.app",

  // Alerts
  ALERTS_ENABLED:              flag(process.env.ALERTS_ENABLED, true),
  ALERTS_REQUIRE_SUBSCRIPTION: flag(process.env.ALERTS_REQUIRE_SUBSCRIPTION, true),
  ALERT_POLL_MS:               Number(process.env.ALERT_POLL_MS) || 60_000,

  // Channel posts: "auspex" = top signals from the Auspex cache (same as the site); "gecko" = old Base trending
  AUTOPOST_SOURCE:    (process.env.AUTOPOST_SOURCE || "auspex").toLowerCase(),
  NITTER_FALLBACK:    flag(process.env.NITTER_FALLBACK, false), // all public Nitter instances were dead in Oct 2026
  ANTHROPIC_MODEL:    process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",

  // RPC
  ALCHEMY_BASE_URL:   process.env.ALCHEMY_BASE_URL || "https://mainnet.base.org",
  HELIUS_API_KEY:     process.env.HELIUS_API_KEY || null,

  // Payment receive addresses (YOUR wallets — set in env)
  BASE_RECEIVE_ADDR:    process.env.BASE_RECEIVE_ADDR,   // 0x...
  SOLANA_RECEIVE_ADDR:  process.env.SOLANA_RECEIVE_ADDR, // base58...

  // Payment config
  PRICE_USD:          10,           // $10/month
  MIN_USDC_RAW:       9_500_000,    // $9.50 minimum (6 decimals) — allows minor slippage
  MIN_SOL_USD:        9.50,         // minimum SOL payment in USD equivalent
  SUB_DAYS:           30,           // subscription length in days
  PAYMENT_MAX_AGE_DAYS: Number(process.env.PAYMENT_MAX_AGE_DAYS) || 3, // older txs can't be claimed (replay guard)

  // USDC contract addresses
  USDC_BASE:    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  USDC_SOLANA:  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",

  // Transfer topic (ERC-20)
  TRANSFER_TOPIC: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",

  // Auto-post schedule
  POST_INTERVAL_HOURS: 4,           // post top tokens every 4 hours
  POST_TOKEN_COUNT:    5,           // number of tokens per post

  // Poll interval for payment detection
  PAYMENT_POLL_MS: 30_000,          // check for new payments every 30s
};
