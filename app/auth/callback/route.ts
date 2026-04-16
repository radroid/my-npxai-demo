import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";

// Magic-link callback. Exchanges the `code` query param for a session
// cookie via @supabase/ssr, then redirects to /knowledge-hub. See
// Appendix J.3 step 4.
export async function GET(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const next = url.searchParams.get("next") ?? "/knowledge-hub";

	if (!code) {
		return NextResponse.redirect(new URL("/?auth_error=missing_code", url));
	}

	const supabase = await createSupabaseServerClient();
	const { error } = await supabase.auth.exchangeCodeForSession(code);
	if (error) {
		return NextResponse.redirect(new URL("/?auth_error=exchange_failed", url));
	}

	return NextResponse.redirect(new URL(next, url));
}
