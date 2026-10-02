// Server-side view of corpus/register.json. Imported by the route handlers
// and the Knowledge Hub page (server component) — never by a client
// component, so the register's rights evidence is not shipped to browsers.
// The client receives only the ScopeOptions summary built here.

import rawRegister from "../../corpus/register.json";
import { COLLECTION_IDS, COLLECTIONS, type CollectionId } from "./catalog";
import {
	parseRegister,
	type RegisterEntry,
	type SourceRegister,
	summarizeCollections,
	textEntries,
} from "./register";

let cached: { register: SourceRegister | null; error: string | null } | null =
	null;

/**
 * The validated register, or null when it fails validation. A broken
 * register must not take chat down: callers fall back to the legacy corpus
 * (see lib/sources/config.ts) and the error is logged once.
 */
export function getRegister(): SourceRegister | null {
	if (cached) return cached.register;
	try {
		cached = { register: parseRegister(rawRegister), error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(
			JSON.stringify({
				event: "source_register_invalid",
				message: message.slice(0, 500),
			}),
		);
		cached = { register: null, error: message };
	}
	return cached.register;
}

// FNV-1a, 32-bit: a stable, synchronous fingerprint (cache-key material,
// not a security boundary).
function fnv1a(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/**
 * "2026-10-01.2+3f9a0c11": the register version plus a fingerprint of every
 * text edition (key, version, checksum, status). Goes into answer-cache keys
 * and request logs, so a re-published or re-statused document can never be
 * answered from a cache entry built on the old text.
 */
export function corpusVersion(): string {
	const register = getRegister();
	if (!register) return "invalid";
	const material = textEntries(register)
		.map(
			(e) =>
				`${e.document_key}@${e.version_key}:${e.checksum_sha256 ?? e.backfill_from_regdoc ?? "live"}:${e.status}`,
		)
		.sort()
		.join("|");
	return `${register.version}+${fnv1a(material)}`;
}

/** Collections with at least one current, rights-cleared text document. */
export function collectionsWithText(): CollectionId[] {
	const register = getRegister();
	if (!register) return [];
	const summary = summarizeCollections(register);
	return COLLECTION_IDS.filter(
		(id) => COLLECTIONS[id].searchable && summary[id].textDocuments > 0,
	);
}

export function collectionSummaries() {
	const register = getRegister();
	return register ? summarizeCollections(register) : null;
}

/** Reference-only entries (metadata + link), current editions, by collection. */
export function referenceEntries(collection: CollectionId): RegisterEntry[] {
	const register = getRegister();
	if (!register) return [];
	return register.entries.filter(
		(e) =>
			e.collection === collection &&
			e.status === "current" &&
			!(e.ingest && e.rights.decision === "full_text"),
	);
}
