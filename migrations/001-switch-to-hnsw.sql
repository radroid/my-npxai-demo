-- Migration 001: replace ivfflat index with HNSW on regdoc_chunks.embedding
--
-- Why: Appendix A.2 shipped with `ivfflat (embedding vector_cosine_ops)
-- WITH (lists = 100)`. Empirically (2026-04-16, 1945-chunk corpus), that
-- configuration has severe recall loss at the default `ivfflat.probes = 1`:
--
--   Client-side exact cosine for "minimum staff complement for a nuclear
--   power plant" found REGDOC-2.2.5 §3.1.1 at similarity 0.75, §3.1.4 at
--   0.72 — the correct regulatory source. The same query via the RPC
--   (which uses this index) returned REGDOC-1.1.1/2.3.2/3.5.3 as the
--   top-10, with REGDOC-2.2.5 nowhere in the result set.
--
-- Root cause: lists=100 over 1945 rows is ~19 rows/list, and default
-- probes=1 compares only one list — so 99% of rows are never scored.
-- Proper tuning would be lists ≈ sqrt(N) ≈ 44 plus probes ≈ 10.
--
-- Fix: switch to HNSW. It's pgvector's recommended default since 0.5.0,
-- works well across corpus sizes without per-table tuning, and handles
-- the demo's 1945 rows comfortably within the free-tier memory envelope.
--
-- Run in Supabase SQL editor. Idempotent.

DROP INDEX IF EXISTS regdoc_chunks_embedding_idx;

CREATE INDEX regdoc_chunks_embedding_idx
  ON regdoc_chunks
  USING hnsw (embedding vector_cosine_ops);

-- Default HNSW params (m=16, ef_construction=64, ef_search=40) are fine
-- for this corpus. If later eval battery shows recall issues, bump
-- ef_search per-session: `SET hnsw.ef_search = 100;` before the query.

-- Quick verification after running:
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'regdoc_chunks';
-- Expected: one row for regdoc_chunks_embedding_idx USING hnsw.
