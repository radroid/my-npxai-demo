// CNSC REGDOC adapter. The CNSC site is a Gatsby app; the document body is
// in the page-data JSON (`/page-data<path>page-data.json` →
// result.data.mdx.body) as clean HTML with section anchors on the headings
// (<h3 id="sec4-1">). Same extraction approach as PR #15's fetcher, with two
// differences that matter for parity with the legacy scrape: numbered
// headings at ANY level start a section (REGDOC-2.5.2 §7.6.2 is an h4), and
// nothing is dropped as "boilerplate" — the legacy corpus kept every section.

import { parse as parseHtml } from "node-html-parser";
import type { Doc, Paragraph, Section } from "../../lib/chunker";
import { normalizeWs, type ParsedSource, splitHeading } from "./types";

export const CNSC_PARSER_VERSION = "cnsc-html@1";

export function cnscPageDataUrl(docUrl: string): string {
	const u = new URL(docUrl);
	const path = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
	return `${u.origin}/page-data${path}page-data.json`;
}

type FlowEvent =
	| { kind: "heading"; level: number; text: string; id: string }
	| { kind: "para"; text: string };

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const PARA_TAGS = new Set([
	"p",
	"blockquote",
	"dd",
	"dt",
	"caption",
	"figcaption",
]);

// biome-ignore lint/suspicious/noExplicitAny: node-html-parser element type
function flatten(node: any, out: FlowEvent[]): void {
	for (const child of node.childNodes ?? []) {
		if (child.nodeType !== 1) continue;
		const tag = String(child.rawTagName || "").toLowerCase();
		if (HEADING_TAGS.has(tag)) {
			const text = normalizeWs(child.text ?? "");
			if (text) {
				out.push({
					kind: "heading",
					level: Number(tag[1]),
					text,
					id: String(child.getAttribute?.("id") ?? ""),
				});
			}
		} else if (tag === "table") {
			for (const tr of child.querySelectorAll("tr")) {
				const cells = tr
					.querySelectorAll("th,td")
					// biome-ignore lint/suspicious/noExplicitAny: element
					.map((c: any) => normalizeWs(c.text ?? ""))
					.filter(Boolean);
				if (cells.length) out.push({ kind: "para", text: cells.join(" | ") });
			}
		} else if (tag === "ul" || tag === "ol") {
			for (const li of child.childNodes ?? []) {
				if (li.nodeType !== 1) continue;
				if (String(li.rawTagName).toLowerCase() !== "li") continue;
				const text = normalizeWs(li.text ?? "");
				if (text) out.push({ kind: "para", text });
			}
		} else if (PARA_TAGS.has(tag)) {
			const text = normalizeWs(child.text ?? "");
			if (text) out.push({ kind: "para", text });
		} else if (
			["div", "section", "article", "aside", "details"].includes(tag)
		) {
			flatten(child, out);
		}
	}
}

const NUMBERED_HEADING_RE =
	/^(?:\d+(?:\.\d+)*\.?|Appendix\s+[A-Z0-9]|[A-Z]\.\d+)\s/i;

export function cnscBodyToSections(bodyHtml: string): Section[] {
	const flow: FlowEvent[] = [];
	flatten(parseHtml(bodyHtml), flow);

	const sections: Section[] = [];
	let current: Section | null = null;
	const preamble: Paragraph[] = [];
	for (const ev of flow) {
		if (ev.kind === "heading") {
			const startsSection = ev.level <= 3 || NUMBERED_HEADING_RE.test(ev.text);
			if (startsSection) {
				const { number, title } = splitHeading(ev.text);
				current = {
					section_number: number,
					section_title: title,
					anchor: /^[a-z0-9-]{1,40}$/i.test(ev.id) ? ev.id : "",
					paragraphs: [],
				};
				sections.push(current);
			} else if (current) {
				current.paragraphs.push({ text: ev.text });
			} else {
				preamble.push({ text: ev.text });
			}
		} else if (current) {
			current.paragraphs.push({ text: ev.text });
		} else {
			preamble.push({ text: ev.text });
		}
	}
	if (preamble.length) {
		sections.unshift({
			section_number: "",
			section_title: "Introduction",
			anchor: "",
			paragraphs: preamble,
		});
	}
	// The in-page table of contents is navigation, not content (the legacy
	// scrape never held it either).
	return sections.filter(
		(s) =>
			s.paragraphs.length > 0 &&
			!/^(?:table of )?contents$/i.test(s.section_title),
	);
}

export function parseCnscPageData(
	json: unknown,
	meta: { ref: string; title: string; canonicalUrl: string },
): ParsedSource {
	const body = (json as { result?: { data?: { mdx?: { body?: string } } } })
		?.result?.data?.mdx?.body;
	if (typeof body !== "string" || body.length < 500) {
		throw new Error(
			`CNSC page-data has no usable mdx.body (len=${body?.length ?? 0})`,
		);
	}
	const sections = cnscBodyToSections(body);
	const doc: Doc = {
		regdoc_id: meta.ref,
		title: meta.title,
		// Section URLs become `${url}#${anchor}` in the chunker.
		url: meta.canonicalUrl,
		source_type: "cnsc-html",
		scraped_at: new Date().toISOString(),
		sections,
	};
	return {
		doc,
		report: {
			adapter: "cnsc-html",
			parser_version: CNSC_PARSER_VERSION,
			pages: null,
			boilerplate_lines_removed: 0,
			toc_lines_removed: 0,
			warnings: sections.some((s) => !s.anchor && s.section_number)
				? [
						"some numbered sections have no anchor; their links use the document URL",
					]
				: [],
		},
	};
}
