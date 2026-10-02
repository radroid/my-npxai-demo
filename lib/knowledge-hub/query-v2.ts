// Knowledge Hub chat, multi-source path (KH_SOURCE_CORPUS=v2; PLAN.md
// Phase 12). The route does guard, validation, jailbreak screening and
// regenerate handling exactly as before, then hands the sanitized query
// here. Differences from the legacy path:
//
//   • the request carries a scope ("auto" or one pinned collection); the
//     server resolves it with resolveScope() — a notice outcome answers
//     deterministically with NO retrieval and NO model call
//   • retrieval is filtered to the resolved collections and gated by each
//     collection's thresholds (lib/knowledge-hub/scoped-retrieval.ts)
//   • the model cites snippet ids ([[S1]]); the payload that resolves them
//     (data-sources v2) is written BEFORE the text so chips resolve live
//   • citation validity is measured on every answer and logged; answers
//     with an unresolved id are never cached
//   • the cache key carries prompt version, corpus version and scope

import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { NextResponse } from "next/server";
import type OpenAI from "openai";
import { cacheDelete, cacheRead, cacheWrite } from "../cache";
import {
	type GuardContext,
	type GuardedHandlerArgs,
	recordOpenAICall,
} from "../guard";
import { logGuardEvent, logStreamEnd } from "../logger";
import { getOpenAIClient, OPENAI_MODELS } from "../openai";
import { StreamingGuard } from "../output-guard";
import {
	KNOWLEDGE_HUB_LIMITED_CONTEXT,
	KNOWLEDGE_HUB_OUT_OF_SCOPE_V2,
	KNOWLEDGE_HUB_SYSTEM_V2,
	PROMPT_VERSION_V2,
} from "../prompts";
import { ENVELOPE_CHUNKS, RetrievalError } from "../retrieval";
import { COLLECTIONS, type CollectionId } from "../sources/catalog";
import {
	authorityNote,
	lintAuthority,
	scoreSnippetCitations,
	toSourceRecords,
} from "../sources/citations";
import { DEFAULT_COLLECTION, getEnabledCollections } from "../sources/config";
import { buildSourceEnvelope } from "../sources/envelope";
import { corpusVersion } from "../sources/manifest";
import type {
	ScopeNoticePayload,
	ScopeSummary,
	SourcesPayloadV2,
} from "../sources/payload";
import {
	AUTO_SCOPE,
	resolveScope,
	type ScopeRequest,
	scopeKey,
	scopeRequestSchema,
} from "../sources/scope";
import {
	buildNoticePayload,
	cacheScopeMaterial,
	retrieveForScope,
	type SearchScope,
	unsearchedMentions,
} from "./scoped-retrieval";

const CACHE_TTL_SECONDS = 30 * 60;

interface CachedAnswerV2 {
	text: string;
	payload: SourcesPayloadV2;
}

/** A missing scope is Auto; anything present must parse exactly. */
export function parseScopeRequest(raw: unknown): ScopeRequest | null {
	if (raw === undefined || raw === null) return AUTO_SCOPE;
	const parsed = scopeRequestSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

async function cacheKeyV2(
	query: string,
	scope: SearchScope,
	enabled: CollectionId[],
): Promise<string> {
	const material = [
		"kh2",
		PROMPT_VERSION_V2,
		corpusVersion(),
		cacheScopeMaterial(scope, query),
		enabled.join(","),
		query.toLowerCase(),
	].join(":");
	const buf = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(material),
	);
	const hex = Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `kh2:cache:${hex.slice(0, 24)}`;
}

export function scopeSummary(
	scope: SearchScope,
	missing: CollectionId[],
): ScopeSummary {
	return scope.kind === "single"
		? {
				kind: "single",
				collections: [scope.collection],
				via: scope.via,
				historical: scope.historical,
				missing: [],
			}
		: {
				kind: "compare",
				collections: scope.collections,
				via: "compare",
				historical: scope.historical,
				missing,
			};
}

function oneShot(
	text: string,
	extra?: (w: { write: (p: never) => void }) => void,
): Response {
	const stream = createUIMessageStream({
		execute: async ({ writer }) => {
			extra?.(writer as unknown as { write: (p: never) => void });
			const id = crypto.randomUUID();
			writer.write({ type: "text-start", id });
			writer.write({ type: "text-delta", id, delta: text });
			writer.write({ type: "text-end", id });
		},
	});
	return createUIMessageStreamResponse({ stream });
}

export interface AnswerV2Args {
	query: string;
	rawScope: unknown;
	isRegenerate: boolean;
	/**
	 * A regenerate sent by a notice's "Switch to …" button: the user changed
	 * the scope, not asked for a fresh answer — keep the answer cache.
	 */
	scopeSwitch?: boolean;
	ctx: GuardContext;
	supabase: GuardedHandlerArgs["supabase"];
	/** Test seam; production uses the shared client. */
	openai?: OpenAI;
}

export async function answerV2(args: AnswerV2Args): Promise<Response> {
	const { query, ctx, supabase, isRegenerate } = args;
	const route = "knowledge-hub/query";
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
		return oneShot(scope.message, (w) =>
			w.write({ type: "data-scope-notice", data: notice } as never),
		);
	}

	const cKey = await cacheKeyV2(query, scope, enabled);
	const freshAnswer = isRegenerate && args.scopeSwitch !== true;
	if (freshAnswer) void cacheDelete(cKey, "kh_cache_invalidate_error");
	const cached = freshAnswer
		? null
		: await cacheRead<CachedAnswerV2>(cKey, "kh_cache_read_error");
	if (cached?.text && cached.payload?.version === 2) {
		ctx.logFields.cache = "hit";
		ctx.logFields.fallback_taken = false;
		ctx.logFields.output_tokens = 0;
		return oneShot(cached.text, (w) =>
			w.write({ type: "data-sources", data: cached.payload } as never),
		);
	}
	ctx.logFields.cache = "miss";

	const openai = args.openai ?? getOpenAIClient();
	let retrieval: Awaited<ReturnType<typeof retrieveForScope>>;
	try {
		retrieval = await retrieveForScope(
			query,
			scope,
			{ supabase, openai },
			ENVELOPE_CHUNKS,
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
	ctx.logFields.fallback_taken = retrieval.outOfScope;

	if (retrieval.outOfScope) {
		ctx.logFields.fallback_taken = true;
		ctx.logFields.output_tokens = 0;
		const searched = (
			scope.kind === "single" ? [scope.collection] : scope.collections
		)
			.map((id) => COLLECTIONS[id].label)
			.join(", ");
		return oneShot(`${KNOWLEDGE_HUB_OUT_OF_SCOPE_V2} (Searched: ${searched}.)`);
	}

	const sources = toSourceRecords(retrieval.chunks);
	const payload: SourcesPayloadV2 = {
		version: 2,
		scope: scopeSummary(scope, retrieval.missing),
		sources,
	};
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

	const stream = createUIMessageStream({
		execute: async ({ writer }) => {
			writer.write({ type: "data-sources", data: payload });
			const msgId = crypto.randomUUID();
			writer.write({ type: "text-start", id: msgId });
			const guard = new StreamingGuard();
			let outputTokens = 0;
			let accumulated = "";
			let outputGuardTripped = false;
			let streamFailed = false;

			const emit = (delta: string): { terminate: boolean } => {
				const r = guard.push(delta);
				if (r.safeTokens) {
					writer.write({ type: "text-delta", id: msgId, delta: r.safeTokens });
					accumulated += r.safeTokens;
				}
				if (r.terminate) outputGuardTripped = true;
				if (r.terminate && r.reason) {
					logGuardEvent({
						route,
						reason: "output_guard",
						ip_hash: ctx.ipHash,
						tier: ctx.tier,
						user_hash: ctx.userHash,
						detail: r.reason,
					});
				}
				return { terminate: r.terminate };
			};

			if (retrieval.limited) emit(KNOWLEDGE_HUB_LIMITED_CONTEXT);

			try {
				const completion = await openai.chat.completions.create({
					model: OPENAI_MODELS.chat,
					stream: true,
					max_tokens: ctx.outputMaxTokens,
					temperature: 0.2,
					messages: [
						{ role: "system", content: KNOWLEDGE_HUB_SYSTEM_V2 },
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
				streamFailed = true;
				console.error("openai_stream_error", err);
				writer.write({
					type: "text-delta",
					id: msgId,
					delta: "\n\n_[error generating response]_",
				});
			}
			const authority = lintAuthority(accumulated, sources);
			const note =
				outputGuardTripped || streamFailed ? null : authorityNote(authority);
			if (note) emit(note);
			writer.write({ type: "text-end", id: msgId });

			const citations = scoreSnippetCitations(accumulated, sources);
			const authorityFlags = authority.length;
			// Cache only clean answers: no guard truncation, no stream error,
			// every cited id resolvable, and long enough not to be a stub.
			const cacheable =
				!outputGuardTripped &&
				!streamFailed &&
				citations.unresolved.length === 0 &&
				accumulated.trim().length > 400;
			if (cacheable) {
				void cacheWrite(
					cKey,
					{ text: accumulated, payload },
					CACHE_TTL_SECONDS,
					"kh_cache_write_error",
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
				citations_total: citations.total,
				citations_unresolved: citations.unresolved.length,
				authority_flags: authorityFlags,
				output_guard_tripped: outputGuardTripped,
				cached_write: cacheable,
			});
		},
	});
	return createUIMessageStreamResponse({ stream });
}
