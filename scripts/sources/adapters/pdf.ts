// PDF adapter (NRC regulatory guides and NUREGs, ONR SAPs/TAGs, …).
//
// Works line-by-line from pdf.js text content (unpdf's bundled build), so it
// can keep what the plan requires: the PAGE every paragraph came from (each
// chunk then carries page_start/page_end and links to `#page=N`), plus the
// section structure where the document has one. Steps:
//   1. lines per page (pdf.js `hasEOL`), NFKC-normalised;
//   2. drop running headers/footers — a top/bottom-of-page line whose
//      digit-normalised form recurs on >= 30% of pages ("RG 1.21, Rev. 3,
//      Page 12"), bare page numbers, and table-of-contents leader lines;
//   3. detect headings — lettered ("C. STAFF REGULATORY GUIDANCE"),
//      numbered ("1.2 Effluent Monitoring"), "APPENDIX A …" — and compose
//      NRC-style numbers ("C" + "1.2" → "C.1.2");
//   4. join wrapped lines into paragraphs (de-hyphenating), new paragraph on
//      bullets / list designators / headings.
// Structure is best-effort; pages are exact. Quality evidence goes in the
// report and the publisher refuses documents that fail scripts/sources/quality.

import { getDocumentProxy } from "unpdf";
import type { Doc, Paragraph, Section } from "../../lib/chunker";
import { normalizeWs, type ParsedSource, splitHeading } from "./types";

export const PDF_PARSER_VERSION = "pdf-lines@1";

interface PageLines {
	page: number;
	lines: string[];
}

async function extractLines(bytes: Uint8Array): Promise<PageLines[]> {
	const pdf = await getDocumentProxy(bytes);
	const pages: PageLines[] = [];
	for (let p = 1; p <= pdf.numPages; p++) {
		const page = await pdf.getPage(p);
		const content = await page.getTextContent();
		const lines: string[] = [];
		let cur = "";
		for (const item of content.items as Array<{
			str?: string;
			hasEOL?: boolean;
		}>) {
			if (typeof item.str !== "string") continue;
			cur += item.str;
			if (item.hasEOL) {
				lines.push(cur);
				cur = "";
			}
		}
		if (cur) lines.push(cur);
		pages.push({
			page: p,
			lines: lines.map(normalizeWs).filter((l) => l.length > 0),
		});
	}
	return pages;
}

const EDGE_LINES = 3;
const PAGE_NUMBER_RE =
	/^(?:page\s+)?(?:\d{1,4}|[ivxlc]{1,6})(?:\s+of\s+\d{1,4})?$/i;
// Dot leaders anywhere on the line ("1.2 Purpose ........ 3", or several
// entries run together) — body prose never has five dots in a row.
const TOC_LINE_RE = /(?:\.\s?){5,}/;

function boilerplateKey(line: string): string {
	return line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

function stripBoilerplate(pages: PageLines[]): {
	pages: PageLines[];
	removed: number;
	tocRemoved: number;
} {
	const counts = new Map<string, number>();
	for (const { lines } of pages) {
		const edges = new Set([
			...lines.slice(0, EDGE_LINES),
			...lines.slice(Math.max(0, lines.length - EDGE_LINES)),
		]);
		for (const l of edges) {
			const k = boilerplateKey(l);
			counts.set(k, (counts.get(k) ?? 0) + 1);
		}
	}
	const threshold = Math.max(3, Math.ceil(pages.length * 0.3));
	const repeated = new Set(
		[...counts.entries()].filter(([, n]) => n >= threshold).map(([k]) => k),
	);
	let removed = 0;
	let tocRemoved = 0;
	const out = pages.map(({ page, lines }) => {
		const kept: string[] = [];
		lines.forEach((l, i) => {
			const atEdge = i < EDGE_LINES || i >= lines.length - EDGE_LINES;
			if (
				atEdge &&
				(repeated.has(boilerplateKey(l)) || PAGE_NUMBER_RE.test(l))
			) {
				removed += 1;
				return;
			}
			if (TOC_LINE_RE.test(l)) {
				tocRemoved += 1;
				return;
			}
			kept.push(l);
		});
		return { page, lines: kept };
	});
	return { pages: out, removed, tocRemoved };
}

// Heading shapes. All require a short line with no sentence-final period.
const LETTERED_RE = /^([A-H])\.\s+([A-Z][A-Z0-9 ,'’/&()-]{2,80})$/;
const NUMBERED_RE = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+([A-Z][^]{1,100})$/;
const APPENDIX_RE =
	/^(?:APPENDIX|Appendix)\s+([A-Z0-9]{1,3})(?:\s*[:.—–-]\s*|\s+|$)(.{0,100})$/;
const BULLET_RE = /^(?:[•▪◦·o-]\s|\(\w{1,4}\)\s|\d{1,2}\)\s|[a-z]\.\s)/;
const SMALL_WORDS = new Set([
	"a",
	"an",
	"and",
	"as",
	"at",
	"by",
	"for",
	"from",
	"in",
	"into",
	"of",
	"on",
	"or",
	"the",
	"to",
	"with",
	"under",
	"over",
	"per",
	"via",
	"vs",
]);

// A heading title reads like a title: ALL CAPS, or most non-small words
// capitalised. Prose list items ("1. The cask's vulnerability to accidents…"),
// reference-list fragments ('3.0 Computer Codes," issued …') and run-together
// table-of-contents entries fail this.
function isTitleLike(title: string): boolean {
	if (/[“”"«»]|\(Ref\b|\bet al\b|,$/.test(title)) return false;
	if (/\s\d{1,2}(?:\.\d{1,2})*\.?\s+[A-Z]/.test(title)) return false;
	const letters = title.replace(/[^\p{L}]/gu, "");
	if (letters.length >= 4 && letters === letters.toUpperCase()) return true;
	const words = title
		.split(/\s+/)
		.filter((w) => /^\p{L}/u.test(w) && !SMALL_WORDS.has(w.toLowerCase()));
	if (words.length === 0) return false;
	const capitalised = words.filter((w) => /^\p{Lu}/u.test(w)).length;
	return capitalised / words.length >= 0.6;
}

function looksLikeHeading(
	line: string,
): { kind: "letter" | "number" | "appendix"; raw: string } | null {
	if (line.length > 110 || /[.;:,]$/.test(line)) return null;
	if (/^(?:19|20)\d{2}\b/.test(line)) return null; // a year, not a section
	if (LETTERED_RE.test(line)) return { kind: "letter", raw: line };
	const app = line.match(APPENDIX_RE);
	if (app) {
		const title = (app[2] ?? "").trim();
		if (title === "" || isTitleLike(title))
			return { kind: "appendix", raw: line };
		return null;
	}
	const m = line.match(NUMBERED_RE);
	if (m) {
		const top = Number((m[1] ?? "").split(".")[0]);
		const title = m[2] ?? "";
		const words = title.split(/\s+/).length;
		// "10 CFR 50.47 requires …" is prose, not a heading; so is a list item.
		if (
			top >= 1 &&
			top <= 40 &&
			words <= 14 &&
			!/\bCFR\b/.test(line) &&
			isTitleLike(title)
		) {
			return { kind: "number", raw: line };
		}
	}
	return null;
}

export function linesToSections(pages: PageLines[]): Section[] {
	const sections: Section[] = [];
	let letter = "";
	let current: Section = {
		section_number: "",
		section_title: "Front matter",
		anchor: "",
		paragraphs: [],
	};
	let para: { text: string; page: number } | null = null;

	const flushPara = () => {
		if (para && para.text.trim().length > 0) {
			current.paragraphs.push({
				text: normalizeWs(para.text),
				page: para.page,
			} as Paragraph);
		}
		para = null;
	};
	const openSection = (number: string, title: string) => {
		flushPara();
		if (current.paragraphs.length > 0) sections.push(current);
		current = {
			section_number: number,
			section_title: title,
			anchor: "",
			paragraphs: [],
		};
	};

	for (const { page, lines } of pages) {
		for (const line of lines) {
			const heading = looksLikeHeading(line);
			if (heading) {
				const { number, title } = splitHeading(
					heading.kind === "appendix"
						? line.replace(/^APPENDIX/i, "Appendix")
						: line,
				);
				if (heading.kind === "letter") {
					letter = number;
					openSection(number, title);
				} else if (heading.kind === "appendix") {
					letter = "";
					openSection(number, title);
				} else {
					openSection(letter ? `${letter}.${number}` : number, title);
				}
				continue;
			}
			if (para === null || BULLET_RE.test(line)) {
				flushPara();
				para = { text: line, page };
				continue;
			}
			// De-hyphenate a word wrapped across lines; otherwise join with a space.
			const current_para: { text: string; page: number } = para;
			if (/[a-z]-$/.test(current_para.text) && /^[a-z]/.test(line)) {
				current_para.text = current_para.text.slice(0, -1) + line;
			} else {
				current_para.text = `${current_para.text} ${line}`;
			}
			// A line ending a sentence and visibly shorter than a full line closes
			// the paragraph (pdf.js gives no explicit paragraph marks).
			if (/[.!?:]["”’)]?$/.test(line) && line.length < 70) flushPara();
		}
		// Keep paragraphs page-exact: a paragraph never spans a page break.
		flushPara();
	}
	flushPara();
	if (current.paragraphs.length > 0) sections.push(current);
	return sections;
}

export async function parsePdf(
	bytes: Uint8Array,
	meta: { ref: string; title: string; fetchUrl: string },
): Promise<ParsedSource> {
	const raw = await extractLines(bytes);
	const { pages, removed, tocRemoved } = stripBoilerplate(raw);
	const sections = linesToSections(pages);
	const warnings: string[] = [];
	if (sections.length <= 2) {
		warnings.push("few headings detected — chunks are labelled by page only");
	}
	const emptyPages = pages.filter((p) => p.lines.length === 0).length;
	if (emptyPages > pages.length * 0.2) {
		warnings.push(`${emptyPages}/${pages.length} pages have no text layer`);
	}
	const doc: Doc = {
		regdoc_id: meta.ref,
		title: meta.title,
		url: meta.fetchUrl,
		source_type: "pdf",
		scraped_at: new Date().toISOString(),
		sections,
	};
	return {
		doc,
		report: {
			adapter: "pdf",
			parser_version: PDF_PARSER_VERSION,
			pages: pages.length,
			boilerplate_lines_removed: removed,
			toc_lines_removed: tocRemoved,
			warnings,
		},
	};
}
