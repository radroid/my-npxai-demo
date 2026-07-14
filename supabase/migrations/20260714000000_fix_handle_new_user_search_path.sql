-- Fix: restore SET search_path on handle_new_user (new signups were 500ing).
--
-- Bug surfaced by replaying the full migration chain into a clean local DB
-- (supabase db reset). Symptom, straight from the GoTrue container log on any
-- new-signup POST /auth/v1/otp:
--
--   relation "profiles" does not exist (SQLSTATE 42P01)
--   500: Database error saving new user
--
-- Root cause: 20260416120400_auth_profiles_and_tier.sql declared
-- handle_new_user with `SET search_path = public`. 20260417131500_owner_email_
-- allowlist.sql then did CREATE OR REPLACE FUNCTION on it to prepend the
-- owner-email branch, but did NOT restate the SET clause. In Postgres,
-- CREATE OR REPLACE FUNCTION *replaces the function's configuration
-- parameters* — a SET you omit is dropped, not inherited. The live catalog
-- confirmed the drop:
--
--   proname         | proconfig
--   get_user_tier   | {search_path=public}   <- kept its SET
--   handle_new_user | NULL                   <- lost it
--
-- The trigger fires on INSERT INTO auth.users as supabase_auth_admin, whose
-- search_path does not include `public`, so the unqualified `profiles` in the
-- INSERT no longer resolved.
--
-- Why nobody noticed: the trigger only runs for *new* users. Everyone with an
-- existing profiles row keeps signing in fine; only fresh signups break.
--
-- Fix, belt and braces:
--   1. Restate SET search_path = public, pg_temp — matching the convention
--      every other SECURITY DEFINER function in this repo has used since
--      2026-04-17 (list_threads, save_message, save_report, delete_report,
--      ...). pg_temp is appended (not omitted) so a malicious temp-schema
--      object can't shadow a call the function makes.
--   2. Schema-qualify public.profiles so the function is correct even if the
--      search_path is ever cleared again by a future CREATE OR REPLACE.
--
-- Tier logic is carried over verbatim from 20260417131500 — no behaviour change.

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_tier TEXT := CASE
    WHEN lower(NEW.email) IN (
      'raj9dholakia@gmail.com'
    ) THEN 'npx_circle'
    WHEN lower(split_part(NEW.email, '@', 2)) IN (
      'npxinnovation.ca',
      'brucepower.com',
      'opg.com',
      'cnsc-ccsn.gc.ca',
      'cameco.com',
      'uwaterloo.ca'
    ) THEN 'npx_circle'
    ELSE 'signed_in'
  END;
BEGIN
  INSERT INTO public.profiles (id, email, tier)
    VALUES (NEW.id, NEW.email, v_tier)
    ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Trigger definition is unchanged; recreate idempotently so a DB that somehow
-- lost the trigger converges to the same state as a fresh `db reset`.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
