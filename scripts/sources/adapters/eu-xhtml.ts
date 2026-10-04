// EU act adapter: the XHTML manifestation the EU Publications Office serves
// for a CELEX number (`publications.europa.eu/resource/celex/<CELEX>` with
// `Accept: application/xhtml+xml`). EUR-Lex's own HTML pages sit behind a
// JavaScript challenge, so this is the scriptable route to the same text.
//
// Both layouts in use are handled:
//   • Official Journal originals — `oj-ti-art` / `oj-sti-art` / `oj-normal`
//   • consolidated texts         — `title-article-norm` / `stitle-article-norm`
//                                  / `norm`, plus ▼M1 amendment markers
// Each ELI subdivision `art_N` becomes "Article N", each `anx_N` an annex,
// the preamble one "Recitals" section. Amendment markers, footnote markers
// and footnotes are dropped. Section anchors are the ELI ids, which EUR-Lex
// uses on its HTML pages too (…?uri=CELEX:32014L0087#art_1).

import { parse as parseHtml } from "node-html-parser";
import type { Doc, Paragraph, Section } from "../../lib/chunker";
import { normalizeWs, type ParsedSource } from "./types";

export const EU_PARSER_VERSION = "eu-xhtml@1";

// biome-ignore lint/suspicious/noExplicitAny: node-html-parser element
type El = any;

const DROP_CLASSES =
	/\b(?:modref|arrow|oj-note-tag|note-tag|footnote|oj-note|separator)\b/;
const ARTICLE_TITLE = /\b(?:oj-ti-art|title-article-norm)\b/;
const ARTICLE_SUBTITLE = /\b(?:oj-sti-art|stitle-article-norm)\b/;
const ANNEX_TITLE = /\b(?:oj-doc-ti|title-annex-1|title-doc-first)\b/;

function cls(el: El): string {
	return String(el.getAttribute?.("class") ?? "");
}

/** Text of an element without dropped descendants (markers, footnotes). */
function cleanText(el: El): string {
	const clone = parseHtml(el.toString());
	for (const d of clone.querySelectorAll("*")) {
		if (DROP_CLASSES.test(cls(d))) d.remove();
	}
	return normalizeWs(clone.text);
}

const SUBDIVISION_ID = /^(?:art|anx)_[A-Za-z0-9]+$/;

function directChildren(el: El): El[] {
	return (el.childNodes ?? []).filter((c: El) => c.nodeType === 1);
}

/** The subdivision's own heading elements (not those of quoted articles). */
function ownHeadings(div: El): { title: El | null; subtitle: El | null } {
	let title: El | null = null;
	let subtitle: El | null = null;
	for (const c of directChildren(div)) {
		if (!title && (ARTICLE_TITLE.test(cls(c)) || ANNEX_TITLE.test(cls(c))))
			title = c;
		if (!subtitle && /\beli-title\b/.test(cls(c))) {
			subtitle =
				c
					.querySelectorAll("p")
					.find((p: El) => ARTICLE_SUBTITLE.test(cls(p))) ?? c;
		}
		if (!subtitle && ARTICLE_SUBTITLE.test(cls(c))) subtitle = c;
	}
	return { title, subtitle };
}

/**
 * Body paragraphs of one subdivision, in reading order. Paragraph units are
 * <p>, a consolidated `div.norm` ("1. " + text) and a `grid-container` list
 * row ("(a) " + text); an OJ list <table> contributes one paragraph per
 * outer row so a designator stays with its words. The subdivision's own
 * heading is skipped; headings of articles QUOTED inside an amending act
 * are kept, they say what is being inserted.
 */
function paragraphsOf(container: El): Paragraph[] {
	const out: Paragraph[] = [];
	const { title, subtitle } = ownHeadings(container);
	const push = (el: El) => {
		const text = cleanText(el);
		if (text) out.push({ text });
	};
	const walk = (node: El) => {
		for (const child of directChildren(node)) {
			const tag = String(child.rawTagName ?? "").toLowerCase();
			const c = cls(child);
			if (child === title || child === subtitle) continue;
			if (DROP_CLASSES.test(c)) continue;
			if (/\beli-title\b/.test(c) && node === container) continue;
			// A nested top-level subdivision is emitted as its own section.
			if (
				tag === "div" &&
				node !== container &&
				SUBDIVISION_ID.test(String(child.getAttribute?.("id") ?? ""))
			) {
				continue;
			}
			if (tag === "table") {
				const body =
					directChildren(child).find(
						(b: El) => String(b.rawTagName).toLowerCase() === "tbody",
					) ?? child;
				for (const tr of directChildren(body)) {
					if (String(tr.rawTagName).toLowerCase() === "tr") push(tr);
				}
				continue;
			}
			if (tag === "p" || /\b(?:grid-container|norm)\b/.test(c)) {
				push(child);
				continue;
			}
			walk(child);
		}
	};
	walk(container);
	return out;
}

export function euXhtmlToSections(xhtml: string): Section[] {
	const root = parseHtml(xhtml, { lowerCaseTagName: false });
	const sections: Section[] = [];
	const subdivisions = root
		.querySelectorAll("div")
		.filter((d: El) => /\beli-subdivision\b/.test(cls(d)));

	// Recitals: everything in the preamble (pbl_1) — the "whereas" clauses.
	const preamble = subdivisions.find(
		(d: El) => d.getAttribute("id") === "pbl_1",
	);
	if (preamble) {
		const paras = paragraphsOf(preamble).filter(
			(p) => !/^HAS ADOPTED/i.test(p.text),
		);
		if (paras.length) {
			sections.push({
				section_number: "",
				section_title: "Recitals",
				anchor: "pbl_1",
				paragraphs: paras,
			});
		}
	}

	for (const div of subdivisions) {
		const id = String(div.getAttribute("id") ?? "");
		const art = id.match(/^art_(\d+[a-z]?)$/);
		const anx = id.match(/^anx_([A-Z0-9]+)$/);
		if (!art && !anx) continue;
		const { title, subtitle } = ownHeadings(div);
		if (art) {
			sections.push({
				section_number: `Art. ${art[1]}`,
				section_title: subtitle ? cleanText(subtitle) : `Article ${art[1]}`,
				anchor: id,
				paragraphs: paragraphsOf(div),
			});
		} else if (anx) {
			sections.push({
				section_number: `Annex ${anx[1]}`,
				section_title: subtitle
					? cleanText(subtitle)
					: title
						? cleanText(title)
						: `Annex ${anx[1]}`,
				anchor: id,
				paragraphs: paragraphsOf(div),
			});
		}
	}
	return sections.filter((s) => s.paragraphs.length > 0);
}

export function parseEuXhtml(
	xhtml: string,
	meta: { ref: string; title: string; canonicalUrl: string },
): ParsedSource {
	const sections = euXhtmlToSections(xhtml);
	const warnings: string[] = [];
	if (!sections.some((s) => s.section_number.startsWith("Art."))) {
		warnings.push("no ELI article subdivisions found");
	}
	const doc: Doc = {
		regdoc_id: meta.ref,
		title: meta.title,
		url: meta.canonicalUrl,
		source_type: "eu-xhtml",
		scraped_at: new Date().toISOString(),
		sections,
	};
	return {
		doc,
		report: {
			adapter: "eu-xhtml",
			parser_version: EU_PARSER_VERSION,
			pages: null,
			boilerplate_lines_removed: 0,
			toc_lines_removed: 0,
			warnings,
		},
	};
}
