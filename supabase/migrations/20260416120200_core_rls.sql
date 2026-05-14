-- Foundational schema 3/5 — row-level security (PLAN.md Appendix A.3).
--
-- RECONSTRUCTED MIGRATION — see 20260416120000_enable_vector_extension.sql.
--
-- All four core tables are RLS-enabled with NO policies granting anon or
-- authenticated direct access. The only exposed surface is the SECURITY
-- DEFINER RPCs in the next file. The service role (offline ingestion) and
-- SECURITY DEFINER functions bypass RLS; everyone else gets nothing.

ALTER TABLE regdoc_chunks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE plant_status       ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders        ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_log_entries  ENABLE ROW LEVEL SECURITY;

-- Explicitly revoke default table grants so anon can't SELECT directly.
REVOKE ALL ON regdoc_chunks, plant_status, work_orders, shift_log_entries
  FROM anon, authenticated;
