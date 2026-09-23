-- The ingestion verifier and RAG eval runner read regdoc_chunks with the
-- service_role key. On a fresh local Supabase, that role can invoke the
-- SECURITY DEFINER swap but lacks direct SELECT on the live table, causing
-- verification/evaluation to fail after a successful swap.
-- Keep anon/authenticated direct-table access revoked; they use the search RPC.
GRANT SELECT ON TABLE public.regdoc_chunks TO service_role;
