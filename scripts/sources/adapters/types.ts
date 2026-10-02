// Shared adapter contract for the Phase 12 publisher. An adapter turns the
// raw bytes of ONE register entry into the chunker's Doc shape plus the text
// quality evidence a reviewer needs to trust the extraction.

import type { Doc } from "../../lib/chunker";

export interface ParseReport {
	adapter: string;
	parser_version: string;
	pages: number | null;
	sections: number;
	paragraphs: number;
	chars: number;
	/** Letters / all characters. Symbol soup from a bad extraction drops this. */
	alpha_ratio: number;
	/** Whitespace tokens that look like words. Noisy OCR drops this. */
	word_like_ratio: number;
	/** Running header/footer lines removed (PDF adapters). */
	boilerplate_lines_removed: number;
	/** Table-of-contents lines dropped (PDF adapters). */
	toc_lines_removed: number;
	warnings: string[];
}

export interface ParsedSource {
	doc: Doc;
	report: Omit<
		ParseReport,
		"sections" | "paragraphs" | "chars" | "alpha_ratio" | "word_like_ratio"
	>;
}

export function normalizeWs(s: string): string {
	return s
		.normalize("NFKC")
		.replace(/ /g, " ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

// "7.1 Waste classification" → { number: "7.1", title: "Waste classification" }
// "Appendix A: Foo"           → { number: "A", title: "Foo" }
// "C. STAFF REGULATORY GUIDANCE" → { number: "C", title: "STAFF REGULATORY GUIDANCE" }
// "Preface"                   → { number: "", title: "Preface" }
export function splitHeading(raw: string): { number: string; title: string } {
	const h = normalizeWs(raw);
	let m = h.match(/^(\d+(?:\.\d+)*)\.?\s+(.+)$/);
	if (m) return { number: m[1] ?? "", title: (m[2] ?? "").trim() || h };
	m = h.match(/^Appendix\s+([A-Z0-9]{1,3})\b[:.\s—–-]*(.*)$/i);
	if (m) {
		return {
			number: (m[1] ?? "").toUpperCase(),
			title: (m[2] || "").trim() || h,
		};
	}
	m = h.match(/^([A-Z](?:\.\d+)*)\.?\s+(.+)$/);
	if (m) return { number: m[1] ?? "", title: (m[2] ?? "").trim() || h };
	return { number: "", title: h };
}
