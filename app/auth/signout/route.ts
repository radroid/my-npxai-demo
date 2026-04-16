import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";

// POST-only to prevent accidental signout via link prefetches.
export async function POST(request: Request): Promise<Response> {
	const supabase = await createSupabaseServerClient();
	await supabase.auth.signOut();
	return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
