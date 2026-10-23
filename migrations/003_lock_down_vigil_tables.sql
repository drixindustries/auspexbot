-- =====================================================================================================
-- 003 — Lock down the bot's vigil_* tables. APPLY ONLY AFTER the bot runs with SUPABASE_SERVICE_KEY.
--
-- 001 created `for all using (true)` policies on every vigil_* table, meaning anyone holding the anon key
-- can read every subscriber and payment, and INSERT/UPDATE rows — e.g. grant themselves a subscription
-- (vigil_subscribers) or mark themselves verified (vigil_callers). If the bot shares the site's Supabase
-- project, that anon key is public (it is embedded in the site's index.html).
-- The service_role key bypasses RLS, so dropping these policies doesn't affect the bot once it uses it.
-- =====================================================================================================

drop policy if exists "vigil_subscribers_all" on public.vigil_subscribers;
drop policy if exists "vigil_payments_all"    on public.vigil_payments;
drop policy if exists "vigil_callers_all"     on public.vigil_callers;
drop policy if exists "vigil_calls_all"       on public.vigil_calls;
drop policy if exists "vigil_watched_all"     on public.vigil_watched_accounts;
drop policy if exists "vigil_snapshots_all"   on public.vigil_following_snapshots;

revoke insert, update, delete, truncate on
  public.vigil_subscribers, public.vigil_payments, public.vigil_callers, public.vigil_calls,
  public.vigil_watched_accounts, public.vigil_following_snapshots
  from anon, authenticated;
revoke select on public.vigil_subscribers, public.vigil_payments, public.vigil_watched_accounts, public.vigil_following_snapshots
  from anon, authenticated;

-- Public leaderboard: keep only the view readable (verified callers with 5+ scored calls).
-- Views run with the owner's rights by default, so anon can read augur_leaderboard without table access.
grant select on public.augur_leaderboard to anon, authenticated;
