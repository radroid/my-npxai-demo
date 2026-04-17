-- Daily cleanup of empty chat_threads.
--
-- Pre-initialization (KnowledgeHubShell + ThreadSidebar "+ New thread", 2026-04-17)
-- mints a server-backed chat_threads row BEFORE the user sends anything. If
-- the user navigates away without typing, that row lingers as a zombie. This
-- migration installs cleanup_empty_chat_threads() and schedules it via pg_cron
-- to run once a day, sweeping any chat_threads row that:
--   (a) is older than 1 hour — keeps the job out of race conditions with a
--       user who opened the page but hasn't started typing yet, and
--   (b) has zero chat_messages rows pointing at it.
--
-- Kept deliberately coarse (daily cron, 1-hour floor) per the 2026-04-17 ask
-- to start simple. If zombies outpace the cadence in practice, revisit:
--   - tighten the interval floor,
--   - run more often,
--   - or move cleanup inline with "+ New thread" (delete the last empty one
--     the user abandoned before minting a new one).

CREATE OR REPLACE FUNCTION cleanup_empty_chat_threads()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	v_deleted integer;
BEGIN
	WITH deleted AS (
		DELETE FROM chat_threads t
		WHERE t.created_at < now() - interval '1 hour'
		  AND NOT EXISTS (
			SELECT 1 FROM chat_messages m WHERE m.thread_id = t.id
		  )
		RETURNING 1
	)
	SELECT count(*) INTO v_deleted FROM deleted;
	RETURN v_deleted;
END;
$$;

-- Maintenance function — clients should never call it, cron runs it as postgres.
REVOKE ALL ON FUNCTION cleanup_empty_chat_threads() FROM anon, authenticated, public;

-- pg_cron is a Supabase-supported extension. CREATE EXTENSION is idempotent,
-- so re-running this migration is safe.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Unschedule an existing job of the same name so re-runs of this migration
-- replace the schedule cleanly. pg_cron's cron.schedule raises if the name
-- already exists, hence the DO/EXCEPTION wrapper (cron.unschedule throws on
-- missing job).
DO $$
BEGIN
	PERFORM cron.unschedule('cleanup_empty_chat_threads_daily');
EXCEPTION WHEN OTHERS THEN
	-- No existing job; nothing to do.
	NULL;
END $$;

SELECT cron.schedule(
	'cleanup_empty_chat_threads_daily',
	'0 3 * * *',  -- 03:00 UTC daily — low-traffic window
	$$SELECT public.cleanup_empty_chat_threads();$$
);
