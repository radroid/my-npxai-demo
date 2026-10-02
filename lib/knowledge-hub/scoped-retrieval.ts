// Scoped retrieval over the multi-source corpus — one resolved scope in, one
// envelope out. Shared by the chat and artifact routes so both gate, order
// and label snippets identically.
//
// single  — one retrieveChunks() call restricted to the collection, gated
//           by that collection's calibrated thresholds.
// compare — one call PER collection (each gated by its own thresholds, each
//           with its share of the envelope) so a strong corpus cannot crowd
//           the weaker side out of a comparison. Snippets are grouped by
//           collection in scope order; a side with nothing above its floor
//           is reported as missing rather than silently dropped.

import type { RetrievedChunk } from "../context-envelope";
import {
	embeddingInputsFor,
	embedTexts,
	extractNamedDocs,
	type RetrievalDeps,
	refMatchesMention,
	retrieveChunks,
} from "../retrieval";
import { COLLECTIONS, type CollectionId } from "../sources/catalog";
import {
	collectionsWithText,
	namedReferenceLinks,
	textDocRefs,
} from "../sources/manifest";
import type { ScopeNoticePayload } from "../sources/payload";
import {
	detectMentions,
	type ResolvedScope,
	scopeKey as scopeKeyOf,
} from "../sources/scope";
import { thresholdsFor } from "../sources/thresholds";

export type SearchScope = Extract<
	ResolvedScope,
	{ kind: "single" | "compare" }
>;

export interface ScopedRetrieval {
	chunks: RetrievedChunk[];
	/** Best top-1 similarity across the searched collections. */
	topSim: number;
	/** Mean envelope similarity across collections that returned snippets. */
	avgSim: number;
	poolAvgSim: number;
	mentionedDocs: string[];
	/**
	 * Mentioned documents that DO have a snippet in the envelope — the only
	 * ones the "cite each document" instruction may name.
	 */
	requiredDocs: string[];
	/**
	 * Partial-answer case only (the question names several documents and at
	 * least one IS in the envelope): named documents that are not indexed at
	 * all. The model is told to say so, not to attribute. Empty otherwise —
	 * a question that names only unknown documents ("cite REGDOC-9.9.9") is
	 * left to the normal decline rules rather than having the id echoed back.
	 */
	absentDocs: string[];
	/** Same case: named documents that ARE indexed but had no snippet here. */
	unretrievedDocs: string[];
	/** True when every searched collection fell below its refusal gate. */
	outOfScope: boolean;
	/** Comparison sides below their refusal gate. */
	missing: CollectionId[];
	/**
	 * True when a present collection's candidate POOL averages below its
	 * limited-context gate. The pool, not the envelope: the envelope is
	 * filtered at minChunk (= the disclaimer value), so its mean can never
	 * dip under the gate and the check would be dead.
	 */
	limited: boolean;
	perCollection: Array<{
		collection: CollectionId;
		topSim: number;
		chunks: number;
	}>;
}

export async function retrieveForScope(
	query: string,
	scope: SearchScope,
	deps: RetrievalDeps,
	envelopeChunks: number,
): Promise<ScopedRetrieval> {
	const collections =
		scope.kind === "single" ? [scope.collection] : scope.collections;
	const share =
		scope.kind === "single"
			? envelopeChunks
			: Math.max(3, Math.floor(envelopeChunks / collections.length));

	// Compare: embed every side's inputs (they differ only in doc-specific
	// expansions) in ONE request, so a comparison costs one embedding call
	// and one circuit-breaker increment like any other question.
	let precomputedEmbeddings: Map<string, number[]> | undefined;
	if (collections.length > 1) {
		const inputs = [
			...new Set(collections.flatMap((c) => embeddingInputsFor(query, [c]))),
		];
		const vectors = await embedTexts(inputs, deps);
		precomputedEmbeddings = new Map(inputs.map((t, i) => [t, vectors[i]]));
	}

	// Named documents, resolved against the register per collection.
	const named = extractNamedDocs(query, collections);
	const refsByCollection = new Map(
		collections.map((c) => [c, textDocRefs(c, scope.historical)]),
	);
	const isIndexed = (mention: string) =>
		[...refsByCollection.values()].some((refs) =>
			refs.some((ref) => refMatchesMention(ref, mention)),
		);

	const results = await Promise.all(
		collections.map(async (collection) => {
			const t = thresholdsFor(collection);
			// One group per named mention, in the order the question names
			// them — not register order, which would let one family ("10 CFR
			// 20", six provisions) take every slot.
			const refs = refsByCollection.get(collection) ?? [];
			const docRefGroups = named
				.map((m) => refs.filter((ref) => refMatchesMention(ref, m)))
				.filter((g) => g.length > 0);
			const r = await retrieveChunks(query, deps, {
				envelopeChunks: share,
				source: {
					collections: [collection],
					includeHistorical: scope.historical,
					docRefGroups,
				},
				thresholds: t,
				precomputedEmbeddings,
			});
			return { collection, t, r };
		}),
	);

	const present = results.filter(({ r, t }) => r.topSim >= t.oos);
	const missing = results
		.filter(({ r, t }) => r.topSim < t.oos)
		.map(({ collection }) => collection);
	const chunks = present.flatMap(({ r }) => r.envelope);
	const avg = (xs: number[]) =>
		xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
	const avgSim = avg(present.map(({ r }) => r.avgSim));
	const inEnvelope = (doc: string) =>
		chunks.some((c) => refMatchesMention(c.regdoc_id, doc));
	const mentionedDocs = [
		...new Set(results.flatMap(({ r }) => r.mentionedDocs)),
	];
	return {
		chunks,
		topSim: Math.max(0, ...results.map(({ r }) => r.topSim)),
		avgSim,
		poolAvgSim: avg(results.map(({ r }) => r.poolAvgSim)),
		mentionedDocs,
		requiredDocs: mentionedDocs.filter(inEnvelope),
		...partialAnswerGaps(named, inEnvelope, isIndexed),
		outOfScope: present.length === 0,
		missing: scope.kind === "compare" ? missing : [],
		limited: present.some(({ r, t }) => r.poolAvgSim < t.disclaimer),
		perCollection: results.map(({ collection, r }) => ({
			collection,
			topSim: Number(r.topSim.toFixed(4)),
			chunks: r.envelope.length,
		})),
	};
}

/**
 * The regimes a question names that this answer does NOT search: a pin's
 * other regimes, or — Auto and compare — named collections that are not
 * searchable here (IAEA, a disabled collection, a fourth regime past the
 * three-way compare cap).
 */
export function unsearchedMentions(
	scope: SearchScope,
	query: string,
): CollectionId[] {
	const searched =
		scope.kind === "single" ? [scope.collection] : scope.collections;
	return detectMentions(query).collections.filter(
		(id) => !searched.includes(id),
	);
}

/**
 * The scope part of an answer-cache key. scopeKey() alone is not enough: the
 * same "single:nrc" scope reached via Auto and via a pin builds a different
 * envelope (a different "other regime was not searched" cue) and a different
 * Sources-panel label, so both — plus the cue's regimes — are part of the key.
 */
export function cacheScopeMaterial(scope: SearchScope, query: string): string {
	const via = scope.kind === "single" ? scope.via : "compare";
	return `${scopeKeyOf(scope)}|${via}|${unsearchedMentions(scope, query).join("+")}`;
}

/**
 * The data-scope-notice payload: one-click scope switches, plus the official
 * links of any reference-only document the question names (an IAEA standard
 * has no text here, but its page does exist — the notice says so and links it).
 */
export function buildNoticePayload(
	scope: Extract<ResolvedScope, { kind: "notice" }>,
	query: string,
): ScopeNoticePayload {
	const withText = new Set(collectionsWithText());
	const references = detectMentions(query)
		.collections.filter((id) => !withText.has(id))
		.flatMap((id) => namedReferenceLinks(id, query))
		.slice(0, 3);
	return {
		reason: scope.reason,
		suggestions: scope.suggestions.map((id) => ({
			id,
			label: COLLECTIONS[id].label,
		})),
		...(references.length > 0 ? { references } : {}),
	};
}

function partialAnswerGaps(
	named: string[],
	inEnvelope: (doc: string) => boolean,
	isIndexed: (doc: string) => boolean,
): { absentDocs: string[]; unretrievedDocs: string[] } {
	const missing = named.filter((d) => !inEnvelope(d));
	if (named.length < 2 || missing.length === named.length) {
		return { absentDocs: [], unretrievedDocs: [] };
	}
	return {
		absentDocs: missing.filter((d) => !isIndexed(d)),
		unretrievedDocs: missing.filter((d) => isIndexed(d)),
	};
}
