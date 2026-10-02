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
	/**
	 * The full chunk text states an obligation itself ("requires", "must",
	 * "mandatory" — OBLIGATION_RE): a guidance-tagged REGDOC section that
	 * restates the NSCA's duty can be cited for it (lintAuthority).
	 */
	obligation_language: boolean;
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
			obligation_language: statesObligation(c.chunk_text),
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

// Obligation language only a binding source (or a requirement-tagged
// snippet) can carry. "requirement(s)" as a noun is fine ("RG 1.21 explains
// the requirements of 10 CFR 50.36a"), and so is a negation.
const OBLIGATION_RE =
	/\b(?:requires?|required|must|mandatory|obligat(?:ed|ion|ions|ory)|prohibit(?:s|ed)?)\b/i;
// A sentence that itself says the text is not binding ("voluntary guidance
// … not a requirement") is the right answer, not a violation.
// Scoped to the clause: "The NRC does not believe that additional
// reductions … are required" is a negation 60+ characters wide.
// Only the negated obligation itself counts ("not required", "does not
// require", "is not a requirement", "no obligation") — a "not" elsewhere in
// the sentence ("is not limited to X, and licensees must Y") does not. The
// one wide form is a disbelief verb: "The NRC does not believe that
// additional reductions … are required".
const NEGATED_OBLIGATION_RE =
	/\b(?:not|never|no longer)\s+(?:(?:legally|strictly|explicitly|specifically|generally|currently|necessarily)\s+)?(?:requir\w*|mandatory|obligat\w*|binding)\b|n['’]t\s+(?:(?:legally|strictly|explicitly|necessarily)\s+)?(?:requir\w*|mandatory|obligat\w*|binding)\b|\bno\s+(?:legal\s+|regulatory\s+)?(?:requirements?|obligations?|mandate)\b|\bnot\s+(?:believe|consider|think)\b[^.;:]{0,120}\b(?:requires?|required|necessary)\b|\bneed not\b|\b(?:voluntary|non-?binding|not (?:a |an )?(?:legal |regulatory )?requirements?)\b/i;
// "the required safety functions" — an adjective, not an obligation.
const ADJECTIVAL_REQUIRED_RE = /\bthe required\b/gi;

function statesObligation(text: string): boolean {
	return OBLIGATION_RE.test(text.replace(ADJECTIVAL_REQUIRED_RE, ""));
}

export interface AuthorityFlag {
	sentence: string;
	/** Chip labels of the cited snippets (for the report). */
	cited: string[];
	/** Their document refs (for the note: one entry per document). */
	refs: string[];
}

type LintSource = Pick<
	SourceRecord,
	"sid" | "chip" | "ref" | "legal_force" | "requirement_type"
> &
	Partial<Pick<SourceRecord, "obligation_language">>;

// No obligation to cite: a nonbinding document, or a section of a mixed-
// force one (a CNSC REGDOC) that is guidance-tagged AND states no duty in
// its own text. The chunker's tag only looks for "shall"/"must"/"required
// to"; a REGDOC section that says "the NSCA requires licensees to…" can be
// cited for that duty.
function carriesNoObligation(s: LintSource): boolean {
	return (
		s.legal_force === "nonbinding" ||
		(s.legal_force === "mixed" &&
			s.requirement_type !== "requirement" &&
			s.obligation_language !== true)
	);
}

/**
 * Deterministic wrong-authority lint: a sentence that uses obligation
 * language ("required", "must", "obligation") while EVERY snippet it cites
 * carries no obligation (a guide, report, principle or TAG, or a REGDOC
 * guidance section) — the "should"/"expected" → "required" upgrade. A heuristic for review and logging, not a grader: it
 * misses wrong authority phrased without those words ("the NRC limits…")
 * and can flag a sentence that quotes a duty the guide itself attributes to
 * a regulation.
 */
export function lintAuthority(
	text: string,
	sources: LintSource[],
): AuthorityFlag[] {
	const flags: AuthorityFlag[] = [];
	// A citation belongs to the sentence before it: "…must do X. [[S1]] The
	// guide says Y [[S2]]." is two sentences, citing S1 and S2.
	for (const raw of text.split(
		/(?<=[.!?](?:\s*\[\[[^\]\n]*\]\])*)\s+(?!\[\[|\[S\d)|\n+/,
	)) {
		const sentence = raw.trim();
		if (
			!OBLIGATION_RE.test(sentence.replace(ADJECTIVAL_REQUIRED_RE, "")) ||
			NEGATED_OBLIGATION_RE.test(sentence)
		)
			continue;
		const cited = extractSnippetIds(sentence)
			.map((id) => sources.find((s) => s.sid === id))
			.filter((s) => s !== undefined);
		if (cited.length > 0 && cited.every(carriesNoObligation))
			flags.push({
				sentence: sentence.slice(0, 300),
				cited: [...new Set(cited.map((s) => s.chip))],
				refs: [...new Set(cited.map((s) => s.ref))],
			});
	}
	return flags;
}

/**
 * The deterministic backstop for lintAuthority(): appended to a chat answer
 * when a sentence states an obligation on nonbinding authority alone. The
 * prompt and the envelope's LEGAL FORCE cue already forbid that; gpt-4o-mini
 * still does it (usually restating a regulation's duty but citing only the
 * guide that explains it). The note names the guidance and points at the
 * binding source instead of leaving "required" unqualified.
 */
export function authorityNote(flags: AuthorityFlag[]): string | null {
	if (flags.length === 0) return null;
	const refs = [...new Set(flags.flatMap((f) => f.refs))].slice(0, 4);
	const many = refs.length > 1;
	return `\n\n_Legal-force note: the passages cited from ${refs.join("; ")} are guidance, not legal requirements. Where this answer says "required" or "must" citing only ${many ? "them" : "it"}, the binding obligation, if there is one, comes from the regulation or licence condition the guidance explains — check that source before relying on it._`;
}

// The notes above and below, as appended to an answer — for graders that
// must judge the model's own text ("must"/"required" and mSv values in a
// note would otherwise satisfy a must_contain check).
const APPENDED_NOTE_RE = /\n*_(?:Legal-force|Units) note: [^\n]*_(?=\n|$)/g;

export function stripAppendedNotes(text: string): string {
	return text.replace(APPENDED_NOTE_RE, "");
}

const COMPARATIVE_RE =
	/\b(?:higher|lower|stricter|more stringent|less stringent|more restrictive|less restrictive|greater|exceeds?)\b/i;
const REM_VALUE_RE = /\b(\d+(?:\.\d+)?)\s*rems?\b/gi;
const SI_VALUE_RE = /\b\d+(?:\.\d+)?\s*m?Sv\b/;

/**
 * The deterministic backstop for cross-unit comparisons: an answer that
 * quotes limits in BOTH rem and sieverts and says one is higher/lower gets
 * the exact mSv equivalent of every rem value it quoted. gpt-4o-mini
 * repeatedly called a 50 mSv limit "higher" than 15 rem (= 150 mSv) despite
 * the prompt's one-unit rule; the note makes any such claim checkable at a
 * glance.
 */
export function unitsNote(text: string): string | null {
	if (!COMPARATIVE_RE.test(text) || !SI_VALUE_RE.test(text)) return null;
	const rems = [
		...new Set([...text.matchAll(REM_VALUE_RE)].map((m) => Number(m[1]))),
	]
		.filter((n) => Number.isFinite(n))
		.sort((a, b) => a - b)
		.slice(0, 6);
	if (rems.length === 0) return null;
	const fmt = (n: number) => Number((n * 10).toPrecision(6)).toString();
	const pairs = rems.map((n) => `${n} rem = ${fmt(n)} mSv`).join("; ");
	return `\n\n_Units note: 1 rem = 10 mSv (${pairs}). Check any statement above that one limit is higher or lower against these equivalents._`;
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
	// A bad id inside a mixed group ("[[S1, S99]]") stays visible.
	if (unresolved > 0) labels.push("unverified citation");
	return {
		text: `[${labels.join("; ")}]`,
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
					r.unresolved > 0 ? "art-cite art-cite-unresolved" : "art-cite";
				return `<cite class="${cls}">${text}</cite>`;
			});
		})
		.join("");
	return { html, unresolved };
}
