// RAG eval framework — deterministic citation extraction + validity
// (item-2 slice 2.1, R7 metric 5a).
//
// Extraction/matching idioms copied from scripts/eval-kb.ts:65-67 and
// :182-187 so eval citations reflect exactly what the ship battery grades.

export interface Citation {
	regdoc: string;
	section: string | null;
}

// Section labels in the CNSC corpus are not always numeric — appendix /
// glossary sections use letters (REGDOC-3.6 §A) and statutory sections use
// parenthetical sub-letters (NSCA §48(1)(b)). The § glyph is occasionally
// dropped by the model. Mirrors scripts/eval-kb.ts CITATION_RE/SECTION_RE.
export const CITATION_RE =
	/\[(?:REGDOC-\d+(?:\.\d+){1,3}|NSCA)(?:\s+§?[A-Za-z0-9.()]+(?:\s[A-Za-z0-9.()]+)?)?\]/g;
export const SECTION_RE = /§([A-Za-z0-9.()]+(?:\s[A-Za-z0-9.()]+)?)/;

export function extractCitations(text: string): Citation[] {
	const out: Citation[] = [];
	for (const match of text.matchAll(CITATION_RE)) {
		const full = match[0];
		const regdocMatch = full.match(/REGDOC-\d+(?:\.\d+){1,3}|NSCA/);
		if (!regdocMatch) continue;
		const regdoc = regdocMatch[0];
		const secMatch = full.match(SECTION_RE);
		out.push({ regdoc, section: secMatch ? secMatch[1] : null });
	}
	return out;
}

// Accept numeric sub-sections ("3.2" ⊃ "3.2.1") and parenthetical
// sub-clauses used in statutory citations ("26" ⊃ "26(a)", "48(1)(b)").
// Mirrors scripts/eval-kb.ts sectionMatchesPrefix — applied in BOTH
// directions here because a model may cite deeper OR shallower than the
// chunk's section label while still pointing at the same retrieved chunk.
export function sectionMatchesPrefix(cited: string, prefix: string): boolean {
	if (cited === prefix) return true;
	return cited.startsWith(`${prefix}.`) || cited.startsWith(`${prefix}(`);
}

export interface SourceRef {
	regdoc_id: string;
	section_number: string | null;
}

// R7 metric 5a — citation VALIDITY (deterministic, zero cost): a citation is
// valid iff its (regdoc, section) matches a chunk in that answer's
// data-sources set under section-prefix semantics. A section-less citation
// is valid iff any source chunk shares its regdoc.
export function isCitationValid(
	citation: Citation,
	sources: SourceRef[],
): boolean {
	const docMatches = sources.filter(
		(s) => s.regdoc_id.toLowerCase() === citation.regdoc.toLowerCase(),
	);
	if (docMatches.length === 0) return false;
	if (!citation.section) return true;
	return docMatches.some((s) => {
		if (!s.section_number) return false;
		return (
			sectionMatchesPrefix(citation.section as string, s.section_number) ||
			sectionMatchesPrefix(s.section_number, citation.section as string)
		);
	});
}

export interface CitationValidity {
	total: number;
	valid: number;
	// 1.0 when the answer contains no citations at all — validity measures
	// "no fabricated pointers", not citation coverage (coverage is 5b's and
	// the ship battery's job). Reported alongside `total` so zero-citation
	// answers are visible.
	score: number;
	invalid: Citation[];
}

export function scoreCitationValidity(
	text: string,
	sources: SourceRef[],
): CitationValidity {
	const citations = extractCitations(text);
	const invalid = citations.filter((c) => !isCitationValid(c, sources));
	return {
		total: citations.length,
		valid: citations.length - invalid.length,
		score:
			citations.length === 0
				? 1
				: (citations.length - invalid.length) / citations.length,
		invalid,
	};
}

// Canonical citation-set key for consistency comparisons (R7 metric 6):
// sorted, deduped "REGDOC-X.X§Y" strings.
export function citationSetKey(text: string): string {
	const set = new Set(
		extractCitations(text).map((c) => `${c.regdoc}§${c.section ?? ""}`),
	);
	return Array.from(set).sort().join("|");
}
