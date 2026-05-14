-- Foundational schema 5/5 — auth profiles + tier classification (PLAN.md Appendix A.6).
--
-- RECONSTRUCTED MIGRATION — see 20260416120000_enable_vector_extension.sql.
--
-- profiles         — app-side row 1:1 with auth.users, stores the rate-limit tier.
-- handle_new_user  — trigger that classifies new signups by email domain.
-- get_user_tier    — server-side lookup, called once per authenticated request
--                    by lib/guard.ts.
--
-- NOTE: 20260417131500_owner_email_allowlist.sql does CREATE OR REPLACE on
-- handle_new_user to prepend an owner-email branch — that migration depends
-- on profiles + handle_new_user existing, which is why this file is
-- timestamped 2026-04-16. Idempotent throughout.

-- App-side profile row, 1:1 with auth.users
CREATE TABLE IF NOT EXISTS profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  tier        TEXT NOT NULL DEFAULT 'signed_in'
                CHECK (tier IN ('signed_in', 'npx_circle')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Revoke defaults; only the policy below grants access.
REVOKE ALL ON profiles FROM anon, authenticated;

-- Authenticated users can read ONLY their own profile. No writes from clients.
DROP POLICY IF EXISTS "profiles_self_read" ON profiles;
CREATE POLICY "profiles_self_read" ON profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id);
GRANT SELECT ON profiles TO authenticated;

-- On new user: provision profile and classify tier by email domain.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_domain TEXT := lower(split_part(NEW.email, '@', 2));
  v_tier   TEXT := CASE
    WHEN v_domain IN (
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
  INSERT INTO profiles (id, email, tier)
    VALUES (NEW.id, NEW.email, v_tier)
    ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Server-side tier lookup (called once per authenticated request by lib/guard.ts).
CREATE OR REPLACE FUNCTION get_user_tier(p_user_id UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT tier FROM profiles WHERE id = p_user_id),
    'signed_in'
  );
$$;

GRANT EXECUTE ON FUNCTION get_user_tier(UUID) TO authenticated;
