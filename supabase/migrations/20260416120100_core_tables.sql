-- Foundational schema 2/5 — core tables (PLAN.md Appendix A.2).
--
-- RECONSTRUCTED MIGRATION — see 20260416120000_enable_vector_extension.sql
-- for why this DDL lives in a reconstructed file rather than the original.
--
-- regdoc_chunks   — RAG corpus, populated by `bun run scripts/ingest.ts`.
-- plant_status / work_orders / shift_log_entries — simulated plant state,
--   seeded by 20260417015131_seed_bruce_power_fixtures.sql (which depends on
--   these tables existing, hence the 2026-04-16 timestamp here).
--
-- The embedding index is HNSW, not ivfflat (PLAN.md decision 2026-04-16:
-- ivfflat with default probes=1 dropped REGDOC-2.2.5 out of the top-10 on
-- the 1945-chunk corpus). Idempotent throughout.

-- RAG corpus
CREATE TABLE IF NOT EXISTS regdoc_chunks (
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
CREATE INDEX IF NOT EXISTS regdoc_chunks_embedding_idx
  ON regdoc_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS regdoc_chunks_regdoc_id_idx ON regdoc_chunks(regdoc_id);

-- Simulated plant state
CREATE TABLE IF NOT EXISTS plant_status (
  id              BIGSERIAL PRIMARY KEY,
  unit_id         TEXT NOT NULL,
  parameter       TEXT NOT NULL,
  value           TEXT NOT NULL,
  unit_of_measure TEXT,
  status          TEXT NOT NULL DEFAULT 'normal'
                    CHECK (status IN ('normal', 'attention', 'alarm')),
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plant_status_unit_idx ON plant_status(unit_id);

CREATE TABLE IF NOT EXISTS work_orders (
  id                  BIGSERIAL PRIMARY KEY,
  wo_number           TEXT NOT NULL,
  unit                TEXT NOT NULL,
  description         TEXT NOT NULL,
  status              TEXT NOT NULL
                        CHECK (status IN ('In Progress', 'Pending', 'Complete')),
  priority            TEXT NOT NULL
                        CHECK (priority IN ('Urgent', 'High', 'Routine')),
  assigned_to         TEXT,
  clearance_required  BOOLEAN NOT NULL DEFAULT FALSE,
  shift               TEXT CHECK (shift IN ('Day', 'Evening', 'Night'))
);
CREATE INDEX IF NOT EXISTS work_orders_unit_idx ON work_orders(unit);

CREATE TABLE IF NOT EXISTS shift_log_entries (
  id             BIGSERIAL PRIMARY KEY,
  unit           TEXT NOT NULL,
  timestamp      TIMESTAMPTZ NOT NULL,
  operator_role  TEXT NOT NULL
                   CHECK (operator_role IN ('SM', 'CRSS', 'ANO', 'Field Operator')),
  entry          TEXT NOT NULL,
  category       TEXT CHECK (category IN ('Equipment', 'Safety System', 'Administrative', 'Personnel')),
  severity       TEXT NOT NULL DEFAULT 'routine'
                   CHECK (severity IN ('routine', 'attention', 'significant'))
);
CREATE INDEX IF NOT EXISTS shift_log_unit_ts_idx ON shift_log_entries(unit, timestamp DESC);
