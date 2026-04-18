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
	detectJailbreakMarkers,
	sanitizeQueryText,
	stripHtmlTags,
} from "@/lib/validators";

// D.3 fallback thresholds. Calibrated 2026-04-17 against scripts/probe-sims.ts:
// LOW_SIM_OOS=0.40 lets single-word corpus-relevant queries (Q20 "turnover" at
// 0.426) through while still catching OOS/adversarial (<0.33 on current corpus).
// MIN_CHUNK_SIM=0.35 drops low-relevance glossary chunks (Q19 regression: a
// REGDOC-3.6 chunk at 0.32 was being cited instead of the on-topic top-1).
const LOW_SIM_OOS = 0.4;
const LOW_SIM_DISCLAIMER = 0.35;
// Retrieve a wider pool (RPC caps at 20) so that when the user names a
// specific REGDOC the doc-mention reranker below can surface chunks from
// that doc even if they don't win on pure cosine sim against a crowded
// corpus. Final envelope is trimmed to ENVELOPE_CHUNKS chunks.
const MATCH_COUNT = 20;
// Envelope stays at 8 to keep the LLM focused on the strongest chunks —
// larger envelopes (tested at 12) caused the model to paraphrase more
// aggressively and miss verbatim phrases the eval cares about.
const ENVELOPE_CHUNKS = 8;
const MIN_CHUNK_SIM = 0.35;
// Score boost applied to a chunk when its regdoc_id appears explicitly
// in the user query. Calibrated so that a named-doc chunk at sim 0.55
// ranks above an unrelated-doc chunk at sim 0.70.
const NAMED_DOC_BOOST = 0.2;

// Recognizes "REGDOC-X.X", "REGDOC-X.X.X", "REGDOC 2.5.2", "NSCA" in user
// query text. Returns the canonical regdoc_id form.
const QUERY_DOC_RE =
	/\b(?:REGDOC[\s-]?(\d+(?:\.\d+){1,3})|(NSCA))\b/gi;

// Concept → REGDOC map for queries that don't name the doc explicitly but
// lean on a CNSC term of art. Used only as a hint for the query-expansion
// retrieval (NOT for the OOS gate) so we can still pull graded-approach
// chunks from REGDOC-3.5.3 when the question's vocabulary is dominated by
// another domain (e.g. waste management → REGDOC-2.11.1).
const CONCEPT_DOC_HINTS: Array<[RegExp, string]> = [
	[/\bgraded approach\b/i, "REGDOC-3.5.3"],
	[/\baction level\b/i, "REGDOC-3.6"],
	[/\bALARA\b/i, "REGDOC-2.7.1"],
	[
		/\b(?:radioactive waste|waste management|waste stream|waste acceptance)\b/i,
		"REGDOC-2.11.1",
	],
];

// "section 48", "§26", "s. 12" style references. Lets us build a tighter
// expansion query ("NSCA §48 offences") that pulls statutory text which
// embeds very weakly against verbose natural-language questions.
const QUERY_SECTION_RE = /(?:§|\bsection\s+|\bs\.\s*)(\d+(?:\.\d+){0,3})\b/gi;

function extractMentionedDocs(query: string): Set<string> {
	const out = new Set<string>();
	for (const m of query.matchAll(QUERY_DOC_RE)) {
		if (m[1]) out.add(`REGDOC-${m[1]}`);
		else if (m[2]) out.add("NSCA");
	}
	for (const [re, doc] of CONCEPT_DOC_HINTS) {
		if (re.test(query)) out.add(doc);
	}
	return out;
}

function extractMentionedSections(query: string): string[] {
	const out = new Set<string>();
	for (const m of query.matchAll(QUERY_SECTION_RE)) {
		if (m[1]) out.add(m[1]);
	}
	return Array.from(out);
}

// Key regulatory nouns that, when present in the user query, sharpen a
// section-focused expansion enough to pull the right chunk into top-20 —
// "NSCA section 48" alone returns zero NSCA hits, but "NSCA section 48
// offence" puts NSCA §48 at rank 5.
const SECTION_CONTEXT_NOUNS = [
	"offence",
	"offences",
	"requirement",
	"requirements",
	"guidance",
	"plan",
	"report",
	"authority",
];

function pickContextNoun(query: string): string | null {
	const lower = query.toLowerCase();
	for (const n of SECTION_CONTEXT_NOUNS) {
		if (new RegExp(`\\b${n}\\b`).test(lower)) return n;
	}
	return null;
}

// Concept phrases that, when present in the query, should seed an
// extra tight expansion. These cover cases where a multi-part question
// asks about a specific sub-concept buried under a dominant one — e.g.
// "single-failure criterion" living in REGDOC-2.5.2 §7.6.2 even though
// the question headline is about design extension conditions in §7.3.4.
const CONCEPT_EXPANSIONS: Array<{ re: RegExp; seed: string }> = [
	{ re: /\bsingle[-\s]failure criterion\b/i, seed: "single-failure criterion safety groups" },
	{ re: /\bCanada Labour Code\b/i, seed: "Canada Labour Code federal acts regulations" },
	{ re: /\bwaste acceptance criteria\b/i, seed: "waste acceptance criteria chemical physical radiological" },
	{
		// Splits like #25 that ask about federal vs provincial/territorial reach
		// of legislation — the key chunk (REGDOC-2.8.1 §2) talks about
		// "legislative authority over CHS".
		re: /\bfederal[^.]{0,40}provincial|\bfederal acts and regulations\b/i,
		seed: "legislative authority federal provincial territorial applicable legislation",
	},
];

// Build targeted expansion queries for each mentioned doc. Shapes:
//   1. NARROW "<doc> section <N> <context-noun>" per mentioned section —
//      the minimal form plus one concept noun from the user query pulls
//      statutory text (NSCA §48: "Every person commits an offence who…")
//      to rank ~5 whereas the verbose forms push it below 20.
//   2. CONCEPT "<doc> <concept-seed>" — one per matched CONCEPT_EXPANSIONS
//      rule; surfaces deep sections like REGDOC-2.5.2 §7.6.2 that a
//      doc+question expansion alone can't reach.
//   3. BROAD "<doc> <query>" — catches chunks that discuss the topic
//      without matching the section-focused form.
function buildExpansions(
	query: string,
	docs: Set<string>,
	sections: string[],
): string[] {
	if (docs.size === 0) return [];
	const noun = pickContextNoun(query);
	const conceptSeeds = CONCEPT_EXPANSIONS.filter((c) => c.re.test(query)).map(
		(c) => c.seed,
	);
	const out: string[] = [];
	for (const doc of docs) {
		if (sections.length > 0) {
			for (const s of sections) {
				out.push(noun ? `${doc} section ${s} ${noun}` : `${doc} section ${s}`);
			}
		}
		for (const seed of conceptSeeds) out.push(`${doc} ${seed}`);
		out.push(`${doc} ${query}`);
	}
	return out;
}
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
		if (query.length > ctx.inputCharCap)
			return validationError(
				`char_cap_${ctx.inputCharCap}`,
				`Query exceeds ${ctx.inputCharCap} character limit for your tier.`,
			);

		const markers = detectJailbreakMarkers(query);
		if (markers.length > 0)
			logValidation(`jailbreak_markers:${markers.length}`);

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

		const mentionedDocs = extractMentionedDocs(query);
		const mentionedSections = extractMentionedSections(query);

		// Build the list of embedding inputs. The primary input is always the
		// original user query; additional "doc-focused" inputs are emitted for
		// each mentioned doc so that chunks in heavy-legal or glossary docs
		// (NSCA §48, REGDOC-3.5.3 §5.4) can surface even when they embed
		// weakly against the verbose natural-language question.
		const expansions = buildExpansions(query, mentionedDocs, mentionedSections);
		const embedInputs = [query, ...expansions];

		let embeddings: number[][];
		try {
			const embResp = await openai.embeddings.create({
				model: OPENAI_MODELS.embedding,
				input: embedInputs,
			});
			embeddings = embResp.data.map((d) => d.embedding);
			if (embeddings.length !== embedInputs.length) {
				throw new Error("embedding count mismatch");
			}
			await recordOpenAICall(0);
		} catch (err) {
			console.error("embedding_error", err);
			return NextResponse.json(
				{ error: "internal_error", message: "Embedding failed." },
				{ status: 500 },
			);
		}

		// Primary retrieval: 20 chunks by open cosine sim.
		const { data: primaryMatches, error: rpcErr } = await supabase.rpc(
			"match_regdoc_chunks",
			{
				query_embedding: embeddings[0],
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
		const primaryPool = (primaryMatches ?? []) as RetrievedChunk[];

		// Secondary retrieval: one RPC per mentioned doc, using the expansion
		// embedding. Merged into the pool below. We pull the max allowed (20)
		// because some doc-specific chunks rank at position 12-14 under these
		// narrower queries — NSCA §48 is a known example.
		const expansionPools: RetrievedChunk[][] = [];
		for (let i = 0; i < expansions.length; i++) {
			const { data: expMatches, error: expErr } = await supabase.rpc(
				"match_regdoc_chunks",
				{
					query_embedding: embeddings[i + 1],
					match_count: 20,
					min_similarity: 0,
				},
			);
			if (expErr) {
				console.error("match_regdoc_chunks_expansion_error", expErr);
				continue;
			}
			expansionPools.push((expMatches ?? []) as RetrievedChunk[]);
		}

		// Merge + dedupe by chunk.id, keeping the highest observed similarity.
		const merged = new Map<number, RetrievedChunk>();
		for (const c of [...primaryPool, ...expansionPools.flat()]) {
			const existing = merged.get(c.id);
			if (!existing || c.similarity > existing.similarity) merged.set(c.id, c);
		}
		const rawPool = Array.from(merged.values()).sort(
			(a, b) => b.similarity - a.similarity,
		);

		// Use top-1 from the RAW pool for the D.3 OOS gate so the boost can't
		// paper over a truly unrelated question.
		const topSim = rawPool[0]?.similarity ?? 0;

		// Doc-mention reranker: when the query names specific REGDOCs (or NSCA),
		// promote chunks from those docs by NAMED_DOC_BOOST so they win spots in
		// the envelope even if a generic chunk scores higher on cosine sim. This
		// is the intent signal the user is sending us — treat it as ground truth.
		const ranked = rawPool
			.map((c) => ({
				chunk: c,
				score:
					c.similarity + (mentionedDocs.has(c.regdoc_id) ? NAMED_DOC_BOOST : 0),
			}))
			.sort((a, b) => b.score - a.score)
			.map((r) => r.chunk);

		// Doc-diversity pass: when multiple docs are mentioned, seed the envelope
		// with the TOP chunk from each mentioned doc before filling by overall
		// score. Without this, a single doc's chunks can sweep the top 8 and the
		// LLM ends up citing only that one doc (happens for queries like "apply
		// the graded approach to radioactive waste management" where 2.11.1's
		// chunks dominate and crowd out REGDOC-3.5.3).
		function selectDiverseEnvelope(
			sorted: RetrievedChunk[],
			mustInclude: Set<string>,
			k: number,
		): RetrievedChunk[] {
			if (mustInclude.size < 2) return sorted.slice(0, k);
			const out: RetrievedChunk[] = [];
			const seen = new Set<number>();
			for (const doc of mustInclude) {
				const top = sorted.find((c) => c.regdoc_id === doc && !seen.has(c.id));
				if (top) {
					out.push(top);
					seen.add(top.id);
					if (out.length >= k) return out;
				}
			}
			for (const c of sorted) {
				if (seen.has(c.id)) continue;
				out.push(c);
				seen.add(c.id);
				if (out.length >= k) break;
			}
			return out;
		}

		const chunks =
			topSim < LOW_SIM_OOS
				? ranked
				: selectDiverseEnvelope(
						ranked.filter((c) => c.similarity >= MIN_CHUNK_SIM),
						mentionedDocs,
						ENVELOPE_CHUNKS,
					);
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

				const envelope = buildContextEnvelope(
					chunks,
					query,
					Array.from(mentionedDocs),
				);
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
