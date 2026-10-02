// v2 context envelope (PLAN.md Phase 12). Same spotlighting contract as
// lib/context-envelope.ts — every snippet body and the user query are
// HTML-escaped inside delimited blocks the system prompt names as untrusted
// data — plus the provenance the source-neutral prompt needs to keep legal
// force and jurisdiction straight.
//
// Deliberately NO url attribute: the model has no URL to repeat, and every
// link the user sees is attached server-side from stored metadata.

import type { RetrievedChunk } from "../context-envelope";
import {
	COLLECTIONS,
	type CollectionId,
	DOCUMENT_KIND_LABELS,
	JURISDICTION_LABELS,
} from "./catalog";
import type { ResolvedScope } from "./scope";

function htmlEscape(raw: string): string {
	return raw
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function attr(key: string, value: string | number | null | undefined): string {
	if (value === null || value === undefined || value === "") return "";
	return ` ${key}="${htmlEscape(String(value))}"`;
}

export function wrapSourceSnippet(
	chunk: RetrievedChunk,
	index: number,
): string {
	const s = chunk.source;
	const page =
		s?.page_start != null
			? s.page_end != null && s.page_end !== s.page_start
				? `${s.page_start}-${s.page_end}`
				: String(s.page_start)
			: null;
	const attrs =
		` id="S${index + 1}"` +
		attr("document", s?.ref ?? chunk.regdoc_id) +
		attr("document_title", s?.title) +
		attr("publisher", s?.publisher ?? "CNSC") +
		attr(
			"jurisdiction",
			JURISDICTION_LABELS[s?.jurisdiction ?? "CA"] ?? s?.jurisdiction,
		) +
		attr(
			"document_kind",
			DOCUMENT_KIND_LABELS[s?.document_kind ?? "regulatory_document"],
		) +
		attr("legal_force", s?.legal_force ?? "mixed") +
		attr("edition", s?.edition) +
		attr("status", s?.status ?? "current") +
		attr("section", chunk.section_number) +
		attr("section_title", chunk.section_title) +
		attr("page", page) +
		attr("requirement_type", chunk.requirement_type ?? "guidance");
	return `<context_snippet${attrs}>\n${htmlEscape(chunk.chunk_text)}\n</context_snippet>`;
}

function collectionLabel(id: CollectionId): string {
	const c = COLLECTIONS[id];
	return `${c.label} (${c.region})`;
}

export interface SourceEnvelopeInput {
	chunks: RetrievedChunk[];
	query: string;
	scope: Extract<ResolvedScope, { kind: "single" | "compare" }>;
	/** Comparison sides that returned nothing relevant enough to show. */
	missingCollections?: CollectionId[];
	/** Mentioned documents that have at least one snippet in the envelope. */
	requiredDocs?: readonly string[];
	/**
	 * Partial answers only: documents the question names that are NOT
	 * indexed. Without this cue a model asked about "10 CFR 20.1201 and
	 * 10 CFR 73.54" with only 20.1201 snippets tends to attribute something
	 * to 73.54 anyway.
	 */
	absentDocs?: readonly string[];
	/** Partial answers only: named, indexed, but no snippet retrieved. */
	unretrievedDocs?: readonly string[];
	/**
	 * Pinned scope only: other regulators the question names. The answer
	 * covers the pinned collection and says the rest is outside the
	 * selected sources — it does not refuse the whole question.
	 */
	unsearchedMentions?: CollectionId[];
}

export function buildSourceEnvelope(input: SourceEnvelopeInput): string {
	const {
		chunks,
		query,
		scope,
		missingCollections = [],
		requiredDocs = [],
		absentDocs = [],
		unretrievedDocs = [],
		unsearchedMentions = [],
	} = input;
	const searched =
		scope.kind === "single" ? [scope.collection] : scope.collections;
	const scopeBlock =
		`<scope type="${scope.kind === "compare" ? "comparison" : "single"}"` +
		attr("sources", searched.map(collectionLabel).join("; ")) +
		attr(
			"missing",
			missingCollections.length > 0
				? missingCollections.map(collectionLabel).join("; ")
				: null,
		) +
		attr("editions", scope.historical ? "current and superseded" : "current") +
		" />";

	const cues: string[] = [];
	if (scope.kind === "compare") {
		cues.push(
			"COMPARISON SCOPE: organise the answer by jurisdiction, attribute every point to its publisher, and do not merge obligations across regimes.",
		);
	}
	if (unsearchedMentions.length > 0) {
		cues.push(
			`PINNED SCOPE: the user selected ${searched.map(collectionLabel).join(", ")} only. The question also mentions ${unsearchedMentions.map(collectionLabel).join(", ")}, which is outside the selected sources — answer the ${searched.map((id) => COLLECTIONS[id].label).join("/")} part from the snippets and state in one sentence that the other regime was not searched.`,
		);
	}
	if (missingCollections.length > 0) {
		cues.push(
			`NO RELEVANT SNIPPETS were found for ${missingCollections.map(collectionLabel).join(", ")} — say so plainly instead of filling that side from other sources.`,
		);
	}
	if (requiredDocs.length >= 2) {
		cues.push(
			`MULTI-DOC SCOPE: The user's question spans ${requiredDocs.map(htmlEscape).join(", ")}. Your response MUST cite at least one snippet from EACH of these documents.`,
		);
	}
	const one = (xs: readonly string[]) => xs.length === 1;
	if (absentDocs.length > 0) {
		cues.push(
			`NOT INDEXED: the question also names ${absentDocs.map(htmlEscape).join(", ")}, which ${one(absentDocs) ? "is" : "are"} not among the indexed documents. Answer the rest from the snippets, say in one sentence that ${one(absentDocs) ? "this document is" : "these documents are"} not covered, and never attribute a statement to ${one(absentDocs) ? "it" : "them"}.`,
		);
	}
	if (unretrievedDocs.length > 0) {
		cues.push(
			`NO SNIPPET RETRIEVED for ${unretrievedDocs.map(htmlEscape).join(", ")}: answer the rest from the snippets and say the retrieved excerpts do not cover ${one(unretrievedDocs) ? "that document" : "those documents"} — do not answer ${one(unretrievedDocs) ? "it" : "them"} from memory.`,
		);
	}
	const cueText = cues.length > 0 ? `\n\n${cues.join("\n")}` : "";

	return `${scopeBlock}\n${chunks.map(wrapSourceSnippet).join("\n")}${cueText}\n\n<user_query>\n${htmlEscape(query)}\n</user_query>`;
}
