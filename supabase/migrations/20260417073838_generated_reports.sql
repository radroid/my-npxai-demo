-- Generated-report persistence (Phase 6C).
-- Signed-in users get Supabase-backed report storage with owner-only RLS.
-- `snapshot_hash` is the dedupe key: the route computes SHA-256 over the
-- serialized snapshot and checks for an existing row before hitting OpenAI
-- ("Last generated N min ago · Regenerate" flow). Anon users keep reports
-- in localStorage (no server-side representation by design, per the
-- 2026-04-17 hybrid-persistence decision).

CREATE TABLE IF NOT EXISTS generated_reports (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	owner_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	station         text NOT NULL,
	unit            text NOT NULL,
	shift           text NOT NULL,
	report_markdown text NOT NULL,
	snapshot_hash   text NOT NULL,
	generated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS generated_reports_dedupe_idx
	ON generated_reports (owner_id, station, unit, shift, snapshot_hash);

CREATE INDEX IF NOT EXISTS generated_reports_owner_recent_idx
	ON generated_reports (owner_id, generated_at DESC);

ALTER TABLE generated_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "generated_reports_owner_select" ON generated_reports;
DROP POLICY IF EXISTS "generated_reports_owner_insert" ON generated_reports;
DROP POLICY IF EXISTS "generated_reports_owner_update" ON generated_reports;
DROP POLICY IF EXISTS "generated_reports_owner_delete" ON generated_reports;

CREATE POLICY "generated_reports_owner_select" ON generated_reports
	FOR SELECT TO authenticated USING (auth.uid() = owner_id);
CREATE POLICY "generated_reports_owner_insert" ON generated_reports
	FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "generated_reports_owner_update" ON generated_reports
	FOR UPDATE TO authenticated USING (auth.uid() = owner_id)
	WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "generated_reports_owner_delete" ON generated_reports
	FOR DELETE TO authenticated USING (auth.uid() = owner_id);

REVOKE ALL ON TABLE generated_reports FROM anon, public;

-- Route handlers call these via the anon client + JWT; SECURITY DEFINER
-- so the RPC body bypasses RLS for the scoped query but still honors
-- `auth.uid()` for ownership checks.

CREATE OR REPLACE FUNCTION list_reports()
RETURNS TABLE (
	id            uuid,
	station       text,
	unit          text,
	shift         text,
	snapshot_hash text,
	generated_at  timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
	SELECT id, station, unit, shift, snapshot_hash, generated_at
	FROM generated_reports
	WHERE owner_id = auth.uid()
	ORDER BY generated_at DESC
	LIMIT 50;
$$;

CREATE OR REPLACE FUNCTION get_report(p_id uuid)
RETURNS TABLE (
	id              uuid,
	station         text,
	unit            text,
	shift           text,
	report_markdown text,
	snapshot_hash   text,
	generated_at    timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
	SELECT id, station, unit, shift, report_markdown, snapshot_hash, generated_at
	FROM generated_reports
	WHERE id = p_id AND owner_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION find_report_by_hash(
	p_station       text,
	p_unit          text,
	p_shift         text,
	p_snapshot_hash text
)
RETURNS TABLE (
	id              uuid,
	report_markdown text,
	generated_at    timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
	SELECT id, report_markdown, generated_at
	FROM generated_reports
	WHERE owner_id = auth.uid()
	  AND station = p_station
	  AND unit = p_unit
	  AND shift = p_shift
	  AND snapshot_hash = p_snapshot_hash
	LIMIT 1;
$$;

-- save_report always upserts on the (owner, station, unit, shift, hash)
-- unique key. Same hash → overwrite markdown + bump generated_at; a
-- regenerate forced through ?force=true replaces the stored copy with
-- the newest generation rather than resurrecting a stale one.
CREATE OR REPLACE FUNCTION save_report(
	p_station       text,
	p_unit          text,
	p_shift         text,
	p_markdown      text,
	p_snapshot_hash text
)
RETURNS TABLE (
	id           uuid,
	generated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	v_uid uuid := auth.uid();
	v_id  uuid;
	v_at  timestamptz;
BEGIN
	IF v_uid IS NULL THEN
		RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
	END IF;

	INSERT INTO generated_reports (
		owner_id, station, unit, shift, report_markdown, snapshot_hash, generated_at
	)
	VALUES (v_uid, p_station, p_unit, p_shift, p_markdown, p_snapshot_hash, now())
	ON CONFLICT (owner_id, station, unit, shift, snapshot_hash)
	DO UPDATE SET
		report_markdown = EXCLUDED.report_markdown,
		generated_at    = EXCLUDED.generated_at
	RETURNING generated_reports.id, generated_reports.generated_at INTO v_id, v_at;

	RETURN QUERY SELECT v_id, v_at;
END;
$$;

CREATE OR REPLACE FUNCTION delete_report(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
VOLATILE
AS $$
	DELETE FROM generated_reports WHERE id = p_id AND owner_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION list_reports() TO authenticated;
GRANT EXECUTE ON FUNCTION get_report(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION find_report_by_hash(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION save_report(text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION delete_report(uuid) TO authenticated;

REVOKE ALL ON FUNCTION list_reports() FROM anon, public;
REVOKE ALL ON FUNCTION get_report(uuid) FROM anon, public;
REVOKE ALL ON FUNCTION find_report_by_hash(text, text, text, text) FROM anon, public;
REVOKE ALL ON FUNCTION save_report(text, text, text, text, text) FROM anon, public;
REVOKE ALL ON FUNCTION delete_report(uuid) FROM anon, public;
