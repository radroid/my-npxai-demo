// Knowledge Hub Artifact mode (item-1 slice 1.1). One regulatory question →
// one self-contained NPX-branded HTML explainer.
// withGuard (tier rate limits + circuit breaker, tighter LIMITS than chat)
// → zod body shape → sanitize + tier char caps (identical chain to chat)
// → jailbreak short-circuit (no OpenAI call)
// → Redis artifact cache (24h; keyed on prompt version + model + query)
// → shared lib/retrieval.ts pipeline (12-chunk envelope) + D.3 gates
// → gpt-4o-mini (env-overridable) accumulated SERVER-SIDE — raw deltas
//   never leave the server (I1.12); client gets progress counts only
// → lib/artifact-sanitizer.ts contract enforcement + deny-scan abort gate
// → lib/artifact-template.ts deterministic shell assembly (I1.4)
// → SSE events: meta / progress / artifact / done / error

import { NextResponse } from "next/server";
import { sanitizeArtifactFragment } from "@/lib/artifact-sanitizer";
import {
	type ArtifactSource,
	assembleArtifactDocument,
} from "@/lib/artifact-template";
import { buildContextEnvelope } from "@/lib/context-envelope";
import { getRedis, recordOpenAICall, withGuard } from "@/lib/guard";
import { logGuardEvent } from "@/lib/logger";
import { getArtifactModel, getOpenAIClient } from "@/lib/openai";
import {
	KNOWLEDGE_HUB_ARTIFACT_SYSTEM,
	KNOWLEDGE_HUB_OUT_OF_SCOPE,
	PROMPT_VERSION,
} from "@/lib/prompts";
import {
	LOW_SIM_DISCLAIMER,
	LOW_SIM_OOS,
	RetrievalError,
	retrieveChunks,
} from "@/lib/retrieval";
import {
	artifactInputSchema,
	decodeBase64Probe,
	detectJailbreakMarkers,
	HARD_INPUT_CEILING,
	sanitizeQueryText,
	stripHtmlTags,
} from "@/lib/validators";

// Hard output cap (invariant I1.5/I1.9): ~4× the anon chat answer cap of
// 800 tokens — a small multiple of one chat answer. Not tier-scoped; tiers
// differentiate via the LIMITS entry in lib/guard.ts.
const ARTIFACT_MAX_TOKENS = 3000;
// Explainers span more sections than chat answers; chat keeps its
// calibrated 8 via its own call site (lib/retrieval.ts ENVELOPE_CHUNKS).
const ARTIFACT_ENVELOPE_CHUNKS = 12;
// 24h — higher unit cost than chat justifies longer than chat's 30m.
const ARTIFACT_CACHE_TTL_SECONDS = 24 * 60 * 60;
// Progress cadence: keeps bytes flowing so proxies don't idle-out a
// 30–60s generation, and feeds the workbench progress UI.
const PROGRESS_EVERY_TOKENS = 250;

type SseEvent = "meta" | "progress" | "artifact" | "done" | "error";

function sseFrame(event: SseEvent, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const SSE_HEADERS = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache, no-store, must-revalidate",
	"x-accel-buffering": "no",
} as const;

// One-shot SSE error — used for pre-stream refusals (jailbreak, OOS) so the
// client always speaks one protocol on 200 responses.
function sseErrorResponse(code: string, message: string): Response {
	return new Response(sseFrame("error", { code, message }), {
		headers: SSE_HEADERS,
	});
}

interface CachedArtifact {
	html: string;
	sources: ArtifactSource[];
}

async function cacheKey(query: string, model: string): Promise<string> {
	const buf = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			`kh-artifact:${PROMPT_VERSION}:${model}:${query.toLowerCase()}`,
		),
	);
	const hex = Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `kh:artifact:cache:${hex.slice(0, 24)}`;
}

export const POST = withGuard(
	{ route: "knowledge-hub/artifact" },
	async ({ req, ctx, supabase }) => {
		const body = await req.json().catch(() => null);
		const parsed = artifactInputSchema.safeParse(body);

		const logValidation = (detail: string) =>
			logGuardEvent({
				route: "knowledge-hub/artifact",
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

		if (!parsed.success)
			return validationError(
				"schema_reject",
				"Body must be { query: string }.",
			);

		const query = stripHtmlTags(sanitizeQueryText(parsed.data.query));
		const model = getArtifactModel();

		ctx.logFields.prompt_version = PROMPT_VERSION;
		ctx.logFields.query_len = query.length;
		ctx.logFields.model = model;

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
		// out-of-scope line — skips embed + RPC + LLM, so the attacker gets
		// no feedback channel and the call costs nothing.
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
			return sseErrorResponse("out_of_scope", KNOWLEDGE_HUB_OUT_OF_SCOPE);
		}

		// Cache hit check — skips embed + RPC + LLM for repeat queries.
		const redis = getRedis();
		const cKey = await cacheKey(query, model);
		let cached: CachedArtifact | null = null;
		try {
			cached = (await redis.get<CachedArtifact>(cKey)) ?? null;
		} catch (err) {
			console.error("artifact_cache_read_error", err);
		}
		if (cached?.html) {
			ctx.logFields.cache = "hit";
			ctx.logFields.fallback_taken = false;
			ctx.logFields.output_tokens = 0;
			ctx.logFields.artifact_bytes = cached.html.length;
			const frames =
				sseFrame("meta", {
					model,
					chunks: cached.sources.length,
					cached: true,
				}) +
				sseFrame("artifact", {
					html: cached.html,
					sources: cached.sources,
					truncated: false,
					limitedCoverage: false,
					cached: true,
				}) +
				sseFrame("done", { cached: true });
			return new Response(frames, { headers: SSE_HEADERS });
		}
		ctx.logFields.cache = "miss";

		const openai = getOpenAIClient();

		let retrieval: Awaited<ReturnType<typeof retrieveChunks>>;
		try {
			retrieval = await retrieveChunks(
				query,
				{ supabase, openai },
				{ envelopeChunks: ARTIFACT_ENVELOPE_CHUNKS },
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

		// D.3 OOS gate — refuse without any completion call.
		if (topSim < LOW_SIM_OOS) {
			ctx.logFields.fallback_taken = true;
			ctx.logFields.output_tokens = 0;
			return sseErrorResponse("out_of_scope", KNOWLEDGE_HUB_OUT_OF_SCOPE);
		}

		// Weak retrieval: generation proceeds, but the assembled document gets
		// a server-injected "limited corpus coverage" callout (not LLM-prompted).
		const limitedCoverage = avgSim < LOW_SIM_DISCLAIMER;

		const envelope = buildContextEnvelope(chunks, query, mentionedDocs);
		const sources: ArtifactSource[] = chunks.map((c) => ({
			id: c.id,
			regdoc_id: c.regdoc_id,
			section_number: c.section_number,
			section_title: c.section_title,
			url: c.url,
			similarity: Number(c.similarity.toFixed(4)),
			requirement_type: c.requirement_type,
			snippet: c.chunk_text.slice(0, 260),
		}));

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const send = (event: SseEvent, data: unknown) =>
					controller.enqueue(encoder.encode(sseFrame(event, data)));

				send("meta", { model, chunks: chunks.length, cached: false });

				let accumulated = "";
				let outputTokens = 0;
				let finishReason: string | null = null;
				try {
					const completion = await openai.chat.completions.create({
						model,
						stream: true,
						max_tokens: ARTIFACT_MAX_TOKENS,
						temperature: 0.2,
						messages: [
							{ role: "system", content: KNOWLEDGE_HUB_ARTIFACT_SYSTEM },
							{ role: "user", content: envelope },
						],
					});

					// Raw deltas accumulate server-side ONLY (I1.12) — the client
					// sees token counts, then the final sanitized document.
					for await (const part of completion) {
						const choice = part.choices[0];
						if (choice?.finish_reason) finishReason = choice.finish_reason;
						const delta = choice?.delta?.content ?? "";
						if (!delta) continue;
						accumulated += delta;
						outputTokens += 1;
						if (outputTokens % PROGRESS_EVERY_TOKENS === 0) {
							send("progress", { tokens: outputTokens });
						}
					}
					await recordOpenAICall(0);
				} catch (err) {
					console.error("artifact_openai_error", err);
					ctx.logFields.output_tokens = outputTokens;
					send("error", {
						code: "generation_failed",
						message: "Artifact generation failed.",
					});
					controller.close();
					return;
				}
				ctx.logFields.output_tokens = outputTokens;

				const sanitized = sanitizeArtifactFragment(accumulated);
				if (!sanitized.ok) {
					if (sanitized.reason === "output_guard") {
						logGuardEvent({
							route: "knowledge-hub/artifact",
							reason: "output_guard",
							ip_hash: ctx.ipHash,
							tier: ctx.tier,
							user_hash: ctx.userHash,
							detail: sanitized.detail,
						});
						send("error", {
							code: "output_guard",
							message:
								"The generated document failed safety checks and was discarded. Please try again.",
						});
					} else {
						// LLM refused (or produced a stub) — surface the canonical
						// out-of-scope error, never a branded refusal page.
						ctx.logFields.fallback_taken = true;
						send("error", {
							code: "out_of_scope",
							message: KNOWLEDGE_HUB_OUT_OF_SCOPE,
						});
					}
					controller.close();
					return;
				}

				const truncated = finishReason === "length";
				const html = assembleArtifactDocument({
					fragment: sanitized.fragment,
					title: sanitized.title,
					query,
					sources,
					limitedCoverage,
					truncated,
					model,
					promptVersion: PROMPT_VERSION,
					generatedAt: new Date(),
				});

				ctx.logFields.fallback_taken = false;
				ctx.logFields.artifact_bytes = html.length;
				ctx.logFields.sanitizer_strips = sanitized.strips;

				// Cache only clean, complete artifacts — truncated ones must stay
				// regenerable.
				if (!truncated) {
					redis
						.set(cKey, { html, sources } satisfies CachedArtifact, {
							ex: ARTIFACT_CACHE_TTL_SECONDS,
						})
						.catch((err) => console.error("artifact_cache_write_error", err));
				}

				send("artifact", {
					html,
					sources,
					truncated,
					limitedCoverage,
					cached: false,
				});
				send("done", { cached: false });
				controller.close();
			},
		});

		return new Response(stream, { headers: SSE_HEADERS });
	},
);
