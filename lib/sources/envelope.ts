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
import { collectionsWithText } from "./manifest";
import { detectMentions, type ResolvedScope } from "./scope";

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
		// A "shall" in a guide binds nobody: nonbinding snippets are always
		// guidance to the model, whatever the wording classifier tagged.
		attr(
			"requirement_type",
			s?.legal_force === "nonbinding"
				? "guidance"
				: (chunk.requirement_type ?? "guidance"),
		);
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
	 * Collections the question names that this answer does not search: a
	 * pin's other regimes, or (Auto/compare) regimes that are not searchable
	 * here. The answer covers what was searched and says the rest was not —
	 * it does not refuse the whole question.
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
			"COMPARISON SCOPE: organise the answer by jurisdiction, attribute every point to its publisher, and do not merge obligations across regimes. For numeric values, give each as its source states it plus its mSv equivalent (1 rem = 10 mSv) and do NOT write which regime's value is higher, lower or stricter.",
		);
	}
	if (unsearchedMentions.length > 0) {
		if (scope.kind === "single" && scope.via === "pinned") {
			const others = unsearchedMentions.map(collectionLabel).join(", ");
			cues.push(
				`PINNED SCOPE: the user selected ${searched.map(collectionLabel).join(", ")} only. The question also mentions ${others}, which is outside the selected sources — answer the ${searched.map((id) => COLLECTIONS[id].label).join("/")} part from the snippets and state in one sentence that the other regime was not searched.`,
			);
		} else {
			// Say WHY, truthfully: a collection with no stored text (IAEA, and
			// today AERB and Fukushima) has nothing to search; one with text was
			// simply not part of this search (not enabled here, or past the
			// three-way comparison cap).
			const withText = new Set(collectionsWithText());
			const refOnly = unsearchedMentions.filter((id) => !withText.has(id));
			const notSearched = unsearchedMentions.filter((id) => withText.has(id));
			if (refOnly.length > 0) {
				cues.push(
					`REFERENCE ONLY: ${refOnly.map(collectionLabel).join(", ")} ${refOnly.length === 1 ? "is" : "are"} catalogued as titles and links only — no text is stored here. Do not state what ${refOnly.length === 1 ? "it says" : "they say"} beyond what the snippets themselves quote, and say so in one sentence if the question asks.`,
				);
			}
			if (notSearched.length > 0) {
				cues.push(
					`NOT SEARCHED: ${notSearched.map(collectionLabel).join(", ")} ${notSearched.length === 1 ? "was" : "were"} not part of this search. Answer from the snippets, state in one sentence that ${notSearched.length === 1 ? "it was" : "they were"} not searched, and never attribute a statement to ${notSearched.length === 1 ? "it" : "them"}.`,
				);
			}
		}
	}
	// A country or regulator with no collection at all ("… and Finland").
	// Phrased conditionally: the name may be incidental ("exports to France").
	if (detectMentions(query).notIndexed) {
		cues.push(
			"UNINDEXED REGULATOR: the question names a country or regulator whose documents are not indexed here. If it asks what that regulator requires, say in one sentence that its documents are not indexed — never answer that part from these snippets.",
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
	// Small models read the legal_force attribute unreliably; restating it
	// last, by snippet id, is what stops "expected" becoming "required".
	const nonbinding = chunks
		.map((c, i) => ({ c, id: `S${i + 1}` }))
		.filter(({ c }) => c.source?.legal_force === "nonbinding");
	if (nonbinding.length > 0) {
		const ids = nonbinding.map(({ id }) => id).join(", ");
		cues.push(
			`LEGAL FORCE: ${ids} ${nonbinding.length === 1 ? "is" : "are"} nonbinding (guides, principles or reports). A sentence supported only by ${nonbinding.length === 1 ? "it" : "them"} must say what the document "states", "recommends" or "expects" — never "requires", "required", "must" or "obligation". Keep the source's own verb, and attribute any ICRP/NCRP/IAEA recommendation to that body.`,
		);
	}
	const cueText = cues.length > 0 ? `\n\n${cues.join("\n")}` : "";

	return `${scopeBlock}\n${chunks.map(wrapSourceSnippet).join("\n")}${cueText}\n\n<user_query>\n${htmlEscape(query)}\n</user_query>`;
}
