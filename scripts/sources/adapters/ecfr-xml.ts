// eCFR adapter: one 10 CFR section (DIV8) or appendix (DIV9) from the eCFR
// versioner API (`/api/versioner/v1/full/{date}/title-10.xml?part=…&section=…`).
//
// Sections are split at the TOP-LEVEL paragraph designators — (a), (b), …
// (z), (aa) … — so a citation lands on "10 CFR 20.1201(a)". Nested (1)/(i)
// paragraphs stay inside their parent. "(i)" is ambiguous in CFR text (the
// ninth letter or a roman numeral); it is only treated as top-level when it
// is the next expected letter after "(h)". Appendices split on their <HD>
// headings (<HD1> "I. Organization"). Amendment citations (<CITA>) and editorial
// notes are dropped from the text.

import { parse as parseHtml } from "node-html-parser";
import type { Doc, Section } from "../../lib/chunker";
import { normalizeWs, type ParsedSource } from "./types";

export const ECFR_PARSER_VERSION = "ecfr-xml@1";

function nextLetter(prev: string): string {
	if (prev === "") return "a";
	if (/^[a-y]$/.test(prev)) return String.fromCharCode(prev.charCodeAt(0) + 1);
	if (prev === "z") return "aa";
	// aa → bb → … (CFR doubles the letter)
	const c = prev[0] ?? "a";
	return c === "z"
		? "aaa"
		: String.fromCharCode(c.charCodeAt(0) + 1).repeat(prev.length);
}

export function parseEcfrXml(
	xml: string,
	meta: {
		ref: string;
		title: string;
		canonicalUrl: string;
		sectionId: string | null;
	},
): ParsedSource {
	const root = parseHtml(xml, { lowerCaseTagName: false });
	// node-html-parser matches selectors case-insensitively in lower case.
	const div = root.querySelector("div8") ?? root.querySelector("div9");
	if (!div) throw new Error("eCFR XML has no DIV8/DIV9 element");
	const isAppendix = div.tagName.toUpperCase() === "DIV9";

	const sections: Section[] = [];
	let current: Section = {
		section_number: "",
		section_title: isAppendix
			? "Introduction"
			: normalizeWs(div.querySelector("head")?.text ?? meta.title),
		anchor: "",
		paragraphs: [],
	};
	let expected = "a";

	const push = () => {
		if (current.paragraphs.length > 0) sections.push(current);
	};

	for (const node of div.childNodes) {
		// biome-ignore lint/suspicious/noExplicitAny: node-html-parser node
		const el = node as any;
		if (el.nodeType !== 1) continue;
		const tag = String(el.tagName ?? "").toUpperCase();
		if (["HEAD", "CITA", "EDNOTE", "SECAUTH", "AUTH", "SOURCE"].includes(tag))
			continue;
		if (tag === "HD" || /^HD\d$/.test(tag)) {
			const text = normalizeWs(el.text ?? "");
			const m = text.match(/^([IVXLC]+|[A-Z]|\d+)\.\s+(.+)$/);
			push();
			current = {
				section_number: m ? (m[1] ?? "") : "",
				section_title: m ? (m[2] ?? text) : text,
				anchor: "",
				paragraphs: [],
			};
			continue;
		}
		if (tag === "TABLE" || tag === "GPOTABLE" || tag === "DIV") {
			for (const tr of el.querySelectorAll("tr")) {
				const cells = tr
					.querySelectorAll("th,td")
					// biome-ignore lint/suspicious/noExplicitAny: element
					.map((c: any) => normalizeWs(c.text ?? ""))
					.filter(Boolean);
				if (cells.length) current.paragraphs.push({ text: cells.join(" | ") });
			}
			continue;
		}
		if (tag !== "P" && tag !== "FP" && tag !== "NOTE" && tag !== "EXTRACT")
			continue;
		const text = normalizeWs(el.text ?? "");
		if (!text) continue;
		const designator = text.match(/^\(([a-z]{1,3})\)/)?.[1];
		if (!isAppendix && designator && designator === expected) {
			push();
			current = {
				section_number: `(${designator})`,
				section_title: "",
				anchor:
					meta.sectionId !== null ? `p-${meta.sectionId}(${designator})` : "",
				paragraphs: [],
			};
			expected = nextLetter(designator);
		}
		current.paragraphs.push({ text });
	}
	push();

	const doc: Doc = {
		regdoc_id: meta.ref,
		title: meta.title,
		url: meta.canonicalUrl,
		source_type: "ecfr-xml",
		scraped_at: new Date().toISOString(),
		sections,
	};
	return {
		doc,
		report: {
			adapter: "ecfr-xml",
			parser_version: ECFR_PARSER_VERSION,
			pages: null,
			boilerplate_lines_removed: 0,
			toc_lines_removed: 0,
			warnings: [],
		},
	};
}
