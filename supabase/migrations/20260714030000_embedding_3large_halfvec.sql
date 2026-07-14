-- Embedding upgrade: text-embedding-3-small (1536) → text-embedding-3-large
-- at the FULL 3072 dims, stored as halfvec.
--
-- WHY 3072 dims: an apples-to-apples brute-force cosine experiment on the
-- 92-question golden set showed -large@3072 beats -small@1536 (hit@8
-- 92.4%→96.7%, recall@8 79.2%→85.8%, MRR 0.782→0.816, net +4 recoveries).
-- Matryoshka-truncating -large back to 1536 dims erased most of that gain, so
-- we must store and query at the full 3072 dims.
--
-- WHY halfvec: pgvector's HNSW/IVFFlat indexes cap the `vector` type at 2000
-- dims. `halfvec` (16-bit floats) supports HNSW to 4000 dims at half the
-- storage, and is available on the local Docker pgvector 0.8.2. So the corpus
-- column becomes halfvec(3072) indexed with halfvec_cosine_ops; the RPC's
-- query_embedding parameter becomes halfvec(3072) and keeps cosine (`<=>`).
--
-- WHY drop-and-re-add the column instead of casting: existing 1536-dim data
-- cannot be cast to a 3072-dim type. A re-ingest via the staging-swap ALWAYS
-- follows this deploy, so emptying the embedding column here is expected and
-- safe — scripts/ingest.ts repopulates regdoc_chunks atomically through
-- ingest_swap_regdoc_chunks_staging(). Until that runs the corpus has no
-- embeddings; that is the intended, transient state.

-- 1. Drop the RPC first. Its query_embedding parameter type changes from
--    `vector` to `halfvec`, which is a NEW signature — CREATE OR REPLACE would
--    leave a second, stale `match_regdoc_chunks(vector, ...)` overload behind
--    and make PostgREST's by-name resolution ambiguous. Drop, then recreate.
DROP FUNCTION IF EXISTS match_regdoc_chunks(vector, int, float);

-- 2. Drop the HNSW index (it is bound to the old vector column; dropping the
--    column below would drop it anyway — this is explicit and idempotent).
DROP INDEX IF EXISTS regdoc_chunks_embedding_idx;

-- 3. Swap the embedding column type on BOTH the live and staging tables. The
--    ingest_swap function's INSERT ... SELECT lists columns by name (not type),
--    so it needs no change as long as both columns share the new type.
ALTER TABLE regdoc_chunks         DROP COLUMN IF EXISTS embedding;
ALTER TABLE regdoc_chunks         ADD  COLUMN embedding halfvec(3072);
ALTER TABLE regdoc_chunks_staging DROP COLUMN IF EXISTS embedding;
ALTER TABLE regdoc_chunks_staging ADD  COLUMN embedding halfvec(3072);

-- 4. Recreate the HNSW index with the halfvec cosine opclass. Same name as
--    before so the smoke test and any tooling that references it keep working.
CREATE INDEX regdoc_chunks_embedding_idx
  ON regdoc_chunks USING hnsw (embedding halfvec_cosine_ops);

-- 5. Recreate the vector-search RPC. Body reproduced EXACTLY from
--    20260416120300_rpc_functions.sql except: the query_embedding parameter is
--    now halfvec(3072) (matching the column) and the SET search_path adopts the
--    repo's `public, pg_temp` convention for SECURITY DEFINER functions. The
--    cosine distance operator (`<=>`) and the LEAST(match_count, 20) hard cap
--    are unchanged.
CREATE FUNCTION match_regdoc_chunks(
  query_embedding halfvec(3072),
  match_count     int   DEFAULT 8,
  min_similarity  float DEFAULT 0.3
)
RETURNS TABLE (
  id               bigint,
  regdoc_id        text,
  title            text,
  section_number   text,
  section_title    text,
  chunk_text       text,
  url              text,
  requirement_type text,
  similarity       float
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    id, regdoc_id, title, section_number, section_title,
    chunk_text, url, requirement_type,
    1 - (embedding <=> query_embedding) AS similarity
  FROM regdoc_chunks
  WHERE 1 - (embedding <=> query_embedding) > min_similarity
  ORDER BY embedding <=> query_embedding
  LIMIT LEAST(match_count, 20);  -- hard cap so callers can't request unlimited rows
$$;

GRANT EXECUTE ON FUNCTION match_regdoc_chunks(halfvec, int, float) TO anon, authenticated;
