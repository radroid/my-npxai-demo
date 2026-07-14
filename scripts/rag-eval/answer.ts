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
import { embeddingInputsFor } from "../../lib/retrieval";
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
export function countTokens(text: string): number {
	if (!encoder) encoder = get_encoding("cl100k_base");
	return encoder.encode(text).length;
}

export function freeEncoder(): void {
	encoder?.free();
	encoder = null;
}

// --- Charging the parts of the real prompt we cannot observe ---
//
// PR #8 fix round 1 (issue 3). The accountant used to estimate the answerer's
// input from `sources[].snippet` — but `snippet` is the SSE DISPLAY projection
// `chunk_text.slice(0, 260)` (route.ts), while the model's real prompt carries
// the FULL ~400-token `chunk_text` through buildContextEnvelope. Real spend
// therefore systematically exceeded what EVAL_COST_CAP_USD bounded, by roughly
// 4-6x on the input side. Callers now reconstruct the REAL envelope from full
// chunk_text (fetched by id) and pass it as `envelopeText`.
//
// PR #8 fix round 2 (issue 3). The route's embedding call is now counted
// EXACTLY (serverEmbeddingInputTokens below) rather than guessed at with a
// multiplier — see that function for why the old "err-high" constant erred LOW.
//
// What remains a factor is the ONE unobservable left (a chunk whose full text
// could not be re-fetched), and it ERRS HIGH by construction — wallet protection
// fails safe: over-estimate, never under-estimate.

/**
 * Correction factor for a chunk whose full text we could NOT fetch (id missing
 * from the corpus — should not happen; the fingerprint preflight would have
 * caught it). ~400-token chunks (scripts/ingest.ts:21) vs a 260-char snippet
 * (~65 cl100k tokens) ⇒ a true ratio of ~6.2. Rounded UP to 7 so the fallback
 * can only over-charge, never under-charge.
 */
export const SNIPPET_TO_FULL_CHUNK_FACTOR = 7;

/**
 * EXACT token count of the embedding call the ROUTE makes for this question
 * (PR #8 fix round 2, issue 3 — WALLET).
 *
 * THE BUG THIS REPLACES. The route embeds the query PLUS every expansion
 * `buildExpansions` generates, in ONE `embeddings.create` call inside the dev
 * server — a spending path the eval script cannot observe. It used to be charged
 * as the question's tokens times a hardcoded multiplier of 5, documented as
 * "1 primary + 4 expansions, above the practical ceiling". That was not a
 * ceiling and it errs LOW: `buildExpansions` emits, per mentioned doc,
 * one narrow expansion per mentioned section + one per matched concept seed + one
 * BROAD `${doc} ${query}` that carries the WHOLE query. `extractMentionedDocs`
 * can return an unbounded number of docs (every REGDOC named, plus up to 4
 * concept hints), so the real input is roughly `(1 + docs) x tokens(query)` plus
 * the narrow/concept expansions — past 5x as soon as 5 docs are in scope, which
 * the golden set's multi-doc questions are built to do.
 *
 * The honest fix is not a bigger guess: the expansion list is a PURE FUNCTION of
 * the query, so we call the SAME function production calls
 * (`lib/retrieval.ts embeddingInputsFor`) and count the real strings. Free, no
 * network, EXACT rather than bounded. text-embedding-3-small tokenizes with
 * cl100k_base — the encoder used here — so the count is the count OpenAI bills.
 */
export function serverEmbeddingInputTokens(question: string): number {
	return embeddingInputsFor(question).reduce(
		(acc, input) => acc + countTokens(input),
		0,
	);
}

/** Nominal full chunk size in tokens (scripts/ingest.ts:21) — used only by the
 *  pre-call worst-case projection below. */
export const CHUNK_TOKENS_ESTIMATE = 400;

/** Anon-tier output cap (lib/validators.ts) — the most the answerer can emit. */
export const ANSWERER_MAX_OUTPUT_TOKENS = 800;

/**
 * PRE-CALL cost-cap reservation for one server answer (issue 4a). The spend
 * happens INSIDE the dev server, so a post-hoc `record()` can only ever notice
 * a breach after the money is gone. Reserve the WORST CASE first: the system
 * prompt + a full envelope of ENVELOPE_CHUNKS × ~400-token chunks + the
 * question, and the tier's maximum output. Throws CostCapError (projected)
 * before the request is made.
 */
export function reserveAnswerCost(
	cost: CostAccountant,
	args: {
		systemPrompt: string;
		question: string;
		envelopeChunks: number;
		label: string;
	},
): void {
	const inputTokens =
		countTokens(`${args.systemPrompt}\n${args.question}`) +
		args.envelopeChunks * CHUNK_TOKENS_ESTIMATE;
	cost.reserve({
		kind: "answerer_estimated",
		model: ANSWERER_MODEL,
		inputTokens,
		outputTokens: ANSWERER_MAX_OUTPUT_TOKENS,
		estimated: true,
		label: `${args.label}:projected`,
	});
	cost.reserve({
		kind: "embeddings",
		model: EMBEDDING_MODEL,
		// EXACT (issue 3): the same input list production will send, counted.
		inputTokens: serverEmbeddingInputTokens(args.question),
		outputTokens: 0,
		estimated: true,
		label: `${args.label}:server-embedding:projected`,
	});
}

/**
 * Charge the accountant for one server-side answer: the answerer completion
 * (estimated) plus the retrieval embedding it performed (estimated).
 *
 * `envelopeText` MUST be the reconstructed REAL prompt envelope (full
 * chunk_text via lib/context-envelope's buildContextEnvelope) — never the
 * truncated SSE snippets. `unresolvedSnippets` carries the display snippets of
 * any chunk whose full text could not be fetched; they are charged at
 * SNIPPET_TO_FULL_CHUNK_FACTOR so the estimate still errs high.
 */
export function recordAnswerCost(
	cost: CostAccountant,
	args: {
		systemPrompt: string;
		question: string;
		envelopeText: string;
		unresolvedSnippets?: string[];
		answer: string;
		label: string;
	},
): void {
	const unresolvedTokens = (args.unresolvedSnippets ?? []).reduce(
		(acc, s) => acc + countTokens(s) * SNIPPET_TO_FULL_CHUNK_FACTOR,
		0,
	);
	const inputTokens =
		countTokens(`${args.systemPrompt}\n${args.envelopeText}\n${args.question}`) +
		unresolvedTokens;
	cost.record({
		kind: "answerer_estimated",
		model: ANSWERER_MODEL,
		inputTokens,
		outputTokens: countTokens(args.answer),
		estimated: true,
		label: args.label,
	});
	// The route embeds the query AND every expansion in one call. We cannot see
	// that call, but its input is a pure function of the question — so we count
	// the REAL strings via lib/retrieval's embeddingInputsFor (issue 3), instead
	// of multiplying the question by a constant that was never a ceiling.
	cost.record({
		kind: "embeddings",
		model: EMBEDDING_MODEL,
		inputTokens: serverEmbeddingInputTokens(args.question),
		outputTokens: 0,
		estimated: true,
		label: `${args.label}:server-embedding`,
	});
}
