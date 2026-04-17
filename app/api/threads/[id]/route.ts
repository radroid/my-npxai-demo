// Per-thread operations: replay messages (GET), rename (PATCH), delete (DELETE).
// RLS + RPC auth scoping means a request with the wrong user's session returns
// an empty result set (GET) or no-op (PATCH/DELETE) rather than leaking.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";

async function requireUser() {
	const supabase = await createSupabaseServerClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	return { supabase, user };
}

function isUuid(s: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		s,
	);
}

export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	if (!isUuid(id))
		return NextResponse.json({ error: "invalid_id" }, { status: 400 });

	const { supabase, user } = await requireUser();
	if (!user)
		return NextResponse.json({ error: "auth_required" }, { status: 401 });

	const { data, error } = await supabase.rpc("get_thread", { p_id: id });
	if (error) {
		console.error("get_thread failed", error);
		return NextResponse.json({ error: "rpc_failed" }, { status: 500 });
	}
	return NextResponse.json({ messages: data ?? [] });
}

export async function PATCH(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	if (!isUuid(id))
		return NextResponse.json({ error: "invalid_id" }, { status: 400 });

	const { supabase, user } = await requireUser();
	if (!user)
		return NextResponse.json({ error: "auth_required" }, { status: 401 });

	const body = (await req.json().catch(() => ({}))) as { title?: string };
	const title = typeof body?.title === "string" ? body.title.trim() : "";
	if (!title)
		return NextResponse.json({ error: "title_required" }, { status: 400 });

	const { error } = await supabase.rpc("rename_thread", {
		p_id: id,
		p_title: title.slice(0, 120),
	});
	if (error) {
		console.error("rename_thread failed", error);
		return NextResponse.json({ error: "rpc_failed" }, { status: 500 });
	}
	return NextResponse.json({ ok: true, title: title.slice(0, 120) });
}

export async function DELETE(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	if (!isUuid(id))
		return NextResponse.json({ error: "invalid_id" }, { status: 400 });

	const { supabase, user } = await requireUser();
	if (!user)
		return NextResponse.json({ error: "auth_required" }, { status: 401 });

	const { error } = await supabase.rpc("delete_thread", { p_id: id });
	if (error) {
		console.error("delete_thread failed", error);
		return NextResponse.json({ error: "rpc_failed" }, { status: 500 });
	}
	return NextResponse.json({ ok: true });
}
