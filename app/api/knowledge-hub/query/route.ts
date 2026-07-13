// Knowledge Hub RAG pipeline (Appendix D + E).
// withGuard: rate limit + circuit breaker (Appendix B.1 + B.4)
// → extract query from UIMessage[] → sanitize + tier-scoped char cap (B.2)
// → embed with text-embedding-3-small
// → match_regdoc_chunks RPC (anon-only, SECURITY DEFINER, A.4)
// → D.3 fallback thresholds (top-1 < 0.50 → out-of-scope without LLM;
//   avg-8 < 0.35 → prepend "limited context" disclaimer)
// → build context envelope (D.2) + stream gpt-4o-mini via StreamingGuard (D.6)
// → emit sources as a custom data-sources message part

import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { NextResponse } from "next/server";
import { buildContextEnvelope } from "@/lib/context-envelope";
import { getRedis, recordOpenAICall, withGuard } from "@/lib/guard";
import { logGuardEvent } from "@/lib/logger";
import { getOpenAIClient, OPENAI_MODELS } from "@/lib/openai";
import { StreamingGuard } from "@/lib/output-guard";
import {
	KNOWLEDGE_HUB_OUT_OF_SCOPE,
	KNOWLEDGE_HUB_SYSTEM,
	PROMPT_VERSION,
} from "@/lib/prompts";
import {
	ENVELOPE_CHUNKS,
	LOW_SIM_DISCLAIMER,
	LOW_SIM_OOS,
	RetrievalError,
	retrieveChunks,
} from "@/lib/retrieval";
import {
	decodeBase64Probe,
	detectJailbreakMarkers,
	HARD_INPUT_CEILING,
	sanitizeQueryText,
	stripHtmlTags,
} from "@/lib/validators";

// Retrieval machinery (thresholds, doc-mention extraction, query expansion,
// rerank + envelope selection) lives in lib/retrieval.ts — shared verbatim
// with the artifact route.

// Successful LLM answers cache by query hash for 30 minutes. Saves OpenAI
// spend on the demo's canonical Appendix E starter questions which NPX
// evaluators + the eval battery hit repeatedly. Fallback / OOS branches are
// NOT cached — they're cheap (no LLM call) and should stay responsive to
// any drift in the corpus.
const CACHE_TTL_SECONDS = 30 * 60;

interface CachedAnswer {
	text: string;
	chunks: Array<{
		id: number;
		regdoc_id: string;
		section_number: string | null;
		section_title: string | null;
		url: string | null;
		similarity: number;
		requirement_type: "requirement" | "guidance" | null;
		snippet: string;
	}>;
}

async function cacheKey(query: string): Promise<string> {
	const buf = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`kh:${PROMPT_VERSION}:${query.toLowerCase()}`),
	);
	const hex = Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `kh:cache:${hex.slice(0, 24)}`;
}

interface UIMessageLike {
	role: string;
	parts?: Array<{ type: string; text?: string }>;
	content?: string;
}

function extractQuery(messages: UIMessageLike[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "user") continue;
		if (Array.isArray(m.parts)) {
			const text = m.parts
				.filter((p) => p?.type === "text" && typeof p.text === "string")
				.map((p) => p.text as string)
				.join(" ");
			if (text) return text;
		}
		if (typeof m.content === "string" && m.content.length > 0) return m.content;
	}
	return "";
}

export const POST = withGuard(
	{ route: "knowledge-hub/query" },
	async ({ req, ctx, supabase }) => {
		const body = (await req.json().catch(() => null)) as {
			messages?: UIMessageLike[];
			trigger?: string;
		} | null;
		const messages = body?.messages ?? [];
		const rawQuery = extractQuery(messages);
		const query = stripHtmlTags(sanitizeQueryText(rawQuery));
		// AI SDK tags the request with the user's intent. On "regenerate-
		// assistant-message" (the Refresh button in the assistant action bar)
		// we bypass the Redis answer cache AND invalidate any existing entry,
		// so a user who regenerates gets a genuinely fresh call to OpenAI.
		const isRegenerate = body?.trigger === "regenerate-assistant-message";

		ctx.logFields.prompt_version = PROMPT_VERSION;
		ctx.logFields.query_len = query.length;
		ctx.logFields.model = OPENAI_MODELS.chat;
		ctx.logFields.trigger = body?.trigger ?? "unknown";

		const logValidation = (detail: string) =>
			logGuardEvent({
				route: "knowledge-hub/query",
				reason: "validation",
				ip_hash: ctx.ipHash,
				tier: ctx.tier,
				user_hash: ctx.userHash,
				detail,
			});
		const validationError = (detail: string, message: string) => {
			logValidation(detail);
			return NextResponse.json(
				{ error: "validation", message },
				{ status: 400 },
			);
		};

		if (!query) return validationError("empty_query", "Query is required.");
		// Absolute ceiling first — a long wall-of-noise + needle attack must
		// never reach the model even if a tier's cap is later raised.
		if (query.length > HARD_INPUT_CEILING)
			return validationError("hard_ceiling", "Query exceeds maximum length.");
		if (query.length > ctx.inputCharCap)
			return validationError(
				`char_cap_${ctx.inputCharCap}`,
				`Query exceeds ${ctx.inputCharCap} character limit for your tier.`,
			);

		// Jailbreak short-circuit: scan the raw query AND any base64 payload
		// hidden inside it. On any marker hit, refuse with the canonical
		// out-of-scope line via the same streaming path the cache-hit branch
		// uses — skips embed + RPC + LLM, so the attacker gets no feedback
		// channel and the call costs nothing.
		const decodedProbe = decodeBase64Probe(query);
		const markers = [
			...detectJailbreakMarkers(query),
			...(decodedProbe ? detectJailbreakMarkers(decodedProbe) : []),
		];
		if (markers.length > 0) {
			logValidation(`jailbreak_markers:${markers.length}`);
			ctx.logFields.jailbreak_blocked = true;
			ctx.logFields.fallback_taken = true;
			ctx.logFields.output_tokens = 0;
			const refusalStream = createUIMessageStream({
				execute: async ({ writer }) => {
					const msgId = crypto.randomUUID();
					writer.write({ type: "text-start", id: msgId });
					writer.write({
						type: "text-delta",
						id: msgId,
						delta: KNOWLEDGE_HUB_OUT_OF_SCOPE,
					});
					writer.write({ type: "text-end", id: msgId });
				},
			});
			return createUIMessageStreamResponse({ stream: refusalStream });
		}

		// Cache hit check — skips embed + RPC + LLM for repeat queries.
		// Regenerate requests bypass the cache AND drop the stored entry, so
		// the new response overwrites the stale one for future hits.
		const redis = getRedis();
		const cKey = await cacheKey(query);
		if (isRegenerate) {
			redis
				.del(cKey)
				.catch((err) => console.error("kh_cache_invalidate_error", err));
		}
		const cached = isRegenerate
			? null
			: ((await redis.get<CachedAnswer>(cKey)) ?? null);
		if (cached?.text) {
			ctx.logFields.cache = "hit";
			ctx.logFields.fallback_taken = false;
			ctx.logFields.output_tokens = 0;
			const cachedStream = createUIMessageStream({
				execute: async ({ writer }) => {
					const msgId = crypto.randomUUID();
					writer.write({ type: "text-start", id: msgId });
					writer.write({ type: "text-delta", id: msgId, delta: cached.text });
					writer.write({
						type: "data-sources",
						data: { chunks: cached.chunks },
					});
					writer.write({ type: "text-end", id: msgId });
				},
			});
			return createUIMessageStreamResponse({ stream: cachedStream });
		}
		ctx.logFields.cache = "miss";

		const openai = getOpenAIClient();

		let retrieval: Awaited<ReturnType<typeof retrieveChunks>>;
		try {
			retrieval = await retrieveChunks(
				query,
				{ supabase, openai },
				{ envelopeChunks: ENVELOPE_CHUNKS },
			);
		} catch (err) {
			if (err instanceof RetrievalError) {
				return NextResponse.json(
					{
						error: "internal_error",
						message:
							err.stage === "embedding"
								? "Embedding failed."
								: "Retrieval failed.",
					},
					{ status: 500 },
				);
			}
			throw err;
		}
		const { envelope: chunks, topSim, avgSim, mentionedDocs } = retrieval;
		ctx.logFields.retrieval_top_sim = Number(topSim.toFixed(4));
		ctx.logFields.retrieval_avg_sim = Number(avgSim.toFixed(4));

		const stream = createUIMessageStream({
			execute: async ({ writer }) => {
				const msgId = crypto.randomUUID();
				writer.write({ type: "text-start", id: msgId });

				if (topSim < LOW_SIM_OOS) {
					writer.write({
						type: "text-delta",
						id: msgId,
						delta: KNOWLEDGE_HUB_OUT_OF_SCOPE,
					});
					writer.write({ type: "text-end", id: msgId });
					ctx.logFields.fallback_taken = true;
					ctx.logFields.output_tokens = 0;
					return;
				}

				const envelope = buildContextEnvelope(chunks, query, mentionedDocs);
				const guard = new StreamingGuard();
				let outputTokens = 0;
				let accumulated = "";
				let outputGuardTripped = false;

				const emit = (delta: string): { terminate: boolean } => {
					const r = guard.push(delta);
					if (r.safeTokens) {
						writer.write({
							type: "text-delta",
							id: msgId,
							delta: r.safeTokens,
						});
						accumulated += r.safeTokens;
					}
					if (r.terminate) outputGuardTripped = true;
					if (r.terminate && r.reason) {
						logGuardEvent({
							route: "knowledge-hub/query",
							reason: "output_guard",
							ip_hash: ctx.ipHash,
							tier: ctx.tier,
							user_hash: ctx.userHash,
							detail: r.reason,
						});
					}
					return { terminate: r.terminate };
				};

				if (avgSim < LOW_SIM_DISCLAIMER) {
					emit(
						"_Limited matches in the indexed corpus for this question — answering from the strongest available snippets._\n\n",
					);
				}

				try {
					const completion = await openai.chat.completions.create({
						model: OPENAI_MODELS.chat,
						stream: true,
						max_tokens: ctx.outputMaxTokens,
						temperature: 0.2,
						messages: [
							{ role: "system", content: KNOWLEDGE_HUB_SYSTEM },
							{ role: "user", content: envelope },
						],
					});

					for await (const part of completion) {
						const delta = part.choices[0]?.delta?.content ?? "";
						if (!delta) continue;
						outputTokens += 1;
						if (emit(delta).terminate) break;
					}
					await recordOpenAICall(0);
				} catch (err) {
					console.error("openai_stream_error", err);
					writer.write({
						type: "text-delta",
						id: msgId,
						delta: "\n\n_[error generating response]_",
					});
				}

				const sourceChunks = chunks.map((c) => ({
					id: c.id,
					regdoc_id: c.regdoc_id,
					section_number: c.section_number,
					section_title: c.section_title,
					url: c.url,
					similarity: Number(c.similarity.toFixed(4)),
					requirement_type: c.requirement_type,
					snippet: c.chunk_text.slice(0, 260),
				}));
				writer.write({
					type: "data-sources",
					data: { chunks: sourceChunks },
				});
				writer.write({ type: "text-end", id: msgId });

				ctx.logFields.fallback_taken = false;
				ctx.logFields.output_tokens = outputTokens;

				// Cache only clean, successful answers (not output-guard truncations).
				// Raised from 60 → 400 so truncated/timeout responses that only emit
				// one sentence before the upstream fetch aborts can't poison the cache
				// and get served to later identical queries.
				if (!outputGuardTripped && accumulated.trim().length > 400) {
					redis
						.set(
							cKey,
							{ text: accumulated, chunks: sourceChunks },
							{
								ex: CACHE_TTL_SECONDS,
							},
						)
						.catch((err) => console.error("kh_cache_write_error", err));
				}
			},
		});

		return createUIMessageStreamResponse({ stream });
	},
);
