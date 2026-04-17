-- Revert 20260417210000_cleanup_empty_chat_threads.sql.
--
-- The zombie-row problem it addressed went away when we stopped pre-initializing
-- chat_threads rows on signed-in mount (see KnowledgeHubShell 2026-04-17). With
-- threads now minting lazily on first send inside onFinish, empty rows can only
-- appear on transient failures — a daily sweep is overkill. Drop the function
-- and unschedule the cron. cron.unschedule raises if the job is absent, so the
-- DO/EXCEPTION wrapper keeps the migration idempotent across fresh DBs where
-- the original cleanup migration was never applied.

DO $$
BEGIN
	PERFORM cron.unschedule('cleanup_empty_chat_threads_daily');
EXCEPTION WHEN OTHERS THEN
	NULL;
END $$;

DROP FUNCTION IF EXISTS cleanup_empty_chat_threads();
