-- Non-destructive-until-safe re-ingest: a staging table + one atomic swap
-- function for regdoc_chunks.
--
-- scripts/ingest.ts used to TRUNCATE regdoc_chunks, then batch-INSERT the
-- freshly embedded corpus back in — as separate, non-transactional PostgREST
-- requests (every REST call is its own transaction). A failure partway
-- through the insert loop (an insert batch timing out, a dropped
-- connection, an OpenAI hiccup) left the table wiped-and-partial with
-- nothing to roll back to. That is tolerable against a disposable local
-- dev DB; it is not tolerable against the live hosted demo DB, which is
-- exactly the case this migration exists for (see this file's sibling,
-- 20260714010000_service_role_statement_timeout.sql, for the companion
-- PostgREST-reload gap that made hosted trip the old 8s cap in the first
-- place and triggered this failure mode for real).
--
-- Fix: scripts/ingest.ts now inserts the new corpus into
-- regdoc_chunks_staging first — batched exactly as before, but touching
-- nothing in regdoc_chunks. Only once the script has confirmed the staging
-- row count matches what it intended to insert does it call
-- ingest_swap_regdoc_chunks_staging(), which does the truncate-and-replace
-- of regdoc_chunks inside a single PL/pgSQL function body. A function body
-- is one implicit Postgres transaction: if anything inside it raises —
-- including the function's own server-side recount, a constraint
-- violation, whatever — every statement since the function started,
-- including the TRUNCATE, rolls back automatically. There is no window in
-- which regdoc_chunks can be observed half-wiped; either the swap fully
-- lands or regdoc_chunks is exactly what it was before the call.
--
-- regdoc_chunks_staging follows the same RLS pattern as every other core
-- table (RLS on, no policies for anon/authenticated — service_role bypasses
-- RLS system-wide) and only service_role can reach it or the swap function.

CREATE TABLE IF NOT EXISTS regdoc_chunks_staging (
  id               BIGSERIAL PRIMARY KEY,
  regdoc_id        TEXT NOT NULL,
  title            TEXT NOT NULL,
  section_number   TEXT,
  section_title    TEXT,
  chunk_text       TEXT NOT NULL,
  chunk_index      INTEGER NOT NULL,
  url              TEXT,
  requirement_type TEXT CHECK (requirement_type IN ('requirement', 'guidance')),
  embedding        vector(1536),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- No HNSW/similarity index here on purpose: this table only ever holds one
-- in-flight batch before the swap truncates it again, so a vector index
-- would just be rebuild churn with nothing that ever queries it.

ALTER TABLE regdoc_chunks_staging ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON regdoc_chunks_staging FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON regdoc_chunks_staging TO service_role;
GRANT USAGE, SELECT ON SEQUENCE regdoc_chunks_staging_id_seq TO service_role;

CREATE OR REPLACE FUNCTION ingest_swap_regdoc_chunks_staging(expected_count integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  staged_count   integer;
  inserted_count integer;
BEGIN
  SELECT count(*) INTO staged_count FROM regdoc_chunks_staging;
  IF staged_count IS DISTINCT FROM expected_count THEN
    RAISE EXCEPTION
      'ingest_swap_regdoc_chunks_staging: staging holds % row(s), caller expected % — refusing to swap, regdoc_chunks left untouched',
      staged_count, expected_count;
  END IF;

  -- Everything from here down is one transaction. If any statement raises,
  -- Postgres rolls back the TRUNCATE too — regdoc_chunks cannot end up
  -- observed empty or partial from this function.
  TRUNCATE regdoc_chunks RESTART IDENTITY;

  INSERT INTO regdoc_chunks
    (regdoc_id, title, section_number, section_title, chunk_text,
     chunk_index, url, requirement_type, embedding, created_at)
  SELECT
    regdoc_id, title, section_number, section_title, chunk_text,
    chunk_index, url, requirement_type, embedding, created_at
  FROM regdoc_chunks_staging
  ORDER BY id;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count IS DISTINCT FROM expected_count THEN
    RAISE EXCEPTION
      'ingest_swap_regdoc_chunks_staging: inserted % row(s) into regdoc_chunks, expected % — rolling back, regdoc_chunks left untouched',
      inserted_count, expected_count;
  END IF;

  TRUNCATE regdoc_chunks_staging;
  RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION ingest_swap_regdoc_chunks_staging(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_swap_regdoc_chunks_staging(integer) TO service_role;
