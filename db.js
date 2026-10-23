import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { config } from "./config.js";

// supabase-js >= 2.10x needs a WebSocket implementation on Node < 22 (it throws at createClient without
// one). The bot doesn't use Realtime, but the client is constructed anyway, so pass `ws`.
export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket },
});
