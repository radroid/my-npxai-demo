-- Foundational schema 4/5 — public RPC surface (PLAN.md Appendix A.4).
--
-- RECONSTRUCTED MIGRATION — see 20260416120000_enable_vector_extension.sql.
--
-- These two SECURITY DEFINER functions are the ONLY way anon/authenticated
-- clients reach the RLS-locked core tables:
--   match_regdoc_chunks  — pgvector cosine search, called by
--                          app/api/knowledge-hub/query/route.ts
--   get_turnover_snapshot — plant-state bundle, called by
--                           app/api/generator/turnover/route.ts
-- Idempotent (CREATE OR REPLACE).

-- Vector search for Knowledge Hub
CREATE OR REPLACE FUNCTION match_regdoc_chunks(
  query_embedding vector(1536),
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
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    id, regdoc_id, title, section_number, section_title,
    chunk_text, url, requirement_type,
    1 - (embedding <=> query_embedding) AS similarity
  FROM regdoc_chunks
  WHERE 1 - (embedding <=> query_embedding) > min_similarity
  ORDER BY embedding <=> query_embedding
  LIMIT LEAST(match_count, 20);  -- hard cap so callers can't request unlimited rows
$$;

-- Turnover snapshot for Generator
CREATE OR REPLACE FUNCTION get_turnover_snapshot(p_unit text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'plant_status', COALESCE((SELECT jsonb_agg(row_to_json(ps))
                              FROM plant_status ps
                              WHERE ps.unit_id = p_unit), '[]'::jsonb),
    'work_orders',  COALESCE((SELECT jsonb_agg(row_to_json(wo))
                              FROM work_orders wo
                              WHERE wo.unit = p_unit), '[]'::jsonb),
    'shift_log',    COALESCE((SELECT jsonb_agg(row_to_json(sl))
                              FROM (SELECT *
                                    FROM shift_log_entries
                                    WHERE unit = p_unit
                                    ORDER BY timestamp DESC
                                    LIMIT 50) sl), '[]'::jsonb)
  )
$$;

GRANT EXECUTE ON FUNCTION match_regdoc_chunks(vector, int, float) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_turnover_snapshot(text)             TO anon, authenticated;
