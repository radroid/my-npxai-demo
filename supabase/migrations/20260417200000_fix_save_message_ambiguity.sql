-- Fix save_message 42702 ambiguity.
-- The original function declares `RETURNS TABLE (id uuid, created_at timestamptz)`,
-- which binds `id` and `created_at` as PL/pgSQL output parameters. Inside the
-- body, `UPDATE chat_threads SET updated_at = now() WHERE id = p_thread;`
-- then has `id` matching both the output parameter and `chat_threads.id` —
-- Postgres raises "column reference 'id' is ambiguous" (42702) and the RPC
-- returns an error before any row is inserted. Symptom: chat_threads rows
-- accumulate (from create_thread) but chat_messages stays at 0.
--
-- Fix: fully qualify column references in the UPDATE (and, defensively,
-- elsewhere where `id`/`created_at` could collide with the output params).

CREATE OR REPLACE FUNCTION save_message(
	p_thread  uuid,
	p_role    text,
	p_content jsonb
)
RETURNS TABLE (id uuid, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	v_uid uuid := auth.uid();
	v_id  uuid;
	v_at  timestamptz;
BEGIN
	IF v_uid IS NULL THEN
		RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM chat_threads t
		WHERE t.id = p_thread AND t.owner_id = v_uid
	) THEN
		RAISE EXCEPTION 'thread not found' USING ERRCODE = '42501';
	END IF;

	IF p_role NOT IN ('user', 'assistant', 'system') THEN
		RAISE EXCEPTION 'invalid role' USING ERRCODE = '22023';
	END IF;

	INSERT INTO chat_messages (thread_id, role, content)
	VALUES (p_thread, p_role, p_content)
	RETURNING chat_messages.id, chat_messages.created_at INTO v_id, v_at;

	UPDATE chat_threads
	SET updated_at = now()
	WHERE chat_threads.id = p_thread;

	RETURN QUERY SELECT v_id, v_at;
END;
$$;
