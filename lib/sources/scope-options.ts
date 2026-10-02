// What the scope picker is allowed to offer — built on the server
// (lib/sources/config.ts) and passed to the client as a plain prop. Client
// safe: no register import, no rights evidence.

import type { CollectionId } from "./catalog";

export interface ScopeCollectionOption {
	id: CollectionId;
	label: string;
	region: string;
	description: string;
	/** Current text documents a question can be answered from. */
	documents: number;
	/** Most recent as-of date across those documents (YYYY-MM-DD). */
	asOf: string | null;
}

export interface ReferenceOnlyOption {
	id: CollectionId;
	label: string;
	region: string;
	/** Catalogued documents shown as links only (no text stored). */
	documents: number;
	reason: string;
}

export interface ScopeOptions {
	collections: ScopeCollectionOption[];
	referenceOnly: ReferenceOnlyOption[];
	defaultCollection: CollectionId;
	corpusVersion: string;
}
