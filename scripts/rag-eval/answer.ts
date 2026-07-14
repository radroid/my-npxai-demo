// RAG eval framework — dev-server answer harness (item-2 slice 2.1, R8).
//
// Generation-stage metrics must score the REAL production path, so answers come
// from an HTTP POST to the running dev server — never a re-implementation.
// I2.11: this module never starts, restarts, or kills the server; it only makes
// requests. (Slice 2.1 SHIPS this harness; slice 2.2 EXERCISES it.)
//
// Two non-negotiables, both from the spec:
//   - `x-eval-bypass: $EVAL_BYPASS_KEY` — without it, anon limits are 3/min and
//     5/day (lib/guard.ts) and the first 429 is FATAL (Edge case 2), never
//     retried.
//   - `trigger: "regenerate-assistant-message"` — bypasses AND invalidates the
//     30-min Redis answer cache (route.ts). Without it the consistency x5
//     experiment would measure the cache, not the model (Edge case 7).
//
// The `data-sources` frame is ABSENT on jailbreak-guard / OOS-gate refusals
// (Edge case 4) — `sources` is null there, and that is a normal outcome, not an
// error.

import { get_encoding } from "tiktoken";
import { ANSWERER_MODEL, EMBEDDING_MODEL, baseUrl } from "./config";
import type { CostAccountant } from "./cost";
import { type ParsedStream, parseStream } from "./sse";

export interface AnswerResult extends ParsedStream {
	status: number;
	latencyMs: number;
	/** Raw response body — kept for the item log when parsing surprises us. */
	raw: string;
}

export class RateLimitedError extends Error {
	constructor() {
		super(
			"Dev server returned 429. EVAL_BYPASS_KEY is missing or does not match " +
				"the server's value — anon limits are 3/min, 5/day (lib/guard.ts). " +
				"Set EVAL_BYPASS_KEY in .env.local and re-run. The runner never " +
				"retry-spins on 429 (Edge case 2).",
		);
		this.name = "RateLimitedError";
	}
}

export function endpoint(): string {
	return `${baseUrl()}/api/knowledge-hub/query`;
}

/** UIMessage POST body — same shape as scripts/eval-kb.ts buildBody(), with the
 * mandatory regenerate trigger (R8) swapped in for "submit-message". */
export function buildBody(question: string): Record<string, unknown> {
	return {
		id: `rag-eval-${crypto.randomUUID()}`,
		messages: [
			{
				id: crypto.randomUUID(),
				role: "user",
				parts: [{ type: "text", text: question }],
			},
		],
		trigger: "regenerate-assistant-message",
	};
}

/** One sequential request against the production route. Throws on 429. */
export async function askServer(question: string): Promise<AnswerResult> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	const bypassKey = process.env.EVAL_BYPASS_KEY;
	if (bypassKey) headers["x-eval-bypass"] = bypassKey;

	const start = Date.now();
	const res = await fetch(endpoint(), {
		method: "POST",
		headers,
		body: JSON.stringify(buildBody(question)),
	});
	const raw = await res.text();
	const latencyMs = Date.now() - start;
	if (res.status === 429) throw new RateLimitedError();
	const parsed = parseStream(raw);
	return { ...parsed, status: res.status, latencyMs, raw };
}

/** Cheap liveness probe used by preflight — GET, no OpenAI spend. */
export async function serverReachable(): Promise<boolean> {
	try {
		const res = await fetch(baseUrl(), { method: "GET" });
		return res.status < 500;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Answerer cost ESTIMATION (R9). The SSE stream carries no `usage` field, so
// the server-side spend is estimated with tiktoken over what we know went in
// (system prompt + envelope + question) and what came out (the answer text),
// priced at gpt-4o-mini. The envelope's own embedding call is estimated the
// same way at text-embedding-3-small prices.
//
// cl100k_base is used for both models (o200k is gpt-4o's native encoding; the
// delta is a few percent on English prose and this whole number is explicitly
// an ESTIMATE, labelled as such in every cost report).

let encoder: ReturnType<typeof get_encoding> | null = null;
function countTokens(text: string): number {
	if (!encoder) encoder = get_encoding("cl100k_base");
	return encoder.encode(text).length;
}

export function freeEncoder(): void {
	encoder?.free();
	encoder = null;
}

/**
 * Charge the accountant for one server-side answer: the answerer completion
 * (estimated) plus the retrieval embedding it performed (estimated).
 */
export function recordAnswerCost(
	cost: CostAccountant,
	args: {
		systemPrompt: string;
		question: string;
		envelopeText: string;
		answer: string;
		label: string;
	},
): void {
	const inputTokens = countTokens(
		`${args.systemPrompt}\n${args.envelopeText}\n${args.question}`,
	);
	cost.record({
		kind: "answerer_estimated",
		model: ANSWERER_MODEL,
		inputTokens,
		outputTokens: countTokens(args.answer),
		estimated: true,
		label: args.label,
	});
	// The route embeds the query (plus any expansions) before retrieving. We
	// only observe the question, so this is a floor estimate — noted in the
	// report's cost appendix.
	cost.record({
		kind: "embeddings",
		model: EMBEDDING_MODEL,
		inputTokens: countTokens(args.question),
		outputTokens: 0,
		estimated: true,
		label: `${args.label}:server-embedding`,
	});
}
