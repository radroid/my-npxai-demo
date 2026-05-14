-- Foundational schema 1/5 — pgvector extension.
--
-- RECONSTRUCTED MIGRATION. The original RAG-core schema (Appendix A.1-A.4)
-- was applied pre-CLI directly to the Supabase project's SQL editor and was
-- never committed as migration files (see PLAN.md decision 2026-04-17:
-- "Historical migrations ... remain pre-CLI and already deployed"). When the
-- project was later deleted, the only surviving copy of this DDL was
-- PLAN.md Appendix A. This file + the next four reconstruct it verbatim so a
-- fresh project can be rebuilt with `supabase db push`.
--
-- Timestamped 2026-04-16 (before the earliest committed migration,
-- 20260417015131) so it applies first on a clean project. Idempotent.

CREATE EXTENSION IF NOT EXISTS vector;
