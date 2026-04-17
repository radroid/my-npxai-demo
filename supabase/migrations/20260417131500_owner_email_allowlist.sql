-- Owner-email allowlist for tier classification.
--
-- Why: raj9dholakia@gmail.com is the demo owner. gmail.com isn't in the
-- nuclear-industry domain list, so the handle_new_user trigger defaults the
-- account to `signed_in` (50/day KH). For the person demoing and testing the
-- app end-to-end, that's too tight — bump the owner to `npx_circle` (100/day).
--
-- Changes:
-- 1. handle_new_user: prepend an exact-email CASE branch so future signups
--    from owner emails are classified as npx_circle automatically.
-- 2. Reclassify the existing row (trigger only fires on INSERT).
--
-- To add more owner emails later: edit the CASE list, re-run CREATE OR
-- REPLACE FUNCTION, and UPDATE profiles for any already-existing users.

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
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
  INSERT INTO profiles (id, email, tier)
    VALUES (NEW.id, NEW.email, v_tier)
    ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

UPDATE profiles
   SET tier = 'npx_circle'
 WHERE lower(email) = 'raj9dholakia@gmail.com'
   AND tier <> 'npx_circle';
