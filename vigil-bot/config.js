// ── Vigil Bot Config ────────────────────────────────────────────────────────

// Validate required env vars at startup
const required = ["BOT_TOKEN", "SUPABASE_URL", "SUPABASE_ANON_KEY", "CHANNEL_ID", "ELITE_CHANNEL_ID"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
}

export const config = {
  // Telegram
  BOT_TOKEN:          process.env.BOT_TOKEN,
  CHANNEL_ID:         process.env.CHANNEL_ID,        // standard channel
  ELITE_CHANNEL_ID:   process.env.ELITE_CHANNEL_ID,   // elite channel (top 30 calls forwarded here)
  FOLLOW_CHANNEL_ID:  process.env.FOLLOW_CHANNEL_ID,  // X follow alerts channel (optional)

  // Supabase
  SUPABASE_URL:       process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY:  process.env.SUPABASE_ANON_KEY,

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
