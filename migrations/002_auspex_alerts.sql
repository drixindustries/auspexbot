-- =====================================================================================================
-- 002 — Auspex Telegram alerts (feat/unify-with-auspex)
-- Apply in the Supabase project the bot's SUPABASE_URL points at. Recommended: the same project the site
-- and worker use (qwykkcsyoghljgndnvaz), so the bot reads the worker's cache from the same database.
-- Safe to re-run.
-- =====================================================================================================

-- One row per Telegram chat (DM or group) that has alerts configured.
-- filters is JSON so new filters don't need a migration; the bot normalises/clamps it (lib/rules.js):
--   { kinds[], chains[], minScore, minLiquidityUsd, minProviders, requireDev, requireRugSafe,
--     exclude[], minHitRate, maxPerHour }
create table if not exists public.auspex_bot_alert_rules (
  chat_id     text        primary key,
  enabled     boolean     not null default false,
  filters     jsonb       not null default '{}'::jsonb,
  created_by  text,                    -- Telegram user id that configured it (subscription check)
  chat_title  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists auspex_bot_alert_rules_enabled_idx on public.auspex_bot_alert_rules (enabled) where enabled;

-- Per-chat, per-coin sent log: dedup survives restarts. coin_key = "<chain>:<address>" with EVM lower-cased
-- and Solana in original case (same convention as the worker). primed = marked seen when alerts were
-- enabled (not actually sent), so turning alerts on doesn't flood the chat with everything on the board.
create table if not exists public.auspex_bot_alerts_sent (
  chat_id     text        not null,
  coin_key    text        not null,
  chain       text        not null,
  address     text        not null,
  kind        text        not null check (kind in ('signal', 'launch', 'graduation')),
  primed      boolean     not null default false,
  message_id  bigint,
  sent_at     timestamptz not null default now(),
  primary key (chat_id, coin_key)
);
create index if not exists auspex_bot_alerts_sent_sent_at_idx on public.auspex_bot_alerts_sent (sent_at desc);

-- Housekeeping (optional, e.g. daily via pg_cron): rows older than the 24h dedup window aren't needed.
-- delete from public.auspex_bot_alerts_sent where sent_at < now() - interval '7 days';

-- Service role only (the bot). Nothing here is readable or writable with the public anon key.
alter table public.auspex_bot_alert_rules enable row level security;
alter table public.auspex_bot_alerts_sent enable row level security;
revoke all on public.auspex_bot_alert_rules, public.auspex_bot_alerts_sent from anon, authenticated;
