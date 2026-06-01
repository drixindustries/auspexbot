-- Run this in your Supabase SQL editor

-- Subscribers table
create table if not exists vigil_subscribers (
  telegram_id        text primary key,
  telegram_username  text,
  paid_chain         text not null,
  paid_tx            text not null,
  paid_amount        numeric,
  subscribed_at      timestamptz not null default now(),
  expires_at         timestamptz not null,
  active             boolean not null default true
);

create index if not exists vigil_subscribers_active_idx
  on vigil_subscribers(active, expires_at);

create index if not exists vigil_subscribers_tx_idx
  on vigil_subscribers(paid_tx);

-- Payments log table
create table if not exists vigil_payments (
  id           uuid primary key default gen_random_uuid(),
  chain        text not null,
  from_address text,
  to_address   text,
  amount_usd   numeric,
  tx_hash      text unique not null,
  detected_at  timestamptz not null default now(),
  telegram_id  text
);

create index if not exists vigil_payments_tx_idx on vigil_payments(tx_hash);

-- RLS
alter table vigil_subscribers enable row level security;
alter table vigil_payments     enable row level security;

-- Only service role (your bot's anon key) can read/write
-- For tighter security, use a service_role key instead of anon key in production
create policy "vigil_subscribers_all" on vigil_subscribers for all using (true);
create policy "vigil_payments_all"    on vigil_payments    for all using (true);

-- ── Caller ranking tables ──────────────────────────────────────────────────

create table if not exists vigil_callers (
  telegram_id        text primary key,
  telegram_username  text,
  composite_score    integer not null default 0,
  rank               integer,
  total_calls        integer not null default 0,
  scored_calls       integer not null default 0,
  wins               integer not null default 0,
  avg_return         numeric not null default 0,
  is_elite           boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists vigil_callers_score_idx
  on vigil_callers(composite_score desc);

create table if not exists vigil_calls (
  id              uuid primary key default gen_random_uuid(),
  telegram_id     text not null references vigil_callers(telegram_id),
  token_address   text not null,
  token_name      text,
  token_symbol    text,
  price_at_call   numeric not null,
  price_24h       numeric,
  return_pct      numeric,
  is_win          boolean,
  called_at       timestamptz not null default now(),
  scored_at       timestamptz,
  message_id      bigint,
  chat_id         text
);

create index if not exists vigil_calls_telegram_idx  on vigil_calls(telegram_id);
create index if not exists vigil_calls_scored_idx    on vigil_calls(scored_at) where scored_at is null;
create index if not exists vigil_calls_called_at_idx on vigil_calls(called_at);

-- RLS
alter table vigil_callers enable row level security;
alter table vigil_calls    enable row level security;

create policy "vigil_callers_all" on vigil_callers for all using (true);
create policy "vigil_calls_all"   on vigil_calls   for all using (true);

-- total_calls is incremented directly via the Supabase JS client update()

-- ── X Follow Watcher tables ────────────────────────────────────────────────

create table if not exists vigil_watched_accounts (
  handle        text primary key,
  x_user_id     text,
  display_name  text not null,
  added_by      text,
  added_at      timestamptz not null default now()
);

create table if not exists vigil_following_snapshots (
  id               uuid primary key default gen_random_uuid(),
  watched_handle   text not null references vigil_watched_accounts(handle) on delete cascade,
  following_handle text not null,
  following_x_id   text,
  following_name   text,
  first_seen_at    timestamptz not null default now(),
  is_initial       boolean not null default false,
  unique (watched_handle, following_handle)
);

create index if not exists vigil_snapshots_watched_idx
  on vigil_following_snapshots(watched_handle);

alter table vigil_watched_accounts    enable row level security;
alter table vigil_following_snapshots enable row level security;

create policy "vigil_watched_all"    on vigil_watched_accounts    for all using (true);
create policy "vigil_snapshots_all"  on vigil_following_snapshots for all using (true);

-- ── Smart follower weight columns ─────────────────────────────────────────
-- Add to vigil_callers if not already present

alter table vigil_callers
  add column if not exists elfa_smart_followers integer not null default 0,
  add column if not exists elfa_smart_score     integer not null default 0,
  add column if not exists x_username           text,
  add column if not exists elfa_fetched_at      timestamptz;

-- ── Augur public caller tracking ──────────────────────────────────────────

alter table vigil_callers
  add column if not exists is_registered   boolean not null default false,
  add column if not exists is_verified     boolean not null default false,
  add column if not exists verify_paid_at  timestamptz,
  add column if not exists registered_at   timestamptz;

-- Public leaderboard view — only verified callers with enough calls
create or replace view augur_leaderboard as
  select
    telegram_id, telegram_username, x_username,
    composite_score, rank, scored_calls, wins, avg_return,
    is_elite, elfa_smart_followers, elfa_smart_score, updated_at
  from vigil_callers
  where is_verified = true
    and scored_calls >= 5
  order by composite_score desc;
