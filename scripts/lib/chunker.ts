// Shared chunker (Appendix C.4) for BOTH ingestion paths:
//   scripts/ingest.ts           — legacy CNSC corpus → regdoc_chunks
//   scripts/sources/publish.ts  — Phase 12 manifest-driven publish → source_chunks
//
// Moved verbatim out of scripts/ingest.ts so the two paths cannot drift: the
// algorithm, constants and classifier are byte-for-byte the pre-move code
// (scripts/test-sources.ts asserts identical output on the legacy JSON). The
// only addition is OPTIONAL page tracking — a paragraph may carry the PDF page
// it came from, and each chunk then reports the page range of the sentences it
// contains. Paragraphs without pages (all legacy input) yield null ranges and
// otherwise identical chunks.

import { get_encoding } from "tiktoken";

export const CHUNK_TARGET_TOKENS = 400;
export const CHUNK_OVERLAP_TOKENS = 60;
export const CHUNK_MIN_TOKENS = 40; // skip tiny orphan chunks (ToC remnants, etc.)
export const CHUNK_HARD_MAX_TOKENS = 700; // safety cap

export type ScrapedRequirementType =
	| "informational"
	| "guidance"
	| "requirement";

export interface Paragraph {
	text: string;
	paragraph_number?: string;
	requirement_type?: ScrapedRequirementType;
	/** 1-based PDF page this paragraph was extracted from (PDF adapters only). */
	page?: number | null;
}

export interface Section {
	section_number: string;
	section_title: string;
	anchor?: string;
	paragraphs: Paragraph[];
}

export interface Doc {
	regdoc_id: string;
	title: string;
	url: string;
	source_type?: string;
	scraped_at?: string;
	sections: Section[];
}

export interface Chunk {
	regdoc_id: string;
	title: string;
	section_number: string | null;
	section_title: string | null;
	chunk_text: string;
	chunk_index: number;
	url: string | null;
	requirement_type: "requirement" | "guidance";
}

/** A Chunk plus the PDF page range of its sentences (null without pages). */
export interface PagedChunk extends Chunk {
	page_start: number | null;
	page_end: number | null;
}

// Appendix C.3 requirement-vs-guidance classifier. Run against the fully
// assembled chunk, so it's robust to paragraph-boundary overlap.
const REQUIREMENT_MARKERS = [
	/\bshall\b/i,
	/\bmust\b/i,
	/\brequired to\b/i,
	/\bis required\b/i,
];
const GUIDANCE_MARKERS = [
	/\bshould\b/i,
	/\bmay\b/i,
	/\bis recommended\b/i,
	/\bit is expected that\b/i,
];

export function classifyRequirement(text: string): "requirement" | "guidance" {
	if (REQUIREMENT_MARKERS.some((re) => re.test(text))) return "requirement";
	if (GUIDANCE_MARKERS.some((re) => re.test(text))) return "guidance";
	return "guidance";
}

const encoder = get_encoding("cl100k_base");
export function countTokens(text: string): number {
	return encoder.encode(text).length;
}
export function freeEncoder(): void {
	encoder.free();
}

// Sentence splitter — breaks on sentence terminators followed by whitespace
// then a capital letter / digit / open-quote. Conservative; if it misses a
// boundary, the chunker will still flush when the token budget is hit.
function splitSentences(text: string): string[] {
	const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
	return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

function assembleSectionText(section: Section): string {
	return section.paragraphs
		.map((p) => p.text?.trim() ?? "")
		.filter((t) => t.length > 0)
		.join("\n\n");
}

// Pages every sentence of the assembled section text touches, located by
// walking the paragraph character ranges in order. A sentence that runs on
// past a page break ("… the RSO should" | "be able to …") spans both pages,
// so its whole extent is mapped, not just its first character. Empty when no
// paragraph has a page.
function sentencePages(section: Section, sentences: string[]): number[][] {
	const paras = section.paragraphs
		.map((p) => ({ text: p.text?.trim() ?? "", page: p.page ?? null }))
		.filter((p) => p.text.length > 0);
	if (!paras.some((p) => p.page !== null)) return sentences.map(() => []);
	const ranges: Array<{ start: number; end: number; page: number | null }> = [];
	let offset = 0;
	for (const p of paras) {
		ranges.push({ start: offset, end: offset + p.text.length, page: p.page });
		offset += p.text.length + 2; // "\n\n" joiner
	}
	const full = assembleSectionText(section);
	let cursor = 0;
	return sentences.map((s) => {
		const at = full.indexOf(s, cursor);
		const pos = at >= 0 ? at : cursor;
		if (at >= 0) cursor = at + s.length;
		const end = pos + Math.max(1, s.length);
		const touched = new Set<number>();
		for (const r of ranges) {
			if (r.page !== null && r.start < end && pos < r.end + 2) {
				touched.add(r.page);
			}
		}
		return [...touched];
	});
}

// Word windows of at most `target` tokens (a word longer than that is kept
// whole — the hard cap is the embedding limit, far above it).
function splitByTokens(text: string, target: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const out: string[] = [];
	let cur: string[] = [];
	let curTokens = 0;
	for (const w of words) {
		const t = countTokens(` ${w}`);
		if (curTokens + t > target && cur.length > 0) {
			out.push(cur.join(" "));
			cur = [];
			curTokens = 0;
		}
		cur.push(w);
		curTokens += t;
	}
	if (cur.length > 0) out.push(cur.join(" "));
	return out;
}

function buildSectionUrl(section: Section, doc: Doc): string {
	if (section.anchor && section.anchor.length > 0) {
		return `${doc.url}#${section.anchor}`;
	}
	return doc.url;
}

export interface ChunkingStats {
	totalSections: number;
	emptySections: number;
	chunksEmitted: number;
	skippedTiny: number;
}

export function emptyStats(): ChunkingStats {
	return {
		totalSections: 0,
		emptySections: 0,
		chunksEmitted: 0,
		skippedTiny: 0,
	};
}

function pageRange(pages: number[][]): {
	page_start: number | null;
	page_end: number | null;
} {
	const known = pages.flat();
	if (known.length === 0) return { page_start: null, page_end: null };
	return { page_start: Math.min(...known), page_end: Math.max(...known) };
}

/**
 * `minTokens` drops tiny orphan chunks (ToC remnants in scraped HTML). Legal
 * texts split per paragraph or article pass a lower floor: a two-line
 * "(d) …" paragraph of a regulation is content, not noise.
 */
export function chunkDocPaged(
	doc: Doc,
	stats: ChunkingStats,
	opts: { minTokens?: number; splitOversized?: boolean } = {},
): PagedChunk[] {
	const minTokens = opts.minTokens ?? CHUNK_MIN_TOKENS;
	const out: PagedChunk[] = [];
	let chunkIndex = 0;

	for (const section of doc.sections) {
		stats.totalSections++;
		const sectionText = assembleSectionText(section);
		if (!sectionText) {
			stats.emptySections++;
			continue;
		}

		const url = buildSectionUrl(section, doc);
		const sentences = splitSentences(sectionText);
		const pages = sentencePages(section, sentences);

		let bufferSentences: string[] = [];
		let bufferPages: number[][] = [];
		let bufferTokens = 0;

		const flush = () => {
			if (bufferSentences.length === 0) return;
			const text = bufferSentences.join(" ").trim();
			const tokens = countTokens(text);
			if (tokens < minTokens) {
				stats.skippedTiny++;
				return;
			}
			out.push({
				regdoc_id: doc.regdoc_id,
				title: doc.title,
				section_number: section.section_number?.length
					? section.section_number
					: null,
				section_title: section.section_title?.length
					? section.section_title
					: null,
				chunk_text: text,
				chunk_index: chunkIndex++,
				url,
				requirement_type: classifyRequirement(text),
				...pageRange(bufferPages),
			});
			stats.chunksEmitted++;
		};

		for (let si = 0; si < sentences.length; si++) {
			const sentence = sentences[si]!;
			const sentPages = pages[si] ?? [];
			const sentTokens = countTokens(sentence);

			// Overflow guard: even a single sentence can exceed the target.
			// Emit what we have, then emit the oversized sentence as its own chunk
			// — or, with splitOversized (the Phase 12 publisher), as consecutive
			// word windows of ~CHUNK_TARGET_TOKENS: PDF tables and run-on lists
			// can be one 8,000-token "sentence", beyond the embedding model's
			// input limit. The legacy scrape never hits this, so its output is
			// unchanged.
			if (sentTokens > CHUNK_HARD_MAX_TOKENS) {
				flush();
				bufferSentences = [];
				bufferPages = [];
				bufferTokens = 0;
				const pieces = opts.splitOversized
					? splitByTokens(sentence, CHUNK_TARGET_TOKENS)
					: [sentence];
				for (const piece of pieces) {
					out.push({
						regdoc_id: doc.regdoc_id,
						title: doc.title,
						section_number: section.section_number?.length
							? section.section_number
							: null,
						section_title: section.section_title?.length
							? section.section_title
							: null,
						chunk_text: piece,
						chunk_index: chunkIndex++,
						url,
						requirement_type: classifyRequirement(piece),
						...pageRange([sentPages]),
					});
					stats.chunksEmitted++;
				}
				continue;
			}

			if (
				bufferTokens + sentTokens > CHUNK_TARGET_TOKENS &&
				bufferTokens >= CHUNK_TARGET_TOKENS - 100
			) {
				flush();

				// Retain the trailing CHUNK_OVERLAP_TOKENS worth of sentences
				// as the seed of the next chunk.
				const overlap: string[] = [];
				const overlapPages: number[][] = [];
				let overlapTokens = 0;
				for (let i = bufferSentences.length - 1; i >= 0; i--) {
					const s = bufferSentences[i]!;
					const t = countTokens(s);
					if (overlapTokens + t > CHUNK_OVERLAP_TOKENS) break;
					overlap.unshift(s);
					overlapPages.unshift(bufferPages[i] ?? []);
					overlapTokens += t;
				}
				bufferSentences = overlap;
				bufferPages = overlapPages;
				bufferTokens = overlapTokens;
			}

			bufferSentences.push(sentence);
			bufferPages.push(sentPages);
			bufferTokens += sentTokens;
		}

		flush();
	}

	return out;
}

/** The legacy shape scripts/ingest.ts inserts into regdoc_chunks. */
export function chunkDoc(doc: Doc, stats: ChunkingStats): Chunk[] {
	return chunkDocPaged(doc, stats).map(
		({ page_start: _ps, page_end: _pe, ...chunk }) => chunk,
	);
}
