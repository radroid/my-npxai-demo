// Source-neutral citations (PLAN.md Phase 12, "Make citations source-neutral").
//
// The model never writes a document name, section number or URL as a
// citation. It writes the id of the snippet it used — [[S1]] — and the server
// resolves that id against the snippets it actually retrieved. Everything the
// user sees on a citation (label, edition, section/page, publisher, link) is
// therefore server-derived from stored source metadata. An id the server did
// not hand out cannot resolve: it renders as an unverified marker and fails
// the citation evaluation.
//
// Shared by the chat route (payload), the chat UI (chips), the artifact
// route (HTML), and scripts/rag-eval (scoring) so all four agree on grammar.

import type { RetrievedChunk } from "../context-envelope";
import {
	type CollectionId,
	type DocumentKind,
	type DocumentStatus,
	isAllowedSourceUrl,
	type LegalForce,
} from "./catalog";

// [[S1]], [[S1, S3]] (tolerated), and the single-bracket slip [S1].
// Ids are bounded to two digits: envelopes never exceed 20 snippets.
export const SNIPPET_CITATION_RE =
	/\[\[\s*(S\d{1,2}(?:\s*[,;]\s*S\d{1,2})*)\s*\]\]|\[(S\d{1,2})\]/g;

/** Every snippet id cited in `text`, in order, duplicates kept. */
export function extractSnippetIds(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(SNIPPET_CITATION_RE)) {
		const group = m[1] ?? m[2] ?? "";
		for (const id of group.split(/[,;]/)) {
			const trimmed = id.trim();
			if (trimmed) out.push(trimmed);
		}
	}
	return out;
}

/**
 * One retrieved snippet as the client and the eval see it — the v2
 * `data-sources` record. `regdoc_id` is kept (= `ref`) so legacy consumers
 * that only read that field keep working.
 */
export interface SourceRecord {
	sid: string;
	id: number;
	ref: string;
	label: string;
	chip: string;
	title: string;
	publisher: string;
	jurisdiction: string;
	collection: CollectionId;
	document_kind: DocumentKind;
	legal_force: LegalForce;
	edition: string | null;
	status: DocumentStatus;
	as_of: string;
	section_number: string | null;
	section_title: string | null;
	page: number | null;
	url: string | null;
	similarity: number;
	requirement_type: "requirement" | "guidance" | null;
	snippet: string;
	attribution: string | null;
	regdoc_id: string;
}

/**
 * Compact chip text: the document's short reference plus the most specific
 * locator. CNSC chips read exactly as before ("REGDOC-2.3.4 §4.2"); a
 * regulation's paragraph attaches without a § ("10 CFR 20.1201(a)"); a PDF
 * without a usable section number falls back to its page ("RG 1.21 p. 12").
 */
export function chipLabel(input: {
	ref: string;
	document_kind: DocumentKind;
	section_number: string | null;
	page: number | null;
}): string {
	const { ref, document_kind, section_number, page } = input;
	if (section_number) {
		if (document_kind === "regulation" && /^\(/.test(section_number)) {
			return `${ref}${section_number}`;
		}
		return `${ref} §${section_number}`;
	}
	if (page !== null) return `${ref} p. ${page}`;
	return ref;
}

const SNIPPET_PREVIEW_CHARS = 260;

/**
 * Build the client payload for an envelope. `sid` is the 1-based position in
 * the envelope — exactly the id the model saw on each <context_snippet>.
 * URLs are re-validated here: a stored URL that somehow fails the allowlist
 * is dropped rather than shipped.
 */
export function toSourceRecords(chunks: RetrievedChunk[]): SourceRecord[] {
	return chunks.map((c, i) => {
		const s = c.source;
		const ref = s?.ref ?? c.regdoc_id;
		const kind: DocumentKind = s?.document_kind ?? "regulatory_document";
		const page = s?.page_start ?? null;
		const url = isAllowedSourceUrl(c.url)
			? c.url
			: s && isAllowedSourceUrl(s.canonical_url)
				? s.canonical_url
				: null;
		return {
			sid: `S${i + 1}`,
			id: c.id,
			ref,
			label: s?.label ?? c.regdoc_id,
			chip: chipLabel({
				ref,
				document_kind: kind,
				section_number: c.section_number,
				page,
			}),
			title: s?.title ?? c.regdoc_id,
			publisher: s?.publisher ?? "CNSC",
			jurisdiction: s?.jurisdiction ?? "CA",
			collection: s?.collection ?? "cnsc",
			document_kind: kind,
			legal_force: s?.legal_force ?? "mixed",
			edition: s?.edition ?? null,
			status: s?.status ?? "current",
			as_of: s?.as_of ?? "",
			section_number: c.section_number,
			section_title: c.section_title,
			page,
			url,
			similarity: Number(c.similarity.toFixed(4)),
			requirement_type: c.requirement_type,
			snippet: c.chunk_text.slice(0, SNIPPET_PREVIEW_CHARS),
			attribution: s?.attribution ?? null,
			regdoc_id: ref,
		};
	});
}

export function resolveSnippetId(
	sid: string,
	sources: Pick<SourceRecord, "sid">[],
): number {
	return sources.findIndex((s) => s.sid === sid);
}

export interface SnippetCitationScore {
	total: number;
	valid: number;
	/** Ids cited that were never handed to the model (S9 with 8 snippets). */
	unresolved: string[];
	/** valid/total, or null when nothing was cited (never a vacuous pass). */
	score: number | null;
	hasCitations: 0 | 1;
}

export function scoreSnippetCitations(
	text: string,
	sources: Pick<SourceRecord, "sid">[],
): SnippetCitationScore {
	const ids = extractSnippetIds(text);
	const unresolved = ids.filter((id) => resolveSnippetId(id, sources) < 0);
	return {
		total: ids.length,
		valid: ids.length - unresolved.length,
		unresolved,
		score:
			ids.length === 0 ? null : (ids.length - unresolved.length) / ids.length,
		hasCitations: ids.length === 0 ? 0 : 1,
	};
}

function escapeHtml(raw: string): string {
	return raw
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function citationsToText(
	group: string,
	sources: SourceRecord[],
): {
	text: string;
	unresolved: number;
} {
	let unresolved = 0;
	const parts = group
		.split(/[,;]/)
		.map((id) => id.trim())
		.filter(Boolean)
		.map((id) => {
			const idx = resolveSnippetId(id, sources);
			if (idx < 0) {
				unresolved += 1;
				return null;
			}
			return sources[idx].chip;
		});
	const labels = parts.filter((p): p is string => p !== null);
	return {
		text:
			labels.length > 0 ? `[${labels.join("; ")}]` : "[unverified citation]",
		unresolved,
	};
}

/**
 * Replace snippet-id citations in a SANITIZED artifact fragment with
 * server-built <cite> labels. Runs after lib/artifact-sanitizer.ts, so the
 * only markup it adds is its own escaped output. Inside <svg> it substitutes
 * plain text (a <cite> element is invalid in SVG text). The model's optional
 * <cite class="art-cite"> wrapper is unwrapped first so cites never nest.
 */
export function renderArtifactCitations(
	fragment: string,
	sources: SourceRecord[],
): { html: string; unresolved: number } {
	let unresolved = 0;
	const unwrapped = fragment.replace(
		/<cite class="art-cite">\s*((?:\[\[[^\]<]*\]\]|\[S\d{1,2}\]|\s)+)\s*<\/cite>/g,
		"$1",
	);
	const segments = unwrapped.split(/(<svg[\s\S]*?<\/svg>)/g);
	const html = segments
		.map((segment) => {
			const inSvg = segment.startsWith("<svg");
			return segment.replace(SNIPPET_CITATION_RE, (_m, group, single) => {
				const r = citationsToText(group ?? single ?? "", sources);
				unresolved += r.unresolved;
				const text = escapeHtml(r.text);
				if (inSvg) return text;
				const cls =
					r.text === "[unverified citation]"
						? "art-cite art-cite-unresolved"
						: "art-cite";
				return `<cite class="${cls}">${text}</cite>`;
			});
		})
		.join("");
	return { html, unresolved };
}
