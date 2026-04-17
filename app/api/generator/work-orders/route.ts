import { NextResponse } from "next/server";

export async function GET(): Promise<Response> {
	return NextResponse.json(
		{
			error: "not_implemented",
			message: "Work orders handler arrives in Phase 4.",
		},
		{ status: 501 },
	);
}
