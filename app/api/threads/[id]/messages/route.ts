// Append a message to a thread. Called after each user/assistant turn.
// Role is constrained server-side by the save_message RPC (user | assistant
// | system); content is jsonb so we can store structured parts.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";

const ROLES = new Set(["user", "assistant", "system"]);

function isUuid(s: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		s,
	);
}

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	if (!isUuid(id))
		return NextResponse.json({ error: "invalid_id" }, { status: 400 });

	const supabase = await createSupabaseServerClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user)
		return NextResponse.json({ error: "auth_required" }, { status: 401 });

	let body: { role?: string; content?: unknown };
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return NextResponse.json({ error: "invalid_json" }, { status: 400 });
	}
	const role = typeof body?.role === "string" ? body.role : "";
	if (!ROLES.has(role))
		return NextResponse.json({ error: "invalid_role" }, { status: 400 });
	if (body.content === undefined)
		return NextResponse.json({ error: "content_required" }, { status: 400 });

	const { data, error } = await supabase.rpc("save_message", {
		p_thread: id,
		p_role: role,
		p_content: body.content,
	});
	if (error) {
		console.error("save_message failed", error);
		return NextResponse.json({ error: "rpc_failed" }, { status: 500 });
	}
	const row = Array.isArray(data) ? data[0] : data;
	return NextResponse.json({ id: row?.id, created_at: row?.created_at });
}
