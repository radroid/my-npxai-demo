import { NextResponse } from "next/server";

// Phase 1 stub. Real implementation lands in Phase 4: withGuard wrap,
// get_turnover_snapshot RPC, GENERATOR_SYSTEM with max_tokens: 1500.
export async function POST(): Promise<Response> {
	return NextResponse.json(
		{ error: "not_implemented", message: "Generator turnover handler arrives in Phase 4." },
		{ status: 501 },
	);
}
