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
import {
	buildContextEnvelope,
	type RetrievedChunk,
} from "@/lib/context-envelope";
import { recordOpenAICall, withGuard } from "@/lib/guard";
import { logGuardEvent } from "@/lib/logger";
import { getOpenAIClient, OPENAI_MODELS } from "@/lib/openai";
import { StreamingGuard } from "@/lib/output-guard";
import {
	KNOWLEDGE_HUB_OUT_OF_SCOPE,
	KNOWLEDGE_HUB_SYSTEM,
	PROMPT_VERSION,
} from "@/lib/prompts";
import { detectJailbreakMarkers, sanitizeQueryText } from "@/lib/validators";

// D.3 fallback thresholds. Calibrated 2026-04-17 against scripts/probe-sims.ts:
// well-formed questions score 0.6–0.75; "manager"/"melting point" OOS/OOC score
// 0.31–0.33; the edge case "turnover" (Q20) scores 0.426. Setting LOW_SIM_OOS
// to 0.40 lets single-word corpus-relevant queries through while still catching
// genuine out-of-corpus + adversarial prompts (all <0.33 on current corpus).
const LOW_SIM_OOS = 0.4;
const LOW_SIM_DISCLAIMER = 0.35;
// Request 8 at the RPC but filter to sim >= 0.35 before building the envelope.
// Rationale (Q19 regression 2026-04-17): for borderline queries a low-relevance
// glossary chunk (REGDOC-3.6, sim 0.32) was being cited instead of the top-1
// operational REGDOC (2.3.4, sim 0.50). Dropping anything below 0.35 forces the
// LLM to cite from chunks that are actually on-topic.
const MATCH_COUNT = 8;
const MIN_CHUNK_SIM = 0.35;

interface UIMessagePart {
	type: string;
	text?: string;
}
interface UIMessageLike {
	role: string;
	parts?: UIMessagePart[];
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
		} | null;
		const messages = body?.messages ?? [];
		const rawQuery = extractQuery(messages);
		const query = sanitizeQueryText(rawQuery);

		ctx.logFields.prompt_version = PROMPT_VERSION;
		ctx.logFields.query_len = query.length;
		ctx.logFields.model = OPENAI_MODELS.chat;

		if (!query) {
			logGuardEvent({
				route: "knowledge-hub/query",
				reason: "validation",
				ip_hash: ctx.ipHash,
				tier: ctx.tier,
				user_hash: ctx.userHash,
				detail: "empty_query",
			});
			return NextResponse.json(
				{ error: "validation", message: "Query is required." },
				{ status: 400 },
			);
		}
		if (query.length > ctx.inputCharCap) {
			logGuardEvent({
				route: "knowledge-hub/query",
				reason: "validation",
				ip_hash: ctx.ipHash,
				tier: ctx.tier,
				user_hash: ctx.userHash,
				detail: `char_cap_${ctx.inputCharCap}`,
			});
			return NextResponse.json(
				{
					error: "validation",
					message: `Query exceeds ${ctx.inputCharCap} character limit for your tier.`,
				},
				{ status: 400 },
			);
		}

		const markers = detectJailbreakMarkers(query);
		if (markers.length > 0) {
			logGuardEvent({
				route: "knowledge-hub/query",
				reason: "validation",
				ip_hash: ctx.ipHash,
				tier: ctx.tier,
				user_hash: ctx.userHash,
				detail: `jailbreak_markers:${markers.length}`,
			});
		}

		const openai = getOpenAIClient();

		let embedding: number[];
		try {
			const embResp = await openai.embeddings.create({
				model: OPENAI_MODELS.embedding,
				input: query,
			});
			const vec = embResp.data[0]?.embedding;
			if (!vec) throw new Error("empty embedding response");
			embedding = vec;
			await recordOpenAICall(0);
		} catch (err) {
			console.error("embedding_error", err);
			return NextResponse.json(
				{ error: "internal_error", message: "Embedding failed." },
				{ status: 500 },
			);
		}

		const { data: matches, error: rpcErr } = await supabase.rpc(
			"match_regdoc_chunks",
			{
				query_embedding: embedding,
				match_count: MATCH_COUNT,
				min_similarity: 0, // D.3 thresholds applied handler-side; keep RPC permissive
			},
		);
		if (rpcErr) {
			console.error("match_regdoc_chunks_error", rpcErr);
			return NextResponse.json(
				{ error: "internal_error", message: "Retrieval failed." },
				{ status: 500 },
			);
		}

		const allChunks = ((matches ?? []) as RetrievedChunk[]).slice(
			0,
			MATCH_COUNT,
		);
		// Use top-1 from the raw retrieval for the D.3 gate, but drop
		// low-relevance chunks before envelope-building so the LLM cites from
		// on-topic context only.
		const topSim = allChunks[0]?.similarity ?? 0;
		const chunks =
			topSim < LOW_SIM_OOS
				? allChunks
				: allChunks.filter((c) => c.similarity >= MIN_CHUNK_SIM);
		// Average over the kept (≥ MIN_CHUNK_SIM) chunks when the gate is
		// passed — matches the chunks actually shown to the LLM.
		const avgSim =
			chunks.length > 0
				? chunks.reduce((acc, c) => acc + c.similarity, 0) / chunks.length
				: 0;
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

				const envelope = buildContextEnvelope(chunks, query);
				const guard = new StreamingGuard();
				let outputTokens = 0;

				const emit = (delta: string): { terminate: boolean } => {
					const r = guard.push(delta);
					if (r.safeTokens) {
						writer.write({
							type: "text-delta",
							id: msgId,
							delta: r.safeTokens,
						});
					}
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
						const r = emit(delta);
						if (r.terminate) break;
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

				writer.write({
					type: "data-sources",
					data: {
						chunks: chunks.map((c) => ({
							id: c.id,
							regdoc_id: c.regdoc_id,
							section_number: c.section_number,
							section_title: c.section_title,
							url: c.url,
							similarity: Number(c.similarity.toFixed(4)),
							requirement_type: c.requirement_type,
							snippet: c.chunk_text.slice(0, 260),
						})),
					},
				});
				writer.write({ type: "text-end", id: msgId });

				ctx.logFields.fallback_taken = false;
				ctx.logFields.output_tokens = outputTokens;
			},
		});

		return createUIMessageStreamResponse({ stream });
	},
);
