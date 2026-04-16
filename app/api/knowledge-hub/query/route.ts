import { NextResponse } from "next/server";

// Phase 1 stub. Real implementation lands in Phase 3: withGuard wrap,
// embed query, call match_regdoc_chunks RPC, apply D.3 fallback thresholds,
// stream from gpt-4o-mini through StreamingGuard. See TODO.md Phase 3.
export async function POST(): Promise<Response> {
	return NextResponse.json(
		{ error: "not_implemented", message: "Knowledge Hub query handler arrives in Phase 3." },
		{ status: 501 },
	);
}
