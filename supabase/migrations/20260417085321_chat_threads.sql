-- Hybrid chat-thread persistence (Phase 6B).
-- Signed-in users get Supabase-backed thread + message storage with owner-
-- only RLS; anon users continue to use localStorage (no server representation
-- by design, per the 2026-04-17 hybrid-persistence decision).
--
-- Tables + indexes live here; the client-side runtime swap that reads these
-- through /api/threads/* handlers lands in a follow-up diff once the custom
-- assistant-ui runtime is wired. Landing the schema first means the human
-- can `bunx supabase db push --linked` independently of the TypeScript
-- work.

CREATE TABLE IF NOT EXISTS chat_threads (
	id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	owner_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	title      text NOT NULL DEFAULT 'New thread',
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_threads_owner_recent_idx
	ON chat_threads (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
	id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	thread_id  uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
	role       text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
	content    jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_thread_created_idx
	ON chat_messages (thread_id, created_at ASC);

ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chat_threads_owner_select" ON chat_threads;
DROP POLICY IF EXISTS "chat_threads_owner_insert" ON chat_threads;
DROP POLICY IF EXISTS "chat_threads_owner_update" ON chat_threads;
DROP POLICY IF EXISTS "chat_threads_owner_delete" ON chat_threads;

CREATE POLICY "chat_threads_owner_select" ON chat_threads
	FOR SELECT TO authenticated USING (auth.uid() = owner_id);
CREATE POLICY "chat_threads_owner_insert" ON chat_threads
	FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "chat_threads_owner_update" ON chat_threads
	FOR UPDATE TO authenticated USING (auth.uid() = owner_id)
	WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "chat_threads_owner_delete" ON chat_threads
	FOR DELETE TO authenticated USING (auth.uid() = owner_id);

DROP POLICY IF EXISTS "chat_messages_owner_select" ON chat_messages;
DROP POLICY IF EXISTS "chat_messages_owner_insert" ON chat_messages;
DROP POLICY IF EXISTS "chat_messages_owner_delete" ON chat_messages;

-- Messages inherit ownership through the parent thread. An EXISTS check on
-- chat_threads is enough — the thread RLS already scopes to auth.uid().
CREATE POLICY "chat_messages_owner_select" ON chat_messages
	FOR SELECT TO authenticated USING (
		EXISTS (
			SELECT 1 FROM chat_threads t
			WHERE t.id = chat_messages.thread_id AND t.owner_id = auth.uid()
		)
	);
CREATE POLICY "chat_messages_owner_insert" ON chat_messages
	FOR INSERT TO authenticated WITH CHECK (
		EXISTS (
			SELECT 1 FROM chat_threads t
			WHERE t.id = chat_messages.thread_id AND t.owner_id = auth.uid()
		)
	);
CREATE POLICY "chat_messages_owner_delete" ON chat_messages
	FOR DELETE TO authenticated USING (
		EXISTS (
			SELECT 1 FROM chat_threads t
			WHERE t.id = chat_messages.thread_id AND t.owner_id = auth.uid()
		)
	);

REVOKE ALL ON TABLE chat_threads, chat_messages FROM anon, public;

CREATE OR REPLACE FUNCTION list_threads()
RETURNS TABLE (
	id         uuid,
	title      text,
	created_at timestamptz,
	updated_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
	SELECT id, title, created_at, updated_at
	FROM chat_threads
	WHERE owner_id = auth.uid()
	ORDER BY updated_at DESC
	LIMIT 200;
$$;

CREATE OR REPLACE FUNCTION get_thread(p_id uuid)
RETURNS TABLE (
	message_id uuid,
	role       text,
	content    jsonb,
	created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
	SELECT m.id, m.role, m.content, m.created_at
	FROM chat_messages m
	JOIN chat_threads  t ON t.id = m.thread_id
	WHERE t.id = p_id AND t.owner_id = auth.uid()
	ORDER BY m.created_at ASC;
$$;

CREATE OR REPLACE FUNCTION create_thread(p_title text)
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

	INSERT INTO chat_threads (owner_id, title)
	VALUES (v_uid, COALESCE(NULLIF(p_title, ''), 'New thread'))
	RETURNING chat_threads.id, chat_threads.created_at INTO v_id, v_at;

	RETURN QUERY SELECT v_id, v_at;
END;
$$;

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

	UPDATE chat_threads SET updated_at = now() WHERE id = p_thread;

	RETURN QUERY SELECT v_id, v_at;
END;
$$;

CREATE OR REPLACE FUNCTION rename_thread(p_id uuid, p_title text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
	UPDATE chat_threads
	SET title = COALESCE(NULLIF(p_title, ''), title),
	    updated_at = now()
	WHERE id = p_id AND owner_id = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION delete_thread(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
VOLATILE
AS $$
	DELETE FROM chat_threads WHERE id = p_id AND owner_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION list_threads()                        TO authenticated;
GRANT EXECUTE ON FUNCTION get_thread(uuid)                      TO authenticated;
GRANT EXECUTE ON FUNCTION create_thread(text)                   TO authenticated;
GRANT EXECUTE ON FUNCTION save_message(uuid, text, jsonb)       TO authenticated;
GRANT EXECUTE ON FUNCTION rename_thread(uuid, text)             TO authenticated;
GRANT EXECUTE ON FUNCTION delete_thread(uuid)                   TO authenticated;

REVOKE ALL ON FUNCTION list_threads()                      FROM anon, public;
REVOKE ALL ON FUNCTION get_thread(uuid)                    FROM anon, public;
REVOKE ALL ON FUNCTION create_thread(text)                 FROM anon, public;
REVOKE ALL ON FUNCTION save_message(uuid, text, jsonb)     FROM anon, public;
REVOKE ALL ON FUNCTION rename_thread(uuid, text)           FROM anon, public;
REVOKE ALL ON FUNCTION delete_thread(uuid)                 FROM anon, public;
