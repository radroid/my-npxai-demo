// Thread list + create (Phase 6B.persistence).
// Signed-in only; anon users keep their threads in localStorage.
// RPCs: list_threads (returns {id, title, created_at, updated_at}),
// create_thread(text) (returns {id, created_at}). Both are SECURITY DEFINER
// with authenticated-only EXECUTE — the anon client passes the session
// cookie via @supabase/ssr, the RPCs scope by auth.uid().

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";

async function requireUser() {
	const supabase = await createSupabaseServerClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	return { supabase, user };
}

export async function GET() {
	const { supabase, user } = await requireUser();
	if (!user)
		return NextResponse.json({ error: "auth_required" }, { status: 401 });

	const { data, error } = await supabase.rpc("list_threads");
	if (error) {
		console.error("list_threads failed", error);
		return NextResponse.json({ error: "rpc_failed" }, { status: 500 });
	}
	return NextResponse.json({ threads: data ?? [] });
}

export async function POST(req: Request) {
	const { supabase, user } = await requireUser();
	if (!user)
		return NextResponse.json({ error: "auth_required" }, { status: 401 });

	let title = "New thread";
	try {
		const body = (await req.json()) as { title?: string };
		if (typeof body?.title === "string" && body.title.trim())
			title = body.title.trim().slice(0, 120);
	} catch {
		// empty / malformed body — use default title
	}

	const { data, error } = await supabase.rpc("create_thread", {
		p_title: title,
	});
	if (error) {
		// PostgrestError's fields aren't own-enumerable, so the default
		// console inspector prints `{}`. Hand-serialize the useful bits.
		console.error(
			`create_thread failed: ${JSON.stringify({
				message: error.message,
				code: error.code,
				details: error.details,
				hint: error.hint,
			})}`,
		);
		return NextResponse.json({ error: "rpc_failed" }, { status: 500 });
	}
	const row = Array.isArray(data) ? data[0] : data;
	if (!row?.id) {
		// Guards against the RPC returning `[{id:null,...}]` on a silent
		// partial failure — the client would otherwise POST messages to
		// /api/threads/null/messages and silently lose the turn.
		console.error("create_thread returned empty row", { data });
		return NextResponse.json({ error: "empty_row" }, { status: 500 });
	}
	return NextResponse.json({ id: row.id, created_at: row.created_at, title });
}
