// Knowledge Hub Artifact mode, multi-source path (KH_SOURCE_CORPUS=v2).
// Same contract as the legacy route body — server-side accumulation, the
// artifact sanitizer as the abort gate, deterministic shell assembly, SSE
// meta/progress/artifact/done/error — with the Phase 12 differences:
// resolved scope (a notice is a one-shot `scope_notice` error, no model
// call), scoped retrieval with per-collection gates, the v2 prompt, and
// [[S1]] citations replaced by server-built labels AFTER sanitizing.

import { NextResponse } from "next/server";
import type OpenAI from "openai";
import { sanitizeArtifactFragment } from "../artifact-sanitizer";
import { assembleArtifactDocumentV2 } from "../artifact-template";
import { cacheRead, cacheWrite } from "../cache";
import {
	type GuardContext,
	type GuardedHandlerArgs,
	recordOpenAICall,
} from "../guard";
import { logGuardEvent, logStreamEnd } from "../logger";
import { getOpenAIClient } from "../openai";
import {
	KNOWLEDGE_HUB_ARTIFACT_SYSTEM_V2,
	KNOWLEDGE_HUB_OUT_OF_SCOPE_V2,
	PROMPT_VERSION_V2,
} from "../prompts";
import { RetrievalError } from "../retrieval";
import { COLLECTIONS } from "../sources/catalog";
import {
	extractSnippetIds,
	lintAuthority,
	renderArtifactCitations,
	SNIPPET_CITATION_RE,
	type SourceRecord,
	toSourceRecords,
} from "../sources/citations";
import { DEFAULT_COLLECTION, getEnabledCollections } from "../sources/config";
import { buildSourceEnvelope } from "../sources/envelope";
import { corpusVersion } from "../sources/manifest";
import type { ScopeNoticePayload, ScopeSummary } from "../sources/payload";
import { resolveScope, scopeKey } from "../sources/scope";
import { parseScopeRequest, scopeSummary } from "./query-v2";
import {
	buildNoticePayload,
	cacheScopeMaterial,
	retrieveForScope,
	unsearchedMentions,
} from "./scoped-retrieval";

const ARTIFACT_MAX_TOKENS = 3000;
const ARTIFACT_ENVELOPE_CHUNKS = 12;
const ARTIFACT_CACHE_TTL_SECONDS = 24 * 60 * 60;
const PROGRESS_EVERY_TOKENS = 250;

type SseEvent = "meta" | "progress" | "artifact" | "done" | "error";
const SSE_HEADERS = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache, no-store, must-revalidate",
	"x-accel-buffering": "no",
} as const;

function sseFrame(event: SseEvent, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
function sseError(
	code: string,
	message: string,
	extra?: Record<string, unknown>,
): Response {
	return new Response(sseFrame("error", { code, message, ...extra }), {
		headers: SSE_HEADERS,
	});
}

interface CachedArtifactV2 {
	html: string;
	sources: SourceRecord[];
	scope: ScopeSummary;
}

async function cacheKey(material: string): Promise<string> {
	const buf = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(material),
	);
	const hex = Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `kh2:artifact:cache:${hex.slice(0, 24)}`;
}

function scopeLabel(s: ScopeSummary): string {
	const labels = s.collections.map(
		(id) => `${COLLECTIONS[id].label} (${COLLECTIONS[id].region})`,
	);
	return s.kind === "compare" ? labels.join(" vs ") : (labels[0] ?? "");
}

export interface ArtifactV2Args {
	query: string;
	rawScope: unknown;
	model: string;
	ctx: GuardContext;
	supabase: GuardedHandlerArgs["supabase"];
	openai?: OpenAI;
}

export async function artifactV2(args: ArtifactV2Args): Promise<Response> {
	const { query, model, ctx, supabase } = args;
	const route = "knowledge-hub/artifact";
	ctx.logFields.corpus = "v2";
	ctx.logFields.prompt_version = PROMPT_VERSION_V2;
	ctx.logFields.corpus_version = corpusVersion();

	const request = parseScopeRequest(args.rawScope);
	if (!request) {
		logGuardEvent({
			route,
			reason: "validation",
			ip_hash: ctx.ipHash,
			tier: ctx.tier,
			user_hash: ctx.userHash,
			detail: "invalid_scope",
		});
		return NextResponse.json(
			{ error: "validation", message: "Invalid source scope." },
			{ status: 400 },
		);
	}
	const enabled = getEnabledCollections();
	const scope = resolveScope({
		request,
		query,
		enabled,
		defaultCollection: DEFAULT_COLLECTION,
	});
	ctx.logFields.scope_mode = request.mode;
	ctx.logFields.scope_kind = scope.kind;
	ctx.logFields.scope_key = scopeKey(scope);

	if (scope.kind === "notice") {
		ctx.logFields.notice_reason = scope.reason;
		ctx.logFields.fallback_taken = true;
		ctx.logFields.output_tokens = 0;
		const notice: ScopeNoticePayload = buildNoticePayload(scope, query);
		return sseError("scope_notice", scope.message, { notice });
	}

	const cKey = await cacheKey(
		[
			"kh2-artifact",
			PROMPT_VERSION_V2,
			corpusVersion(),
			model,
			cacheScopeMaterial(scope, query),
			enabled.join(","),
			query.toLowerCase(),
		].join(":"),
	);
	const cached = await cacheRead<CachedArtifactV2>(
		cKey,
		"artifact_cache_read_error",
	);
	if (cached?.html && cached.scope) {
		ctx.logFields.cache = "hit";
		ctx.logFields.fallback_taken = false;
		ctx.logFields.output_tokens = 0;
		ctx.logFields.artifact_bytes = cached.html.length;
		const frames =
			sseFrame("meta", { model, chunks: cached.sources.length, cached: true }) +
			sseFrame("artifact", {
				html: cached.html,
				sources: cached.sources,
				scope: cached.scope,
				truncated: false,
				limitedCoverage: false,
				cached: true,
			}) +
			sseFrame("done", { cached: true });
		return new Response(frames, { headers: SSE_HEADERS });
	}
	ctx.logFields.cache = "miss";

	const openai = args.openai ?? getOpenAIClient();
	let retrieval: Awaited<ReturnType<typeof retrieveForScope>>;
	try {
		retrieval = await retrieveForScope(
			query,
			scope,
			{ supabase, openai },
			ARTIFACT_ENVELOPE_CHUNKS,
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
	ctx.logFields.retrieval_top_sim = Number(retrieval.topSim.toFixed(4));
	ctx.logFields.retrieval_avg_sim = Number(retrieval.avgSim.toFixed(4));
	ctx.logFields.retrieval_per_collection = retrieval.perCollection;

	if (retrieval.outOfScope) {
		ctx.logFields.fallback_taken = true;
		ctx.logFields.output_tokens = 0;
		return sseError("out_of_scope", KNOWLEDGE_HUB_OUT_OF_SCOPE_V2);
	}

	const sources = toSourceRecords(retrieval.chunks);
	const summary = scopeSummary(scope, retrieval.missing);
	// Per-collection raw-pool gate (scoped-retrieval), as the legacy route's
	// pool-mean check — the envelope mean can never dip below the floor.
	const limitedCoverage = retrieval.limited;
	const envelope = buildSourceEnvelope({
		chunks: retrieval.chunks,
		query,
		scope,
		missingCollections: retrieval.missing,
		requiredDocs: retrieval.requiredDocs,
		absentDocs: retrieval.absentDocs,
		unretrievedDocs: retrieval.unretrievedDocs,
		unsearchedMentions: unsearchedMentions(scope, query),
	});

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: SseEvent, data: unknown) =>
				controller.enqueue(encoder.encode(sseFrame(event, data)));
			send("meta", { model, chunks: sources.length, cached: false });

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
						{ role: "system", content: KNOWLEDGE_HUB_ARTIFACT_SYSTEM_V2 },
						{ role: "user", content: envelope },
					],
				});
				for await (const part of completion) {
					const choice = part.choices[0];
					if (choice?.finish_reason) finishReason = choice.finish_reason;
					const delta = choice?.delta?.content ?? "";
					if (!delta) continue;
					accumulated += delta;
					outputTokens += 1;
					if (outputTokens % PROGRESS_EVERY_TOKENS === 0)
						send("progress", { tokens: outputTokens });
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
						route,
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
					ctx.logFields.fallback_taken = true;
					send("error", {
						code: "out_of_scope",
						message: KNOWLEDGE_HUB_OUT_OF_SCOPE_V2,
					});
				}
				controller.close();
				return;
			}

			// Citations become server-built labels only now, after the
			// sanitizer: the label text is escaped and the only markup added is
			// renderArtifactCitations' own <cite>.
			const cited = renderArtifactCitations(sanitized.fragment, sources);
			const truncated = finishReason === "length";
			const html = assembleArtifactDocumentV2({
				fragment: cited.html,
				// The <title> is plain text: drop snippet ids rather than show "[[S1]]".
				title:
					sanitized.title
						?.replace(SNIPPET_CITATION_RE, "")
						.replace(/\s{2,}/g, " ")
						.trim() || null,
				query,
				sources,
				scopeLabel: scopeLabel(summary),
				limitedCoverage,
				truncated,
				model,
				promptVersion: PROMPT_VERSION_V2,
				generatedAt: new Date(),
			});
			ctx.logFields.fallback_taken = false;
			ctx.logFields.artifact_bytes = html.length;
			ctx.logFields.sanitizer_strips = sanitized.strips;
			ctx.logFields.citations_unresolved = cited.unresolved;

			const cacheable = !truncated && cited.unresolved === 0;
			if (cacheable) {
				void cacheWrite(
					cKey,
					{ html, sources, scope: summary } satisfies CachedArtifactV2,
					ARTIFACT_CACHE_TTL_SECONDS,
					"artifact_cache_write_error",
				);
			}
			logStreamEnd({
				route,
				ip_hash: ctx.ipHash,
				tier: ctx.tier,
				user_hash: ctx.userHash,
				corpus_version: String(ctx.logFields.corpus_version ?? ""),
				scope_key: String(ctx.logFields.scope_key ?? ""),
				output_tokens: outputTokens,
				citations_total: extractSnippetIds(sanitized.fragment).length,
				citations_unresolved: cited.unresolved,
				authority_flags: lintAuthority(
					sanitized.fragment.replace(/<[^>]+>/g, " "),
					sources,
				).length,
				output_guard_tripped: false,
				cached_write: cacheable,
			});
			send("artifact", {
				html,
				sources,
				scope: summary,
				truncated,
				limitedCoverage,
				cached: false,
			});
			send("done", { cached: false });
			controller.close();
		},
	});
	return new Response(stream, { headers: SSE_HEADERS });
}
