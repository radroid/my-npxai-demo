// Wire shapes of the v2 Knowledge Hub stream parts, shared by the routes
// (writers) and the UI (readers). Client safe.
//
//   data-sources       { version: 2, scope, sources }  — written BEFORE the
//                      answer text so [[S1]] chips resolve while streaming.
//                      Legacy messages carry { chunks } with no version and
//                      keep rendering through the REGDOC chip path.
//   data-scope-notice  { reason, suggestions }         — a deterministic
//                      scope decline (no retrieval, no model call); the UI
//                      offers the suggestions as one-click scope switches.

import type { CollectionId } from "./catalog";
import type { SourceRecord } from "./citations";
import type { NoticeReason } from "./scope";

export interface ScopeSummary {
	kind: "single" | "compare";
	collections: CollectionId[];
	via: "pinned" | "auto_default" | "auto_detected" | "compare";
	historical: boolean;
	/** Comparison sides with no snippet above that collection's floor. */
	missing: CollectionId[];
}

export interface SourcesPayloadV2 {
	version: 2;
	scope: ScopeSummary;
	sources: SourceRecord[];
}

export interface ScopeNoticePayload {
	reason: NoticeReason;
	suggestions: Array<{ id: CollectionId; label: string }>;
}

export function isSourcesPayloadV2(data: unknown): data is SourcesPayloadV2 {
	return (
		typeof data === "object" &&
		data !== null &&
		(data as { version?: unknown }).version === 2 &&
		Array.isArray((data as { sources?: unknown }).sources)
	);
}
