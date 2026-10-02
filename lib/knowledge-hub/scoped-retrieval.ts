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
import { type RetrievalDeps, retrieveChunks } from "../retrieval";
import type { CollectionId } from "../sources/catalog";
import { detectMentions, type ResolvedScope } from "../sources/scope";
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
	/** True when every searched collection fell below its refusal gate. */
	outOfScope: boolean;
	/** Comparison sides below their refusal gate. */
	missing: CollectionId[];
	/** True when the (present) snippets sit below the limited-context gate. */
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

	const results = await Promise.all(
		collections.map(async (collection) => {
			const t = thresholdsFor(collection);
			const r = await retrieveChunks(query, deps, {
				envelopeChunks: share,
				source: {
					collections: [collection],
					includeHistorical: scope.historical,
				},
				thresholds: t,
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
	return {
		chunks,
		topSim: Math.max(0, ...results.map(({ r }) => r.topSim)),
		avgSim,
		poolAvgSim: avg(results.map(({ r }) => r.poolAvgSim)),
		mentionedDocs: [...new Set(present.flatMap(({ r }) => r.mentionedDocs))],
		outOfScope: present.length === 0,
		missing: scope.kind === "compare" ? missing : [],
		limited: present.some(({ r, t }) => r.avgSim < t.disclaimer),
		perCollection: results.map(({ collection, r }) => ({
			collection,
			topSim: Number(r.topSim.toFixed(4)),
			chunks: r.envelope.length,
		})),
	};
}

/** Pinned scope: the regimes a question names that were NOT searched. */
export function unsearchedMentions(
	scope: SearchScope,
	query: string,
): CollectionId[] {
	if (scope.kind !== "single" || scope.via !== "pinned") return [];
	return detectMentions(query).collections.filter(
		(id) => id !== scope.collection,
	);
}
