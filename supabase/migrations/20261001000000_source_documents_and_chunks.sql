-- Phase 12 — source-aware corpus: provenance, rights gate, per-document
-- publishing, and a bounded multi-collection search RPC.
--
-- PURELY ADDITIVE. regdoc_chunks, regdoc_chunks_staging, match_regdoc_chunks
-- and ingest_swap_regdoc_chunks_staging are untouched: the live chat path
-- keeps using them until KH_SOURCE_CORPUS=v2 is switched on, and they stay
-- the rollback path afterwards. Shipping this migration before or after the
-- app code is therefore safe in either order (contrast the in-place
-- embedding swap of 20260714030000, which coupled deploy to migration).
--
-- Model:
--   source_collections   one row per collection; `searchable` is the
--                        DB-side exposure switch (the anon key is public, so
--                        the app's own flag cannot be the only gate).
--   source_documents     one row per document EDITION (document_key +
--                        version_key): provenance, rights decision, legal
--                        force, status. At most one 'current' edition per key.
--   source_chunks        text + halfvec(3072) embeddings. A trigger refuses
--                        any row whose document is not rights-cleared for
--                        full text, and refuses IAEA rows outright.
--   source_chunks_staging  per-publish scratch (publish_id), service_role only.
--
-- Write paths (service_role only, each ONE transaction):
--   publish_source_document()              staged chunks → one edition
--   backfill_source_document_from_regdoc() CNSC rows copied from
--                                          regdoc_chunks, embeddings reused
--   register_source_document()             metadata-only upsert
--   unpublish_source_document()            drop an edition's chunks
-- Read path (anon/authenticated): match_source_chunks() — filtered to the
-- requested + searchable collections, rights-cleared, current (or explicitly
-- historical) editions BEFORE ranking, capped at 20 rows.

-- ---------------------------------------------------------------------------
-- Tables

CREATE TABLE IF NOT EXISTS source_collections (
  id          text PRIMARY KEY
              CHECK (id IN ('cnsc','nrc','onr','eu','aerb','fukushima','iaea')),
  label       text NOT NULL,
  searchable  boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- The IAEA collection is reference-only: no documented text-use permission.
  CONSTRAINT source_collections_iaea_reference_only
    CHECK (NOT (id = 'iaea' AND searchable))
);

-- CNSC starts searchable (its text is already public through
-- match_regdoc_chunks); every other collection starts closed and is opened
-- one at a time after its release checks (PLAN.md Phase 12, gate 5).
INSERT INTO source_collections (id, label, searchable) VALUES
  ('cnsc', 'CNSC', true),
  ('nrc', 'NRC', false),
  ('onr', 'ONR', false),
  ('eu', 'EU / Euratom', false),
  ('aerb', 'AERB', false),
  ('fukushima', 'Fukushima', false),
  ('iaea', 'IAEA', false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS source_documents (
  id                   bigserial PRIMARY KEY,
  document_key         text NOT NULL CHECK (document_key ~ '^[a-z0-9][a-z0-9.-]{1,79}$'),
  version_key          text NOT NULL CHECK (version_key ~ '^[a-z0-9][a-z0-9.-]{0,59}$'),
  doc_ref              text NOT NULL,
  label                text NOT NULL,
  title                text NOT NULL,
  edition              text NOT NULL,
  publisher            text NOT NULL,
  jurisdiction         text NOT NULL CHECK (jurisdiction IN ('CA','US','UK','EU','IN','JP','INT')),
  collection           text NOT NULL REFERENCES source_collections(id),
  document_kind        text NOT NULL CHECK (document_kind IN (
                         'statute','regulation','directive','regulatory_document',
                         'regulatory_guide','staff_report','safety_assessment_principles',
                         'technical_assessment_guide','reference_levels','handbook',
                         'safety_code','safety_guide','safety_standard',
                         'investigation_report','operator_report',
                         'review_mission_report','national_report',
                         'regulatory_requirements_outline')),
  legal_force          text NOT NULL CHECK (legal_force IN ('binding','mixed','nonbinding')),
  status               text NOT NULL CHECK (status IN ('current','superseded','draft','withdrawn','historical')),
  language             text NOT NULL DEFAULT 'en',
  canonical_url        text NOT NULL CHECK (canonical_url LIKE 'https://%'),
  fetch_url            text CHECK (fetch_url IS NULL OR fetch_url LIKE 'https://%'),
  published_date       text,
  effective_date       text,
  as_of                date NOT NULL,
  checksum_sha256      text CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  rights_decision      text NOT NULL CHECK (rights_decision IN ('full_text','metadata_only')),
  rights_basis         text NOT NULL,
  rights_evidence_url  text NOT NULL CHECK (rights_evidence_url LIKE 'https://%'),
  rights_reviewed_on   date NOT NULL,
  attribution          text,
  register_version     text NOT NULL,
  parser_version       text,
  embedding_model      text,
  embedding_dims       integer,
  chunk_count          integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  published_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_key, version_key),
  CONSTRAINT source_documents_text_requires_rights
    CHECK (rights_decision = 'full_text' OR chunk_count = 0)
);

-- One current edition per document. Superseded editions stay (with their
-- chunks) for explicit historical questions.
CREATE UNIQUE INDEX IF NOT EXISTS source_documents_one_current_idx
  ON source_documents (document_key) WHERE status = 'current';
CREATE INDEX IF NOT EXISTS source_documents_collection_idx
  ON source_documents (collection);

CREATE TABLE IF NOT EXISTS source_chunks (
  id               bigserial PRIMARY KEY,
  document_id      bigint NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  -- Denormalised from the document so the HNSW scan can filter on the same
  -- table; the rights-gate trigger keeps it equal to the document's.
  collection       text NOT NULL REFERENCES source_collections(id),
  chunk_index      integer NOT NULL CHECK (chunk_index >= 0),
  section_number   text,
  section_title    text,
  page_start       integer CHECK (page_start IS NULL OR page_start > 0),
  page_end         integer CHECK (page_end IS NULL OR page_end >= page_start),
  locator_url      text CHECK (locator_url IS NULL OR locator_url LIKE 'https://%'),
  chunk_text       text NOT NULL CHECK (length(chunk_text) > 0),
  text_sha256      text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  requirement_type text CHECK (requirement_type IN ('requirement','guidance')),
  embedding        halfvec(3072) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS source_chunks_embedding_idx
  ON source_chunks USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX IF NOT EXISTS source_chunks_collection_idx
  ON source_chunks (collection);
CREATE INDEX IF NOT EXISTS source_chunks_document_idx
  ON source_chunks (document_id);

CREATE TABLE IF NOT EXISTS source_chunks_staging (
  id               bigserial PRIMARY KEY,
  publish_id       uuid NOT NULL,
  chunk_index      integer NOT NULL,
  section_number   text,
  section_title    text,
  page_start       integer,
  page_end         integer,
  locator_url      text,
  chunk_text       text NOT NULL,
  text_sha256      text NOT NULL,
  requirement_type text,
  embedding        halfvec(3072) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS source_chunks_staging_publish_idx
  ON source_chunks_staging (publish_id);

-- ---------------------------------------------------------------------------
-- Access: RLS on, no policies, direct grants for service_role only. The anon
-- and authenticated roles reach this data solely through match_source_chunks.

ALTER TABLE source_collections    ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_documents      ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_chunks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_chunks_staging ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON source_collections, source_documents, source_chunks, source_chunks_staging
  FROM anon, authenticated, PUBLIC;
GRANT SELECT, UPDATE ON source_collections TO service_role;
GRANT SELECT ON source_documents, source_chunks TO service_role;
GRANT SELECT, INSERT, DELETE ON source_chunks_staging TO service_role;
GRANT USAGE, SELECT ON SEQUENCE source_chunks_staging_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- Rights gate (publication rules 1 + 3). Enforced in the database so no
-- script, backfill, or hand-typed SQL can store text the register did not
-- clear.

CREATE OR REPLACE FUNCTION source_chunks_rights_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  doc record;
BEGIN
  SELECT rights_decision, collection, publisher
    INTO doc
    FROM source_documents
   WHERE id = NEW.document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_chunks: document % does not exist', NEW.document_id;
  END IF;
  IF doc.rights_decision IS DISTINCT FROM 'full_text' THEN
    RAISE EXCEPTION 'source_chunks: document % is not rights-cleared for text (rights_decision=%)',
      NEW.document_id, doc.rights_decision;
  END IF;
  -- IAEA safety standards are reference-only. Lifting this requires a new
  -- migration that records the documented permission — deliberately not a
  -- data change.
  IF doc.collection = 'iaea' OR doc.publisher ~* '\mIAEA\M' THEN
    RAISE EXCEPTION 'source_chunks: IAEA publications are metadata-only (document %)', NEW.document_id;
  END IF;
  IF NEW.collection IS DISTINCT FROM doc.collection THEN
    RAISE EXCEPTION 'source_chunks: collection % does not match document collection %',
      NEW.collection, doc.collection;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS source_chunks_rights_gate ON source_chunks;
CREATE TRIGGER source_chunks_rights_gate
  BEFORE INSERT OR UPDATE ON source_chunks
  FOR EACH ROW EXECUTE FUNCTION source_chunks_rights_gate();

-- A document that loses its text clearance (or moves collection) must be
-- unpublished explicitly first — never silently left serving text.
CREATE OR REPLACE FUNCTION source_documents_rights_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (NEW.rights_decision IS DISTINCT FROM 'full_text'
      OR NEW.collection IS DISTINCT FROM OLD.collection)
     AND EXISTS (SELECT 1 FROM source_chunks WHERE document_id = NEW.id) THEN
    RAISE EXCEPTION 'source_documents: % still has chunks — unpublish_source_document() first',
      NEW.document_key;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS source_documents_rights_guard ON source_documents;
CREATE TRIGGER source_documents_rights_guard
  BEFORE UPDATE ON source_documents
  FOR EACH ROW EXECUTE FUNCTION source_documents_rights_guard();

-- ---------------------------------------------------------------------------
-- Internal: upsert one edition's metadata from a register entry (jsonb with
-- the corpus/register.json field names; rights flattened by the caller).
-- No grants — only the service_role functions below call it.

CREATE OR REPLACE FUNCTION _source_document_upsert(p_doc jsonb, p_register_version text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id      bigint;
  v_key     text := p_doc->>'document_key';
  v_version text := p_doc->>'version_key';
  v_status  text := p_doc->>'status';
BEGIN
  IF v_key IS NULL OR v_version IS NULL OR v_status IS NULL THEN
    RAISE EXCEPTION '_source_document_upsert: document_key, version_key and status are required';
  END IF;
  IF p_register_version IS NULL OR p_register_version = '' THEN
    RAISE EXCEPTION '_source_document_upsert: register version is required';
  END IF;

  -- A new current edition demotes the previous current one.
  IF v_status = 'current' THEN
    UPDATE source_documents
       SET status = 'superseded'
     WHERE document_key = v_key
       AND version_key <> v_version
       AND status = 'current';
  END IF;

  INSERT INTO source_documents AS d (
    document_key, version_key, doc_ref, label, title, edition, publisher,
    jurisdiction, collection, document_kind, legal_force, status, language,
    canonical_url, fetch_url, published_date, effective_date, as_of,
    checksum_sha256, rights_decision, rights_basis, rights_evidence_url,
    rights_reviewed_on, attribution, register_version
  ) VALUES (
    v_key, v_version, p_doc->>'doc_ref', p_doc->>'label', p_doc->>'title',
    p_doc->>'edition', p_doc->>'publisher', p_doc->>'jurisdiction',
    p_doc->>'collection', p_doc->>'document_kind', p_doc->>'legal_force',
    v_status, COALESCE(p_doc->>'language', 'en'), p_doc->>'canonical_url',
    p_doc->>'fetch_url', p_doc->>'published_date', p_doc->>'effective_date',
    (p_doc->>'as_of')::date, p_doc->>'checksum_sha256',
    p_doc->>'rights_decision', p_doc->>'rights_basis',
    p_doc->>'rights_evidence_url', (p_doc->>'rights_reviewed_on')::date,
    p_doc->>'attribution', p_register_version
  )
  ON CONFLICT (document_key, version_key) DO UPDATE SET
    doc_ref = EXCLUDED.doc_ref,
    label = EXCLUDED.label,
    title = EXCLUDED.title,
    edition = EXCLUDED.edition,
    publisher = EXCLUDED.publisher,
    jurisdiction = EXCLUDED.jurisdiction,
    collection = EXCLUDED.collection,
    document_kind = EXCLUDED.document_kind,
    legal_force = EXCLUDED.legal_force,
    status = EXCLUDED.status,
    language = EXCLUDED.language,
    canonical_url = EXCLUDED.canonical_url,
    fetch_url = EXCLUDED.fetch_url,
    published_date = EXCLUDED.published_date,
    effective_date = EXCLUDED.effective_date,
    as_of = EXCLUDED.as_of,
    checksum_sha256 = EXCLUDED.checksum_sha256,
    rights_decision = EXCLUDED.rights_decision,
    rights_basis = EXCLUDED.rights_basis,
    rights_evidence_url = EXCLUDED.rights_evidence_url,
    rights_reviewed_on = EXCLUDED.rights_reviewed_on,
    attribution = EXCLUDED.attribution,
    register_version = EXCLUDED.register_version
  RETURNING d.id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION _source_document_upsert(jsonb, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Publish one edition from staged chunks. Atomic: either the edition's
-- metadata AND exactly p_expected_count chunks land, or nothing changes.
-- Re-running the same edition replaces its chunks (idempotent, no
-- duplicates); other documents and collections are never touched.

CREATE OR REPLACE FUNCTION publish_source_document(
  p_doc              jsonb,
  p_register_version text,
  p_publish_id       uuid,
  p_expected_count   integer,
  p_parser_version   text,
  p_embedding_model  text,
  p_embedding_dims   integer
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id       bigint;
  v_staged   integer;
  v_inserted integer;
BEGIN
  IF p_doc->>'rights_decision' IS DISTINCT FROM 'full_text' THEN
    RAISE EXCEPTION 'publish_source_document: % is not rights-cleared for text', p_doc->>'document_key';
  END IF;
  IF p_embedding_dims IS DISTINCT FROM 3072 THEN
    RAISE EXCEPTION 'publish_source_document: embedding dims % do not match halfvec(3072)', p_embedding_dims;
  END IF;
  IF p_expected_count IS NULL OR p_expected_count < 1 THEN
    RAISE EXCEPTION 'publish_source_document: expected_count must be >= 1';
  END IF;

  SELECT count(*) INTO v_staged FROM source_chunks_staging WHERE publish_id = p_publish_id;
  IF v_staged IS DISTINCT FROM p_expected_count THEN
    RAISE EXCEPTION 'publish_source_document: staging holds % row(s) for publish %, caller expected %',
      v_staged, p_publish_id, p_expected_count;
  END IF;

  v_id := _source_document_upsert(p_doc, p_register_version);

  DELETE FROM source_chunks WHERE document_id = v_id;

  INSERT INTO source_chunks (
    document_id, collection, chunk_index, section_number, section_title,
    page_start, page_end, locator_url, chunk_text, text_sha256,
    requirement_type, embedding
  )
  SELECT v_id, p_doc->>'collection', s.chunk_index, s.section_number,
         s.section_title, s.page_start, s.page_end, s.locator_url,
         s.chunk_text, s.text_sha256, s.requirement_type, s.embedding
    FROM source_chunks_staging s
   WHERE s.publish_id = p_publish_id
   ORDER BY s.chunk_index;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted IS DISTINCT FROM p_expected_count THEN
    RAISE EXCEPTION 'publish_source_document: inserted % row(s), expected % — rolled back',
      v_inserted, p_expected_count;
  END IF;

  UPDATE source_documents
     SET chunk_count = v_inserted,
         parser_version = p_parser_version,
         embedding_model = p_embedding_model,
         embedding_dims = p_embedding_dims,
         published_at = now()
   WHERE id = v_id;

  DELETE FROM source_chunks_staging WHERE publish_id = p_publish_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION publish_source_document(jsonb, text, uuid, integer, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION publish_source_document(jsonb, text, uuid, integer, text, text, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- CNSC backfill: copy one REGDOC's rows from the legacy table WITHOUT
-- re-embedding (same model, same halfvec(3072) space). Same atomicity and
-- idempotency as publish_source_document.

CREATE OR REPLACE FUNCTION backfill_source_document_from_regdoc(
  p_doc              jsonb,
  p_register_version text,
  p_regdoc_id        text,
  p_expected_count   integer,
  p_embedding_model  text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id       bigint;
  v_source   integer;
  v_inserted integer;
BEGIN
  IF p_doc->>'rights_decision' IS DISTINCT FROM 'full_text' THEN
    RAISE EXCEPTION 'backfill_source_document_from_regdoc: % is not rights-cleared for text', p_doc->>'document_key';
  END IF;
  IF p_doc->>'collection' IS DISTINCT FROM 'cnsc' THEN
    RAISE EXCEPTION 'backfill_source_document_from_regdoc: only the cnsc collection backfills from regdoc_chunks';
  END IF;

  SELECT count(*) INTO v_source FROM regdoc_chunks WHERE regdoc_id = p_regdoc_id AND embedding IS NOT NULL;
  IF v_source IS DISTINCT FROM p_expected_count OR v_source = 0 THEN
    RAISE EXCEPTION 'backfill_source_document_from_regdoc: regdoc_chunks holds % embedded row(s) for %, caller expected %',
      v_source, p_regdoc_id, p_expected_count;
  END IF;

  v_id := _source_document_upsert(p_doc, p_register_version);

  DELETE FROM source_chunks WHERE document_id = v_id;

  INSERT INTO source_chunks (
    document_id, collection, chunk_index, section_number, section_title,
    page_start, page_end, locator_url, chunk_text, text_sha256,
    requirement_type, embedding
  )
  SELECT v_id, 'cnsc', r.chunk_index, r.section_number, r.section_title,
         NULL, NULL,
         CASE WHEN r.url LIKE 'https://%' THEN r.url END,
         r.chunk_text,
         encode(sha256(convert_to(r.chunk_text, 'UTF8')), 'hex'),
         r.requirement_type, r.embedding
    FROM regdoc_chunks r
   WHERE r.regdoc_id = p_regdoc_id AND r.embedding IS NOT NULL
   ORDER BY r.chunk_index;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted IS DISTINCT FROM p_expected_count THEN
    RAISE EXCEPTION 'backfill_source_document_from_regdoc: inserted %, expected % — rolled back',
      v_inserted, p_expected_count;
  END IF;

  UPDATE source_documents
     SET chunk_count = v_inserted,
         parser_version = 'regdoc_chunks-backfill',
         embedding_model = p_embedding_model,
         embedding_dims = 3072,
         published_at = now()
   WHERE id = v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION backfill_source_document_from_regdoc(jsonb, text, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION backfill_source_document_from_regdoc(jsonb, text, text, integer, text) TO service_role;

-- Metadata-only upsert (reference-only entries, rights re-reviews, editions
-- not yet published). Never touches chunks; the rights guard trigger refuses
-- a downgrade to metadata_only while chunks still exist.
CREATE OR REPLACE FUNCTION register_source_document(p_doc jsonb, p_register_version text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN _source_document_upsert(p_doc, p_register_version);
END;
$$;
REVOKE ALL ON FUNCTION register_source_document(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION register_source_document(jsonb, text) TO service_role;

CREATE OR REPLACE FUNCTION unpublish_source_document(p_document_key text, p_version_key text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM source_chunks c
   USING source_documents d
   WHERE c.document_id = d.id
     AND d.document_key = p_document_key
     AND d.version_key = p_version_key;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  UPDATE source_documents
     SET chunk_count = 0, published_at = NULL
   WHERE document_key = p_document_key AND version_key = p_version_key;
  RETURN v_deleted;
END;
$$;
REVOKE ALL ON FUNCTION unpublish_source_document(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION unpublish_source_document(text, text) TO service_role;

-- Rollout switch for one collection (gate 5: enable collections one at a
-- time). The CHECK constraint keeps IAEA closed regardless.
CREATE OR REPLACE FUNCTION set_source_collection_searchable(p_collection text, p_searchable boolean)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE source_collections
     SET searchable = p_searchable, updated_at = now()
   WHERE id = p_collection;
$$;
REVOKE ALL ON FUNCTION set_source_collection_searchable(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_source_collection_searchable(text, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- Public search. Filters BEFORE ranking: requested collections (at most 6),
-- DB-searchable collections, rights-cleared documents, current editions
-- (superseded only when include_historical). hnsw.iterative_scan keeps the
-- approximate index returning enough rows after the filter (pgvector >= 0.8;
-- hosted verified 0.8.0, local 0.8.2); ef_search 100 raises the candidate
-- list above the default 40 — scripts/sources/recall-bench.ts measures the
-- result against exact search. Hard cap of 20 rows, as match_regdoc_chunks.

CREATE OR REPLACE FUNCTION match_source_chunks(
  query_embedding    halfvec(3072),
  collection_ids     text[],
  match_count        integer DEFAULT 8,
  min_similarity     double precision DEFAULT 0.3,
  include_historical boolean DEFAULT false
)
RETURNS TABLE (
  id               bigint,
  document_key     text,
  doc_ref          text,
  label            text,
  title            text,
  publisher        text,
  jurisdiction     text,
  collection       text,
  document_kind    text,
  legal_force      text,
  edition          text,
  status           text,
  as_of            text,
  canonical_url    text,
  attribution      text,
  section_number   text,
  section_title    text,
  page_start       integer,
  page_end         integer,
  locator_url      text,
  chunk_text       text,
  requirement_type text,
  similarity       double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET hnsw.ef_search = 100
SET hnsw.iterative_scan = relaxed_order
AS $$
  SELECT
    c.id, d.document_key, d.doc_ref, d.label, d.title, d.publisher,
    d.jurisdiction, d.collection, d.document_kind, d.legal_force, d.edition,
    d.status, d.as_of::text, d.canonical_url, d.attribution,
    c.section_number, c.section_title, c.page_start, c.page_end,
    c.locator_url, c.chunk_text, c.requirement_type,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM source_chunks c
  JOIN source_documents d ON d.id = c.document_id
  JOIN source_collections sc ON sc.id = c.collection
  WHERE c.collection = ANY (collection_ids[1:6])
    AND sc.searchable
    AND d.rights_decision = 'full_text'
    AND (d.status = 'current' OR (include_historical AND d.status = 'superseded'))
    AND 1 - (c.embedding <=> query_embedding) > min_similarity
  ORDER BY c.embedding <=> query_embedding
  LIMIT LEAST(GREATEST(match_count, 1), 20);
$$;

REVOKE ALL ON FUNCTION match_source_chunks(halfvec, text[], integer, double precision, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION match_source_chunks(halfvec, text[], integer, double precision, boolean) TO anon, authenticated, service_role;

-- Exact (sequential) twin for the recall benchmark only. Same filters, no
-- index — the ground truth the approximate search is measured against.
CREATE OR REPLACE FUNCTION match_source_chunks_exact(
  query_embedding    halfvec(3072),
  collection_ids     text[],
  match_count        integer DEFAULT 20,
  include_historical boolean DEFAULT false
)
RETURNS TABLE (id bigint, similarity double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET enable_indexscan = off
SET enable_bitmapscan = off
AS $$
  SELECT c.id, 1 - (c.embedding <=> query_embedding) AS similarity
  FROM source_chunks c
  JOIN source_documents d ON d.id = c.document_id
  JOIN source_collections sc ON sc.id = c.collection
  WHERE c.collection = ANY (collection_ids[1:6])
    AND sc.searchable
    AND d.rights_decision = 'full_text'
    AND (d.status = 'current' OR (include_historical AND d.status = 'superseded'))
  ORDER BY c.embedding <=> query_embedding
  LIMIT LEAST(GREATEST(match_count, 1), 50);
$$;
REVOKE ALL ON FUNCTION match_source_chunks_exact(halfvec, text[], integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION match_source_chunks_exact(halfvec, text[], integer, boolean) TO service_role;
