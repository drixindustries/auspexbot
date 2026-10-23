# Auspex Telegram bot

The Telegram side of **Auspex**. It reads the same Supabase cache the site reads (`auspex_signal_cache`, written by
[auspex-worker](https://github.com/drixindustries/auspex-worker)) and renders the site's badge set 1:1, so a coin
shows the same badges and verdict in Telegram as on [auspex-site](https://auspex-site.vercel.app). On top of that it
adds what only a bot can do: per-chat alert rules, subscriptions/payments, caller calls and leaderboard, channel
autopost, charts, and the smart-call and X-follow watchers.

## Commands

| Command | What it does |
|---|---|
| `/feed [solana\|base]` | Top signals from the Auspex cache with the site's badges |
| `/coin <CA>` (alias `/check`) | Full Auspex card for any coin on the board (signal / launch / graduation). Off-board CAs fall back to a live DexScreener + RugCheck (Solana) / GoPlus (Base) scan, like the site's CA scanner |
| `/launches`, `/grads` | Just launched (pump.fun / LetsBonk) and just graduated, with dev-reputation badges |
| `/paper` | Paper-trading results (same query and test-mode filtering as the site) |
| `/hof` | Hall of Fame |
| `/perf [kind\|score\|source\|badge\|chain]` | Signal performance, like the site's panel: N, hit +50%, 2×, rug rate, median 1h / 24h |
| `/alerts on\|off`, `/alerts`, `/filters` | Turn alerts on/off for this chat; show the rules and engine status |
| `/filter <key> <value>` | Change one rule, see below |
| `/call <CA>` | Tracked call, Solana or Base, posted with Auspex badges and scored at 24h |
| `/mystats`, `/leaderboard`, `/register`, `/verify @x`, `/verifypaid` | Caller accounts and rankings |
| `/start`, `/paid <tx>`, `/status` | $10/month subscription, USDC (Base/Solana) or SOL |
| `/addaccount`, `/removeaccount`, `/watchlist` | Owner only: X accounts for the follow watcher |

In groups only admins can change alerts.

### Alert rules (`/filter`)

| Key | Example | Meaning |
|---|---|---|
| `score` | `/filter score 70` | Min Auspex score (signals) |
| `chains` | `/filter chains solana` · `all` | Chains |
| `kinds` | `/filter kinds graduations` · `all` | signal / launch / graduation (default: signal, graduation) |
| `dev` | `/filter dev proven` · `promising` · `off` | Require a proven (or at least promising) dev. A good dev who is also on a bad list never passes (site rule: bad wins) |
| `rugsafe` | `/filter rugsafe on` | Require RugCheck tier SAFE |
| `liq` | `/filter liq 20k` | Min liquidity USD (launches have no liquidity yet, so they're dropped when this is set) |
| `providers` | `/filter providers 2` | Min providers confirming the same CA |
| `exclude` / `include` | `/filter exclude heuristic` · `rugdev` · `bad` · `none` | Flags: sanctioned, confirmed, suspected, heuristic, rugged, insiders, serial, danger. Default excludes sanctioned, confirmed, suspected, rugged, danger |
| `hitrate` | `/filter hitrate 40` · `off` | Min hit rate of the coin's cohort over the last 7 days. Hit means +50% before −50%, counted over resolved signals only, the same as the site's "Hit +50%". The cohort is the score band for board signals and the kind for launches and graduations. The rule is skipped, with a note, when there are no stats or the cohort has fewer than 10 resolved signals |
| `rate` | `/filter rate 5` | Max alerts per hour for this chat (1–60) |
| `reset` | `/filter reset` | Defaults |

Delivery rules: one alert per coin per chat per 24h (persisted, so restarts don't re-alert; a coin that's both a signal and a
graduation is one alert); per-chat hourly cap; Telegram pacing (~1 msg/s per chat, 25/s global; 429 → pause, 403 →
rule disabled); launches older than 15 min and graduations older than 60 min are never alerted; no alerts if the worker's
cache is more than 10 min old; turning alerts on (or changing a filter) marks current matches as seen, so there's no flood.
Every alert links to the coin on the site (`?chain=&ca=`) and DexScreener.

**Signal performance.** Alerts and `/coin` show the site's "since signal" chip from the row's `signalPerf` (e.g. `+42.0% since signal · 35m`), plus checkpoints, max up and drawdown. They also show a "Similar signals" line with the cohort's hit rate. Stats come from `payload.signalPerformance`, the worker's own aggregate. If that's missing, the bot reads `auspex_signal_outcomes` (last 7 days) and aggregates it with the worker's rules. If neither exists, the hit-rate parts are left out.

## Feature parity (bot ⇄ site ⇄ worker)

| Feature | Worker | Site | Bot (this branch) |
|---|---|---|---|
| Signal feed (score, providers ×N, sources) | computes | ✅ | ✅ `/feed`, autopost |
| RugCheck tier SAFE/CAUTION/DANGER + insights (rugged, insiders, serial launcher, knownAs) | ✅ | ✅ | ✅ same labels, parity-tested |
| Bad-actor badges (sanctioned / confirmed / suspected / heuristic) | ✅ | ✅ | ✅ same labels and order |
| Good dev (proven / promising, struck through if also bad) | ✅ | ✅ | ✅ |
| KOL buys, LunarCrush GS / AltRank / hype | ✅ | ✅ | ✅ |
| Just launched (wallet age, X age, bundle, metas) | ✅ | ✅ | ✅ `/launches` |
| Just graduated (venue, launchpad) | ✅ | ✅ | ✅ `/grads` |
| Market regime / active metas | ✅ | ✅ | ✅ in `/feed` |
| Paper trading | ✅ | ✅ | ✅ `/paper` |
| Hall of Fame | backfill | ✅ | ✅ `/hof` |
| CA scanner (DexScreener + RugCheck) | – | ✅ Solana, Base | ✅ `/coin` fallback (+ GoPlus for Base) |
| Signal performance: "since signal" chip, perf table | ✅ `signalPerf`, `signalPerformance` | ✅ | ✅ alerts / `/coin` / lists, `/perf`, `hitrate` rule (payload first, table fallback) |
| Alerts with user rules | – | ❌ | ✅ |
| Subscriptions / payments / channel access | – | ❌ | ✅ (payment checks hardened) |
| Caller calls, scoring, leaderboard, X verify | – | ❌ | ✅ (works for Solana now) |
| Charts | – | ❌ | ✅ (Base and Solana) |
| AI commentary / daily digest / anomaly watcher | – | ❌ | ✅ when `ANTHROPIC_API_KEY` is set |
| Smart-call watcher (CAs in source groups) | – | ❌ | ✅ gated on Auspex flags (Elfa retired) |
| X follow watcher | – | ❌ | ⚠️ needs paid X API; Nitter off |

## Proposed for removal (not deleted in this branch)

- **`vigil-bot/`**: an old duplicate of the root files that nothing imports.
- **`nitterScraper.js`**: every public Nitter instance was dead or redirecting in Oct 2026. It's off by default (`NITTER_FALLBACK`).
- **Elfa smart-stats (`elfaClient.js`)**: `/v2/account/smart-stats` is retired on 2026-10-28, and the bot stops calling it after that date. The v3 replacement only partly covers it, so the smart-call watcher now gates on Auspex flags instead.
- **GeckoTerminal-only Base trending autopost and `calcRugScore` cards**: replaced by Auspex signals and badges. `AUTOPOST_SOURCE=gecko` keeps the old post.

## Database

- `migrations/001_vigil_base.sql`: the bot's original tables (`vigil_*`, `augur_leaderboard` view).
- `migrations/002_auspex_alerts.sql`: `auspex_bot_alert_rules` (one row per chat: `filters` jsonb) and `auspex_bot_alerts_sent` (dedup log, PK `(chat_id, coin_key)`). RLS is on and there's no anon access. If these tables are missing, the bot uses in-memory rules and logs a warning.
- `migrations/003_lock_down_vigil_tables.sql`: removes 001's `using (true)` policies, which let anyone with the anon key read subscribers and payments and insert a free subscription. **Apply it only after the bot runs with `SUPABASE_SERVICE_KEY`.**
- Reads, with the anon key, the same tables the site reads: `auspex_signal_cache`, `auspex_paper_trades` and `auspex_hall_of_fame`. It reads `auspex_signal_outcomes` only as a fallback for stats, and for the "since signal" view of a coin whose payload row has none.

## Development

```bash
npm install
npm test               # unit tests (node:test)
npm run lint           # eslint
npm run test:parity    # site badge renderers + "since signal" chip (AUSPEX_SITE_HTML=auspex-site/index.html) and the
                       # worker's aggregate()/sinceSignal() (AUSPEX_WORKER_SIGNAL_OUTCOMES=auspex-worker/lib/signal-outcomes.js)
npm run e2e            # local Postgres+PostgREST and a mock Telegram API, see scripts/e2e/run.mjs
```

The E2E run refuses any non-localhost target. It seeds the real worker payload and synthetic coins, drives the commands as Telegram users, adds new coins, and checks which alerts are sent and which are held back (filtered, duplicate, rate-limited). It also checks the hit-rate rule before and after `auspex_signal_outcomes` exists, and migration 003. The transcript is written to `.e2e/transcript.md`.

Requires Node ≥ 20. supabase-js needs a WebSocket implementation on Node 20, so the bot passes `ws`.
