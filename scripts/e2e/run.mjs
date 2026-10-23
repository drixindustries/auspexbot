// End-to-end run of the bot against a LOCAL Supabase stand-in (Postgres + PostgREST) and a MOCK Telegram API.
// Nothing here talks to production: it refuses to run unless every URL is localhost.
//
//   E2E_REST=http://127.0.0.1:56431            local /rest/v1 gateway in front of PostgREST
//   E2E_SERVICE_JWT=... E2E_ANON_JWT=...       JWTs signed with the LOCAL PostgREST secret
//   E2E_PG=postgresql://postgres@127.0.0.1:56432/auspex_unify   (for DDL: outcomes table, migration 003)
//   E2E_MOCK_PORT=56441
//
// Seeds the real worker payload (test/fixtures) + synthetic coins, drives commands as Telegram users, injects
// new coins into the cache and checks which alerts go out and which are held back (filtered/duplicate/rate).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPayload, ADDR } from "../../test/fixtures/synthetic.js";
import { validateMarkdownV2 } from "../../lib/md.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, ".e2e");
fs.mkdirSync(OUT, { recursive: true });
const REST = process.env.E2E_REST || "http://127.0.0.1:56431";
const SERVICE = process.env.E2E_SERVICE_JWT;
const ANON = process.env.E2E_ANON_JWT;
const PG = process.env.E2E_PG || "postgresql://postgres@127.0.0.1:56432/auspex_unify";
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT || 56441);
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
for (const u of [REST, PG, MOCK]) if (!/(127\.0\.0\.1|localhost)/.test(u)) throw new Error(`refusing non-local target ${u}`);
if (!SERVICE || !ANON) throw new Error("set E2E_SERVICE_JWT and E2E_ANON_JWT (local PostgREST secret)");
process.env.MOCK_TG = MOCK;
const { say, sent, summarize, sleep } = await import("./client.mjs");

const DM = 501, OWNER = 501, STRANGER = 888, GROUP = -2001, MEMBER = 777;
const transcript = [];
const failures = [];
const check = (cond, msg) => { (cond ? null : failures.push(msg)); transcript.push(`${cond ? "✅" : "❌"} CHECK: ${msg}`); };
const log = (s) => { transcript.push(s); console.log(s); };

// ── local PostgREST helpers ───────────────────────────────────────────────
async function rest(method, p, body, { key = SERVICE, prefer } = {}) {
  const res = await fetch(`${REST}/rest/v1/${p}`, { method, headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", ...(prefer ? { Prefer: prefer } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const psql = (sql) => execFileSync("psql", [PG, "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql], { encoding: "utf8" });
let payload;
async function writeCache(p) {
  payload = p;
  payload.generatedAt = new Date().toISOString();
  const r = await rest("POST", "auspex_signal_cache?on_conflict=id", { id: "latest", payload, updated_at: new Date().toISOString() }, { prefer: "resolution=merge-duplicates" });
  if (r.status >= 300) throw new Error("cache write failed " + JSON.stringify(r.body));
}

// ── fresh synthetic coins (timestamps = now, so they pass freshness) ─────
let n = 0;
const fake = (tag) => { n += 1; const b58 = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789"; let s = tag; while (s.length < 40) s += b58[(s.length * 7 + n) % b58.length]; return s.slice(0, 40) + "pump"; };
const now = () => new Date().toISOString();
const proven = { tier: "proven", confidence: 0.8, knownLaunches: 5, winners: [{ mint: fake("W1n"), symbol: "OLDWIN", marketCapUsd: 3_100_000, type: "PRIOR_WINNER" }, { mint: fake("W2n"), symbol: "OLDWIN2", marketCapUsd: 420_000, type: "GRADUATED_HELD" }] };
const promising = { tier: "promising", confidence: 0.5, knownLaunches: 2, winners: [{ mint: fake("W3n"), symbol: "ONEWIN", marketCapUsd: 140_000, type: "PRIOR_WINNER" }] };
const heur = { sourceId: "allenhark", kind: "heuristic", label: "AllenHark blacklist (automated heuristic, unverified)", reason: "automated heuristic", listedAt: "2026-02-17T00:00:00Z" };
const sanc = { sourceId: "ofac-sol", kind: "sanctioned", label: "OFAC SDN (Solana)", reason: "OFAC SDN list", listedAt: "2025-01-01T00:00:00Z" };
function addSignal(p, { chain = "solana", addr, sym, score, liq, good = null, bad = [], tier = "safe", providers = 2 }) {
  (p.chainGroups[chain] = p.chainGroups[chain] || []).unshift({ chainId: chain, tokenAddress: addr, name: sym + " Token", symbol: sym, score, liquidityUsd: liq, marketCapUsd: liq * 9, change24h: 64, change1h: 8, volume24h: liq * 4, sources: ["DEX", "GT"].slice(0, providers), providerCount: providers, firstSeenAt: now(), firstSeenMcapUsd: liq * 7, priceUsd: "0.0012" });
  if (tier) p.rugSafety[addr] = { tier, riskScore: tier === "safe" ? 9 : 70, risks: [], checkedAt: now(), insights: { rugged: false, creator: "Cr" + addr.slice(2, 40), insidersDetected: 0, insiderNetworks: 0 } };
  if (good || bad.length) p.signalCreatorFlags[`${chain}:${chain === "solana" ? addr : addr.toLowerCase()}`] = { creator: "Cr" + addr.slice(2, 40), bad, good };
}
function addLaunch(p, { addr, sym, good = null, bad = [] }) {
  p.justLaunched.unshift({ mint: addr, name: sym + " Launch", symbol: sym, launchpad: "pump.fun", creator: "Cr" + addr.slice(2, 40), marketCapSol: 30, launchedAt: now(), isBadActor: bad.length > 0, badActorMatches: bad, devReputation: { bad, good }, creatorWallet: { ageLabel: "established", txCount: 80 }, bundleCheck: { riskLabel: "low", totalBuys: 9, uniqueBuyers: 9, windowSec: 20 }, matchedMetas: [] });
}
function addGrad(p, { addr, sym, good = null, bad = [], liq = 40_000, tier = "safe" }) {
  p.justGraduated.unshift({ mint: addr, name: sym + " Grad", symbol: sym, pool: "pump-amm", venue: "PumpSwap", launchpad: "pump.fun", creator: "Cr" + addr.slice(2, 40), graduatedAt: now(), rugSafety: { tier, riskScore: 10, risks: [], checkedAt: now(), insights: { rugged: false, insidersDetected: 1, insiderNetworks: 1, liquidityUsd: liq } }, devReputation: { bad, good } });
}
const cloneP = () => structuredClone(payload);

// ── bot process ───────────────────────────────────────────────────────────
function startMock() {
  const m = spawn(process.execPath, [path.join(ROOT, "scripts/e2e/mockTelegram.mjs"), String(MOCK_PORT)], { env: { ...process.env, MOCK_ADMIN_ID: String(OWNER) }, stdio: ["ignore", fs.openSync(path.join(OUT, "mock.log"), "w"), "inherit"] });
  return m;
}
function startBot() {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    BOT_TOKEN: "123456:MOCK", TELEGRAM_API_ROOT: MOCK, CHANNEL_ID: "-1001", OWNER_TELEGRAM_ID: String(OWNER),
    SUPABASE_URL: REST, SUPABASE_SERVICE_KEY: SERVICE, AUSPEX_SUPABASE_ANON_KEY: ANON, AUSPEX_SITE_URL: "https://auspex-site.vercel.app",
    ALERTS_ENABLED: "1", ALERTS_REQUIRE_SUBSCRIPTION: "1", ALERT_POLL_MS: "2000", ALERTS_DEBUG: "1", OUTCOMES_TTL_MS: "1500",
    DISABLE_CRONS: "1", BASE_RECEIVE_ADDR: "0x000000000000000000000000000000000000dEaD", SOLANA_RECEIVE_ADDR: "11111111111111111111111111111111",
  };
  const bot = spawn(process.execPath, [path.join(ROOT, "index.js")], { cwd: ROOT, env, stdio: ["ignore", fs.openSync(path.join(OUT, "bot.log"), "w"), fs.openSync(path.join(OUT, "bot.err.log"), "w")] });
  return bot;
}
const alertsTo = async (chatId, sinceIdx) => (await sent()).slice(sinceIdx).filter((c) => c.method === "sendMessage" && String(c.chat_id) === String(chatId) && /Signals, not advice/.test(c.text || "") && !!c.reply_markup);
const sentCount = async () => (await sent()).length;
async function waitTicks(ms = 5000) { await sleep(ms); }
async function cmd(text, opts = {}) {
  const calls = await say(text, { settleMs: 20000, ...opts });
  log(`\n>>> ${opts.chatType === "group" ? `[group ${opts.chatId}] ` : ""}${opts.userId && opts.userId !== DM ? `(user ${opts.userId}) ` : ""}${text}\n${summarize(calls) || "(no reply)"}`);
  check(calls.every((c) => !c.rejected), `${text}: Telegram accepted every message (valid MarkdownV2)`);
  return calls;
}

// ── run ───────────────────────────────────────────────────────────────────
const mock = startMock();
await sleep(600);
let bot;
try {
  // clean slate in the LOCAL db
  psql("truncate auspex_bot_alert_rules, auspex_bot_alerts_sent, vigil_subscribers, vigil_payments, vigil_calls, vigil_callers cascade; truncate auspex_paper_trades, auspex_hall_of_fame restart identity cascade; drop table if exists auspex_signal_outcomes;");
  // restore 001's original (permissive) policies so the lock-down step below is reproducible on re-runs
  const T = { vigil_subscribers: "vigil_subscribers_all", vigil_payments: "vigil_payments_all", vigil_callers: "vigil_callers_all", vigil_calls: "vigil_calls_all", vigil_watched_accounts: "vigil_watched_all", vigil_following_snapshots: "vigil_snapshots_all" };
  psql(Object.entries(T).map(([t, pol]) => `drop policy if exists "${pol}" on ${t}; create policy "${pol}" on ${t} for all using (true); grant all on ${t} to anon, authenticated;`).join("\n") + " notify pgrst, 'reload schema';");
  await writeCache(buildPayload(Date.now()));
  for (const row of [
    { mint: ADDR.safeGrad, name: "Safe Grad", symbol: "SGRAD", entry_mcap_sol: 31, outcome: "graduated", status: "closed", final_pnl_pct: 142.5, entry_features: { walletAgeLabel: "established", precedent: { winRate: 38, sampleSize: 21 } }, snapshots: [] },
    { mint: ADDR.promisingLaunch, name: "Promising Panda", symbol: "PPAN", entry_mcap_sol: 30, outcome: null, status: "open", snapshots: [{ type: "checkpoint", atMinutes: 60, pnlPctFromGraduation: 12.2 }] },
    { mint: ADDR.staleLaunch, name: "Stale Launch", symbol: "STALE", entry_mcap_sol: 29, outcome: "no_graduation_timeout", status: "closed", final_pnl_pct: -100 },
    { mint: "TestMode111", name: "test row", symbol: "TEST", status: "closed", test_mode: true, final_pnl_pct: 999 },
  ]) {
    const r = await rest("POST", "auspex_paper_trades", row);
    if (r.status >= 300) throw new Error("paper seed failed " + JSON.stringify(r.body));
  }
  await rest("POST", "auspex_hall_of_fame", [
    { mint: "9MjAmgHXbu5drkNa9HpjGG5mhSkyA2NNTcaFN6Mfpump", name: "Fartcoin", symbol: "FARTCOIN", peak_mcap_usd: 2_500_000_000, current_mcap_usd: 900_000_000, source: "e2e seed" },
    { mint: "ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY", name: "Moo Deng", symbol: "MOODENG", peak_mcap_usd: 690_000_000, current_mcap_usd: 120_000_000, source: "e2e seed" },
  ]);
  await rest("POST", "vigil_subscribers", { telegram_id: String(DM), telegram_username: "drix_test", paid_chain: "e2e", paid_tx: "e2e-seed", paid_amount: 10, expires_at: new Date(Date.now() + 30 * 86400e3).toISOString(), active: true });

  bot = startBot();
  for (let i = 0; i < 40 && !(await sent()).some((c) => c.method === "getUpdates"); i++) await sleep(250);
  log("# Auspex bot E2E — " + new Date().toISOString());

  // 1. commands
  log("\n## 1. Commands");
  const helpCalls = await cmd("/help");
  check(/\/alerts/.test(helpCalls[0]?.text || ""), "/help lists the alert commands");
  await cmd("/status");
  const feed = await cmd("/feed");
  check(/PROVEN DEV/.test(feed[0]?.text || "") && /RUG DEV/.test(feed[0]?.text || ""), "/feed shows the site's badges");
  await cmd("/feed base");
  const card = await cmd(`/coin ${ADDR.ruggerSignal}`);
  check(card.some((c) => /RUG DEV · CONFIRMED/.test(c.text || "") && /~⭐ PROMISING DEV/.test(c.text || "")), "/coin: bad flag leads, good-dev badge struck through (site rule)");
  check(card.some((c) => JSON.stringify(c.reply_markup || {}).includes("ca=" + ADDR.ruggerSignal)), "/coin links to the coin on the site");
  await cmd(`/coin ${ADDR.safeGrad}`);
  await cmd(`/check ${ADDR.heuristicLaunch}`);
  await cmd("/launches");
  await cmd("/grads");
  const paper = await cmd("/paper");
  check(/3 tracked/.test(paper[0]?.text || "") && !/999|test row/.test(paper[0]?.text || ""), "/paper shows the 3 real trades and hides the test_mode one, like the site");
  await cmd("/hof");
  await cmd("/register");
  const call = await cmd("/call 6LGGCwCUHDvcipZNtqWrb4MRtsPygNGbUx1df7LYpump"); // real Solana token on the board (ODIE): live DexScreener price
  check(call.some((c) => String(c.chat_id) === "-1001" && /ODIE/i.test(c.text || c.caption || "")), "/call works for a Solana CA (was Base-only) and posts to the channel with Auspex badges");
  await cmd("/mystats");
  await cmd("/leaderboard");
  await cmd("/watchlist", { userId: STRANGER });

  // 2. alert rules
  log("\n## 2. Alert rules (DM, subscriber)");
  await cmd("/filters");
  await cmd("/filter kinds all");
  await cmd("/filter dev promising");
  await cmd("/filter liq 20k");
  await cmd("/filter exclude heuristic");
  await cmd("/filter rate 60");
  await cmd("/filter hitrate 60");
  await cmd("/filter chains eth");
  const on = await cmd("/alerts on");
  check(/match right now/.test(on[0]?.text || ""), "/alerts on primes current matches (no flood)");
  await cmd("/alerts on", { userId: STRANGER });
  await waitTicks(4500);
  let mark = await sentCount();
  check((await alertsTo(DM, 0)).length === 0, "no alerts for coins that were already on the board when alerts were enabled");

  log("\n## 3. New coins appear in the worker cache");
  const A = { grad: fake("NewGrad"), sig: fake("NewSig"), heur: fake("HeurDev"), sanc: fake("SancDev"), thin: fake("ThinLiq"), nodev: fake("NoDev"), launch: fake("PromLaunch") };
  let p = cloneP();
  addGrad(p, { addr: A.grad, sym: "NGRAD", good: proven });
  addSignal(p, { addr: A.grad, sym: "NGRAD", score: 77, liq: 40_000, good: proven }); // same coin also a signal → one alert
  addSignal(p, { addr: A.sig, sym: "NSIG", score: 85, liq: 90_000, good: promising });
  addLaunch(p, { addr: A.heur, sym: "HEURD", good: promising, bad: [heur] });
  addLaunch(p, { addr: A.sanc, sym: "SANCD", good: proven, bad: [sanc] });
  addSignal(p, { addr: A.thin, sym: "THIN2", score: 80, liq: 5_000, good: proven });
  addSignal(p, { addr: A.nodev, sym: "NODEV", score: 95, liq: 150_000 });
  addLaunch(p, { addr: A.launch, sym: "PLNCH", good: promising });
  await writeCache(p);
  await waitTicks(6000);
  const got = await alertsTo(DM, mark);
  const syms = got.map((c) => (c.text.match(/\$([A-Z0-9]+)/) || [])[1]);
  log("\nAlerts delivered to the DM: " + JSON.stringify(syms));
  for (const c of got) log("\n--- alert ---\n" + c.text + "\n[buttons] " + JSON.stringify(c.reply_markup?.inline_keyboard));
  check(syms.includes("NGRAD") && syms.includes("NSIG"), "matching coins alerted (proven-dev graduation, promising-dev signal)");
  check(syms.filter((s) => s === "NGRAD").length === 1, "coin that is both graduation and signal alerted once");
  for (const s of ["HEURD", "SANCD", "THIN2", "NODEV", "PLNCH"]) check(!syms.includes(s), `${s} suppressed by the rules`);
  check(got.every((c) => JSON.stringify(c.reply_markup).includes("auspex-site.vercel.app/?chain=")), "every alert links to the coin on the site");
  check(got.every((c) => validateMarkdownV2(c.text).length === 0), "alerts are valid MarkdownV2");

  mark = await sentCount();
  p = cloneP(); await writeCache(p); // worker rewrites the same coins
  await waitTicks(5000);
  check((await alertsTo(DM, mark)).length === 0, "duplicates suppressed on the next worker refresh");

  // 4. group: admin-only config + rate limit
  log("\n## 4. Group chat: admin-only config, per-chat rate limit");
  await cmd("/filter score 0", { chatType: "group", chatId: GROUP, userId: MEMBER });
  await cmd("/filter rate 2", { chatType: "group", chatId: GROUP, userId: OWNER });
  await cmd("/filter score 50", { chatType: "group", chatId: GROUP, userId: OWNER });
  await cmd("/alerts on", { chatType: "group", chatId: GROUP, userId: OWNER });
  await waitTicks(3000);
  mark = await sentCount();
  p = cloneP();
  const burst = ["BRSTA", "BRSTB", "BRSTC", "BRSTD", "BRSTE"].map((s, i) => ({ s, a: fake("Burst" + i) }));
  burst.forEach(({ s, a }, i) => addSignal(p, { addr: a, sym: s, score: 70 + i, liq: 50_000 }));
  await writeCache(p);
  await waitTicks(7000);
  const g = await alertsTo(GROUP, mark);
  log("Group alerts: " + JSON.stringify(g.map((c) => (c.text.match(/\$([A-Z0-9]+)/) || [])[1])));
  check(g.length === 2, `group rate limit: 2 of 5 burst coins sent this hour (got ${g.length})`);
  check((await alertsTo(DM, mark)).length === 0, "the burst (no dev record) is suppressed for the DM rule");

  // 5. performance stats (auspex_signal_outcomes) appear → hit-rate rule kicks in
  log("\n## 5. auspex_signal_outcomes appears (other PR) → hit-rate filter");
  psql(`create table auspex_signal_outcomes (id bigserial primary key, chain_id text, token_address text, kind text, first_seen_score numeric, return_24h_pct numeric, created_at timestamptz default now());
        grant select on auspex_signal_outcomes to anon;
        insert into auspex_signal_outcomes (chain_id, kind, first_seen_score, return_24h_pct)
          select 'solana','signal', 92, case when g < 15 then 40 else -20 end from generate_series(1,20) g
          union all select 'solana','signal', 64, case when g < 4 then 10 else -60 end from generate_series(1,15) g;
        notify pgrst, 'reload schema';`);
  await sleep(2500);
  const st = await cmd("/alerts");
  check(/35 resolved outcomes/.test(st[0]?.text || ""), "/alerts reports outcome stats once the table exists");
  mark = await sentCount();
  p = cloneP();
  const H = { hi: fake("HiHit"), lo: fake("LoHit") };
  addSignal(p, { addr: H.hi, sym: "HIHIT", score: 93, liq: 70_000, good: proven });
  addSignal(p, { addr: H.lo, sym: "LOHIT", score: 64, liq: 70_000, good: proven });
  await writeCache(p);
  await waitTicks(6000);
  const hr = await alertsTo(DM, mark);
  const hrs = hr.map((c) => (c.text.match(/\$([A-Z0-9]+)/) || [])[1]);
  for (const c of hr) log("\n--- alert ---\n" + c.text);
  check(hrs.includes("HIHIT") && !hrs.includes("LOHIT"), "hit-rate rule: 70% cohort alerted, 20% cohort suppressed");
  check(hr.some((c) => /hit rate/i.test(c.text)), "alert shows the cohort hit rate");

  // 6. migration 003: anon can no longer write the bot's tables; the bot (service key) still works
  log("\n## 6. Lock-down migration (003)");
  const before = await rest("POST", "vigil_subscribers", { telegram_id: "666", paid_chain: "x", paid_tx: "free", expires_at: "2099-01-01T00:00:00Z" }, { key: ANON });
  check(before.status === 201, `BEFORE 003: anon key can grant itself a subscription (HTTP ${before.status}) — the current production hole`);
  psql("delete from vigil_subscribers where telegram_id = '666';");
  psql(fs.readFileSync(path.join(ROOT, "migrations/003_lock_down_vigil_tables.sql"), "utf8") + "\nnotify pgrst, 'reload schema';");
  await sleep(1500);
  const after = await rest("POST", "vigil_subscribers", { telegram_id: "667", paid_chain: "x", paid_tx: "free2", expires_at: "2099-01-01T00:00:00Z" }, { key: ANON });
  check(after.status >= 400, `AFTER 003: anon insert refused (HTTP ${after.status})`);
  const lb = await rest("GET", "augur_leaderboard?select=*&limit=1", null, { key: ANON });
  check(lb.status === 200, "AFTER 003: public leaderboard view still readable");
  await cmd("/register", { userId: 4242, username: "newcaller" });
  await cmd("/alerts");
} catch (e) {
  failures.push("run crashed: " + e.message); console.error(e);
} finally {
  const all = await sent().catch(() => []);
  fs.writeFileSync(path.join(OUT, "telegram-calls.json"), JSON.stringify(all, null, 1));
  bot?.kill("SIGINT");
  await sleep(500);
  mock.kill();
  transcript.push(`\n## Result: ${failures.length ? failures.length + " FAILED: " + failures.join("; ") : "all checks passed"}`);
  fs.writeFileSync(path.join(OUT, "transcript.md"), transcript.join("\n"));
  console.log(`\n${transcript.filter((l) => l.includes("CHECK")).join("\n")}\n\n${failures.length ? "FAILED" : "PASSED"} — transcript: .e2e/transcript.md, bot log: .e2e/bot.log`);
  process.exitCode = failures.length ? 1 : 0;
}
