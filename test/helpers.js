// Tests import modules that read config at import time; give them a harmless local env first.
export function testEnv() {
  Object.assign(process.env, {
    BOT_TOKEN: process.env.BOT_TOKEN || "123:test",
    SUPABASE_URL: process.env.SUPABASE_URL || "http://127.0.0.1:9",
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "test-anon",
    CHANNEL_ID: process.env.CHANNEL_ID || "-1001",
    BASE_RECEIVE_ADDR: "0x000000000000000000000000000000000000dEaD",
    SOLANA_RECEIVE_ADDR: "Recv1111111111111111111111111111111111111111",
  });
}
export const silent = { log() {}, warn() {}, error() {} };
