// Runtime switches for the multi-source corpus (PLAN.md Phase 12, gate 5:
// "Roll out behind a collection flag … retain the old CNSC RPC/table as the
// rollback path").
//
//   KH_SOURCE_CORPUS = legacy (default) | v2
//     legacy — regdoc_chunks + match_regdoc_chunks + the CNSC-only prompt,
//              byte-identical to pre-Phase-12 behaviour. Flip back to this to
//              roll back; nothing else changes.
//     v2     — source_chunks + match_source_chunks + source-neutral citations
//              and the scope picker.
//   KH_COLLECTIONS = comma list, default "cnsc"
//     Collections v2 may answer from, in addition to being searchable in the
//     database (source_collections.searchable) — BOTH must allow a
//     collection. A collection with no current text document is never
//     offered, whatever the flag says.
//
// A register that fails validation, or one with no enabled text collection,
// forces legacy mode: the app never serves from a corpus whose rights/edition
// record it cannot read, and never resolves a scope to nothing.

import {
	COLLECTION_IDS,
	COLLECTIONS,
	type CollectionId,
	isCollectionId,
} from "./catalog";
import {
	collectionSummaries,
	collectionsWithText,
	corpusVersion,
	getRegister,
} from "./manifest";
import type { ScopeOptions } from "./scope-options";

export type SourceCorpusMode = "legacy" | "v2";

export const DEFAULT_COLLECTION: CollectionId = "cnsc";

export function getSourceCorpusMode(): SourceCorpusMode {
	if (process.env.KH_SOURCE_CORPUS !== "v2") return "legacy";
	// v2 needs a readable register AND something to answer from.
	return getRegister() && getEnabledCollections().length > 0 ? "v2" : "legacy";
}

export function getEnabledCollections(): CollectionId[] {
	const raw = (process.env.KH_COLLECTIONS ?? DEFAULT_COLLECTION)
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(isCollectionId);
	const withText = new Set(collectionsWithText());
	const wanted = new Set(raw);
	const enabled = COLLECTION_IDS.filter(
		(id) => wanted.has(id) && withText.has(id),
	);
	return enabled.length > 0
		? enabled
		: withText.has(DEFAULT_COLLECTION)
			? [DEFAULT_COLLECTION]
			: [];
}

const REFERENCE_REASON: Partial<Record<CollectionId, string>> = {
	iaea: "IAEA terms require a licence for AI use — titles and links only",
	aerb: "Reuse terms unclear — titles and links only",
	fukushima: "Not yet ingested — titles and links only",
};

/** null in legacy mode: the client renders no picker at all. */
export function getScopeOptions(): ScopeOptions | null {
	if (getSourceCorpusMode() !== "v2") return null;
	const summary = collectionSummaries();
	if (!summary) return null;
	const enabled = getEnabledCollections();
	if (enabled.length === 0) return null;
	return {
		collections: enabled.map((id) => ({
			id,
			label: COLLECTIONS[id].label,
			region: COLLECTIONS[id].region,
			description: COLLECTIONS[id].description,
			documents: summary[id].textDocuments,
			asOf: summary[id].asOf,
		})),
		referenceOnly: COLLECTION_IDS.filter(
			(id) =>
				!enabled.includes(id) &&
				summary[id].textDocuments === 0 &&
				summary[id].referenceOnlyDocuments > 0,
		).map((id) => ({
			id,
			label: COLLECTIONS[id].label,
			region: COLLECTIONS[id].region,
			documents: summary[id].referenceOnlyDocuments,
			reason: REFERENCE_REASON[id] ?? "Titles and links only",
		})),
		defaultCollection: enabled.includes(DEFAULT_COLLECTION)
			? DEFAULT_COLLECTION
			: (enabled[0] as CollectionId),
		corpusVersion: corpusVersion(),
	};
}
