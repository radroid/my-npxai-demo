// Extraction quality evidence + release gate (PLAN.md Phase 12: "Reject
// missing rights clearance, broken/unsafe links, empty extraction, unexpected
// row counts, and embedding/model mismatches before publish").
//
// The thresholds are deliberately conservative: a document that fails is
// recorded as parse-blocked in its report and stays out of the corpus — a
// garbled guide answering questions is worse than no guide.

import type { Doc } from "../lib/chunker";
import type { ParseReport, ParsedSource } from "./adapters/types";

const WORD_LIKE_RE = /^[("“'‘[]?[\p{L}][\p{L}'’-]*[.,;:!?)”'’\]]*$/u;

export function textQuality(doc: Doc): {
	sections: number;
	paragraphs: number;
	chars: number;
	alpha_ratio: number;
	word_like_ratio: number;
} {
	const paras = doc.sections.flatMap((s) => s.paragraphs.map((p) => p.text));
	const text = paras.join(" ");
	const chars = text.length;
	const alpha = (text.match(/\p{L}/gu) ?? []).length;
	const tokens = text
		.split(/\s+/)
		.filter((t) => t.length >= 2 && !/^\d/.test(t));
	const wordLike = tokens.filter((t) => WORD_LIKE_RE.test(t)).length;
	return {
		sections: doc.sections.length,
		paragraphs: paras.length,
		chars,
		alpha_ratio: chars ? Number((alpha / chars).toFixed(3)) : 0,
		word_like_ratio: tokens.length
			? Number((wordLike / tokens.length).toFixed(3))
			: 0,
	};
}

export const QUALITY_GATES = {
	minChars: 1500,
	minParagraphs: 5,
	minAlphaRatio: 0.6,
	// Clean born-digital NRC/ONR PDFs measure ~0.88–0.95; OCR'd 1970s–90s
	// scans with broken text layers fall well below.
	minWordLikeRatio: 0.82,
} as const;

// One 10 CFR section can legitimately be a few hundred characters
// (20.1208 is ~1,100). The size floor exists to catch EMPTY extractions.
const SIZE_FLOORS: Record<string, { minChars: number; minParagraphs: number }> =
	{
		"ecfr-xml": { minChars: 300, minParagraphs: 2 },
	};

export function buildReport(parsed: ParsedSource): {
	report: ParseReport;
	ok: boolean;
	failures: string[];
} {
	const q = textQuality(parsed.doc);
	const report: ParseReport = { ...parsed.report, ...q };
	const floor = SIZE_FLOORS[parsed.report.adapter] ?? QUALITY_GATES;
	const failures: string[] = [];
	if (q.chars < floor.minChars) failures.push(`only ${q.chars} chars`);
	if (q.paragraphs < floor.minParagraphs) {
		failures.push(`only ${q.paragraphs} paragraphs`);
	}
	if (q.alpha_ratio < QUALITY_GATES.minAlphaRatio) {
		failures.push(
			`alpha ratio ${q.alpha_ratio} < ${QUALITY_GATES.minAlphaRatio}`,
		);
	}
	if (q.word_like_ratio < QUALITY_GATES.minWordLikeRatio) {
		failures.push(
			`word-like ratio ${q.word_like_ratio} < ${QUALITY_GATES.minWordLikeRatio} (noisy OCR text layer?)`,
		);
	}
	return { report, ok: failures.length === 0, failures };
}
