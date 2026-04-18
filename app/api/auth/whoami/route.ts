// Server-validated auth probe. The client can't trust supabase.auth.getSession()
// on its own — that reads from localStorage and can return a session object
// long after the underlying cookie expired or was invalidated. This endpoint
// calls getUser(), which round-trips to the Supabase auth server and returns
// null for a stale refresh token. Client reconciles its view of the tier via
// this route on mount + on focus so "server says anon, I thought signed_in"
// is caught before the next rate-limited query instead of after.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";

export async function GET(): Promise<Response> {
	const supabase = await createSupabaseServerClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) {
		return NextResponse.json({ signedIn: false, tier: "anon", email: null });
	}

	const { data: tierRow } = await supabase.rpc("get_user_tier", {
		p_user_id: user.id,
	});
	const tier = tierRow === "npx_circle" ? "npx_circle" : "signed_in";

	return NextResponse.json({
		signedIn: true,
		tier,
		email: user.email ?? null,
	});
}
