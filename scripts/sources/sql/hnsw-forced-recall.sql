-- Forced-HNSW recall probe (local stack only; read-only, temp objects).
--
--   docker exec -i supabase_db_<project> psql -U postgres -d postgres -At \
--     < scripts/sources/sql/hnsw-forced-recall.sql > corpus/reports/hnsw-forced-recall.txt
--
-- Why this exists: at the current corpus size (~8.6k chunks) the planner
-- answers match_source_chunks with an exact scan + sort, never the HNSW
-- index, so scripts/sources/recall-bench.ts (which calls the production RPC)
-- measures 1.000 by construction. This probe forces the index path
-- (enable_seqscan/enable_sort off) with the production settings
-- (ef_search 100, iterative_scan relaxed_order) and compares it to an exact
-- scan — the recall the app WOULD get if the planner ever picked the index.
-- Whether it will is itself uncertain: match_source_chunks is a SQL function
-- that cannot be inlined (SECURITY DEFINER + SET) and has a non-constant
-- LIMIT, so its statement may be planned generically and stay on a seq scan
-- at any size — then the risk is latency, not recall. Re-check both with
-- EXPLAIN whenever the corpus grows.
-- Bar: recall-bench.ts uses mean recall@8 >= 0.95; at the time of writing the
-- "mixed" probes are 0.935-0.943 on the cnsc/all scopes, i.e. the CURRENT
-- index settings would FAIL that bar if the index were used — raise
-- hnsw.ef_search (e.g. 200) before relying on the index path. Probes: 25 stored chunk vectors per collection
-- ("chunk", easy — each is its own nearest neighbour) and the same vectors
-- summed with a chunk from another collection ("mixed", farther from every
-- stored vector, closer to how a question embeds). Dynamic SQL so every call
-- is planned with its own settings (PL/pgSQL would otherwise reuse one plan).

CREATE TEMP TABLE probes AS
  SELECT collection, id, embedding FROM (
    SELECT collection, id, embedding,
           row_number() OVER (PARTITION BY collection ORDER BY md5(id::text)) rn
    FROM source_chunks) s
  WHERE rn <= 25;

CREATE TEMP TABLE probes_mixed AS
  SELECT a.collection, (a.embedding::vector + b.embedding::vector)::halfvec AS embedding
  FROM probes a
  JOIN LATERAL (
    SELECT embedding FROM probes b
    WHERE b.collection <> a.collection
    ORDER BY md5(b.id::text || a.id::text) LIMIT 1) b ON true;

CREATE FUNCTION pg_temp.topk(q halfvec, cols text[], forced boolean)
RETURNS bigint[] LANGUAGE plpgsql AS $$
DECLARE r bigint[];
BEGIN
  PERFORM set_config('enable_seqscan', CASE WHEN forced THEN 'off' ELSE 'on' END, true);
  PERFORM set_config('enable_sort', CASE WHEN forced THEN 'off' ELSE 'on' END, true);
  PERFORM set_config('enable_indexscan', CASE WHEN forced THEN 'on' ELSE 'off' END, true);
  PERFORM set_config('enable_bitmapscan', 'off', true);
  PERFORM set_config('hnsw.ef_search', '100', true);
  PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
  EXECUTE 'SELECT array_agg(id) FROM (
      SELECT c.id FROM source_chunks c JOIN source_documents d ON d.id = c.document_id
      WHERE c.collection = ANY($2) AND d.rights_decision = ''full_text'' AND d.status = ''current''
      ORDER BY c.embedding <=> $1 LIMIT 8) t'
    INTO r USING q, cols;
  RETURN r;
END $$;

-- Plan check on the SAME statement topk() measures (join + filters), for
-- the smallest and the widest scope.
CREATE FUNCTION pg_temp.forced_plan_uses_hnsw(q halfvec, cols text[]) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE line text; found boolean := false;
BEGIN
  PERFORM set_config('enable_seqscan', 'off', true);
  PERFORM set_config('enable_sort', 'off', true);
  PERFORM set_config('enable_indexscan', 'on', true);
  PERFORM set_config('enable_bitmapscan', 'off', true);
  FOR line IN EXECUTE 'EXPLAIN SELECT c.id FROM source_chunks c JOIN source_documents d ON d.id = c.document_id
      WHERE c.collection = ANY($2) AND d.rights_decision = ''full_text'' AND d.status = ''current''
      ORDER BY c.embedding <=> $1 LIMIT 8' USING q, cols LOOP
    IF line LIKE '%source_chunks_embedding_idx%' THEN found := true; END IF;
  END LOOP;
  RETURN found;
END $$;

SELECT 'forced plan uses HNSW index (eu): ' || pg_temp.forced_plan_uses_hnsw((SELECT embedding FROM probes LIMIT 1), ARRAY['eu']);
SELECT 'forced plan uses HNSW index (all): ' || pg_temp.forced_plan_uses_hnsw((SELECT embedding FROM probes LIMIT 1), ARRAY['cnsc','nrc','onr','eu']);

SELECT kind || ' ' || scope AS probe_scope, count(*) AS n,
       round(avg(cardinality(ARRAY(SELECT unnest(h) INTERSECT SELECT unnest(e)))::numeric / 8), 3) AS mean_recall_at_8,
       min(cardinality(ARRAY(SELECT unnest(h) INTERSECT SELECT unnest(e)))) AS min_hits_of_8
FROM (
  SELECT 'chunk' kind, p.collection scope,
         pg_temp.topk(p.embedding, ARRAY[p.collection], true) h,
         pg_temp.topk(p.embedding, ARRAY[p.collection], false) e FROM probes p
  UNION ALL
  SELECT 'mixed', p.collection,
         pg_temp.topk(p.embedding, ARRAY[p.collection], true),
         pg_temp.topk(p.embedding, ARRAY[p.collection], false) FROM probes_mixed p
  UNION ALL
  SELECT 'mixed', 'all',
         pg_temp.topk(p.embedding, ARRAY['cnsc','nrc','onr','eu'], true),
         pg_temp.topk(p.embedding, ARRAY['cnsc','nrc','onr','eu'], false) FROM probes_mixed p
) x
GROUP BY kind, scope
ORDER BY 1;
