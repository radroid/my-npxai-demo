import { createUIMessageStream, createUIMessageStreamResponse } from "ai";

// Phase 2 iter 4 mock. Streams a deterministic UIMessage response so the
// assistant-ui round-trip can be tested end-to-end without hitting OpenAI or
// Supabase. Phase 3 replaces this entire handler with the real pipeline:
// withGuard wrap → embed query → match_regdoc_chunks RPC → D.3 fallback
// thresholds → gpt-4o-mini streaming through StreamingGuard.

const MOCK_RESPONSE = [
	"This is a **mock streamed response** from the Phase 2 round-trip test.\n\n",
	"Once Phase 3 lands, the real handler will cite sources like ",
	"REGDOC-2.3.4 §3.2.3 for shift turnover and REGDOC-2.2.5 §3.1 for ",
	"minimum-staff-complement questions, retrieved from the 1945-chunk ",
	"Supabase pgvector corpus.\n\n",
	"For now, this text confirms the assistant-ui → `/api/knowledge-hub/query` ",
	"wiring is working.",
];

export async function POST(): Promise<Response> {
	const stream = createUIMessageStream({
		execute: async ({ writer }) => {
			const id = crypto.randomUUID();
			writer.write({ type: "text-start", id });
			for (const chunk of MOCK_RESPONSE) {
				writer.write({ type: "text-delta", id, delta: chunk });
				await new Promise((resolve) => setTimeout(resolve, 30));
			}
			writer.write({ type: "text-end", id });
		},
	});
	return createUIMessageStreamResponse({ stream });
}
