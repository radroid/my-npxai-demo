// DOCX adapter (ONR Technical Assessment Guides are published only as Word
// files). A .docx is a zip; the body is word/document.xml. This reads the
// zip's central directory directly (node:zlib inflates the entries), so no
// archive dependency is added for one publisher.
//
// Structure comes from paragraph styles: "Heading N" / "TOC N" / "Title"
// (by style id or by the style's display name in word/styles.xml, since
// ONR templates rename them) and outline levels. Heading numbers in TAGs are
// usually Word auto-numbering — not in the text — so they are regenerated
// from heading levels the way Word counts them. Tables become one
// "cell | cell" paragraph per row. Table-of-contents paragraphs are dropped.

import { inflateRawSync } from "node:zlib";
import { parse as parseHtml } from "node-html-parser";
import type { Doc, Paragraph, Section } from "../../lib/chunker";
import { normalizeWs, type ParsedSource, splitHeading } from "./types";

export const DOCX_PARSER_VERSION = "docx@1";

const MAX_ENTRY_BYTES = 30_000_000;

/** Minimal zip reader: returns the named entries' bytes. */
export function readZipEntries(
	zip: Uint8Array,
	names: string[],
): Map<string, Uint8Array> {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	const want = new Set(names);
	const out = new Map<string, Uint8Array>();
	// End of central directory: last 22..(22+65535) bytes.
	let eocd = -1;
	for (
		let i = zip.length - 22;
		i >= Math.max(0, zip.length - 22 - 65_535);
		i--
	) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0)
		throw new Error("not a zip file (no end-of-central-directory record)");
	const count = view.getUint16(eocd + 10, true);
	let p = view.getUint32(eocd + 16, true);
	const decoder = new TextDecoder();
	for (let n = 0; n < count; n++) {
		if (view.getUint32(p, true) !== 0x02014b50)
			throw new Error("corrupt zip central directory");
		const method = view.getUint16(p + 10, true);
		const compressed = view.getUint32(p + 20, true);
		const size = view.getUint32(p + 24, true);
		const nameLen = view.getUint16(p + 28, true);
		const extraLen = view.getUint16(p + 30, true);
		const commentLen = view.getUint16(p + 32, true);
		const local = view.getUint32(p + 42, true);
		const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen));
		p += 46 + nameLen + extraLen + commentLen;
		if (!want.has(name)) continue;
		if (size > MAX_ENTRY_BYTES)
			throw new Error(`zip entry ${name} too large (${size} bytes)`);
		if (view.getUint32(local, true) !== 0x04034b50)
			throw new Error("corrupt zip local header");
		const start =
			local +
			30 +
			view.getUint16(local + 26, true) +
			view.getUint16(local + 28, true);
		const data = zip.subarray(start, start + compressed);
		if (method === 0) out.set(name, data.slice());
		else if (method === 8)
			out.set(
				name,
				new Uint8Array(
					inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }),
				),
			);
		else
			throw new Error(
				`unsupported zip compression method ${method} for ${name}`,
			);
	}
	return out;
}

// biome-ignore lint/suspicious/noExplicitAny: node-html-parser element
type El = any;

// CSS selectors cannot address namespaced tags (w:p), so walk by raw name.
function all(el: El, tag: string, out: El[] = []): El[] {
	for (const c of el.childNodes ?? []) {
		if (c.nodeType !== 1) continue;
		if (c.rawTagName === tag) out.push(c);
		all(c, tag, out);
	}
	return out;
}
function first(el: El, tag: string): El | null {
	for (const c of el.childNodes ?? []) {
		if (c.nodeType !== 1) continue;
		if (c.rawTagName === tag) return c;
		const hit = first(c, tag);
		if (hit) return hit;
	}
	return null;
}
const TEXT_TAGS = new Set(["w:t", "w:tab", "w:br", "w:cr"]);

interface StyleInfo {
	heading: number | null;
	toc: boolean;
	title: boolean;
}

function readStyles(stylesXml: string | undefined): Map<string, StyleInfo> {
	const map = new Map<string, StyleInfo>();
	if (!stylesXml) return map;
	const root = parseHtml(stylesXml, { lowerCaseTagName: false });
	for (const st of all(root, "w:style")) {
		const id = String(st.getAttribute("w:styleId") ?? "");
		const name = String(
			first(st, "w:name")?.getAttribute("w:val") ?? "",
		).toLowerCase();
		const outline = first(st, "w:outlineLvl")?.getAttribute("w:val");
		let heading: number | null = null;
		const m = name.match(/^heading\s*(\d)$/) ?? id.match(/^Heading(\d)$/);
		if (m) heading = Number(m[1]);
		else if (
			outline !== undefined &&
			outline !== null &&
			/^\d$/.test(String(outline))
		) {
			heading = Number(outline) + 1;
		}
		map.set(id, {
			heading,
			toc:
				/^toc\s*\d|^toc heading$|^table of contents/.test(name) ||
				/^TOC\d/.test(id),
			title: name === "title" || id === "Title",
		});
	}
	return map;
}

function paragraphText(p: El): string {
	let text = "";
	const walk = (el: El) => {
		for (const c of el.childNodes ?? []) {
			if (c.nodeType !== 1) continue;
			if (TEXT_TAGS.has(c.rawTagName))
				text += c.rawTagName === "w:t" ? c.text : " ";
			// Deleted revisions and field instructions are not document text.
			else if (c.rawTagName !== "w:del" && c.rawTagName !== "w:instrText")
				walk(c);
		}
	};
	walk(p);
	return normalizeWs(text);
}

export function docxToSections(
	documentXml: string,
	stylesXml?: string,
): {
	sections: Section[];
	tocRemoved: number;
} {
	const styles = readStyles(stylesXml);
	const root = parseHtml(documentXml, { lowerCaseTagName: false });
	const body = first(root, "w:body");
	if (!body) throw new Error("word/document.xml has no <w:body>");

	const sections: Section[] = [];
	const counters = [0, 0, 0, 0, 0, 0];
	let tocRemoved = 0;
	let current: Section = {
		section_number: "",
		section_title: "Front matter",
		anchor: "",
		paragraphs: [],
	};
	const open = (number: string, title: string) => {
		if (current.paragraphs.length > 0) sections.push(current);
		current = {
			section_number: number,
			section_title: title,
			anchor: "",
			paragraphs: [],
		};
	};
	const push = (text: string) => {
		if (text) current.paragraphs.push({ text } as Paragraph);
	};

	for (const child of body.childNodes ?? []) {
		if (child.nodeType !== 1) continue;
		const tag = String(child.rawTagName);
		if (tag === "w:tbl") {
			for (const tr of all(child, "w:tr")) {
				const cells = all(tr, "w:tc")
					.map((tc: El) =>
						all(tc, "w:p").map(paragraphText).filter(Boolean).join(" "),
					)
					.filter(Boolean);
				if (cells.length) push(cells.join(" | "));
			}
			continue;
		}
		if (tag === "w:sdt") {
			// Structured document tags wrap the generated table of contents.
			if (/TOC|Table of Contents/i.test(child.toString().slice(0, 2000))) {
				tocRemoved += all(child, "w:p").length;
				continue;
			}
			for (const p of all(child, "w:p")) push(paragraphText(p));
			continue;
		}
		if (tag !== "w:p") continue;
		const styleId = String(
			first(child, "w:pStyle")?.getAttribute("w:val") ?? "",
		);
		const style = styles.get(styleId) ?? {
			heading: /^Heading(\d)$/.exec(styleId)
				? Number(/^Heading(\d)$/.exec(styleId)?.[1])
				: null,
			toc: /^TOC\d/.test(styleId),
			title: styleId === "Title",
		};
		const text = paragraphText(child);
		if (style.toc) {
			tocRemoved += 1;
			continue;
		}
		if (!text) continue;
		if (style.heading !== null && style.heading <= 4 && text.length <= 160) {
			const level = style.heading;
			const explicit = splitHeading(text);
			let number = explicit.number;
			let title = explicit.title;
			const numbered = first(child, "w:numPr") !== null || styles.has(styleId);
			if (!number && numbered) {
				counters[level - 1] += 1;
				for (let i = level; i < counters.length; i++) counters[i] = 0;
				number = counters
					.slice(0, level)
					.map((c) => Math.max(c, 1))
					.join(".");
				title = text;
			} else if (number) {
				const parts = number.split(".").map(Number);
				if (parts.every((n) => Number.isFinite(n))) {
					parts.forEach((n, i) => {
						counters[i] = n;
					});
					for (let i = parts.length; i < counters.length; i++) counters[i] = 0;
				}
			}
			open(number, title);
			continue;
		}
		push(text);
	}
	if (current.paragraphs.length > 0) sections.push(current);
	return { sections, tocRemoved };
}

export function parseDocx(
	bytes: Uint8Array,
	meta: { ref: string; title: string; canonicalUrl: string },
): ParsedSource {
	const entries = readZipEntries(bytes, [
		"word/document.xml",
		"word/styles.xml",
	]);
	const docXml = entries.get("word/document.xml");
	if (!docXml) throw new Error("DOCX has no word/document.xml");
	const decoder = new TextDecoder();
	const stylesBytes = entries.get("word/styles.xml");
	const { sections, tocRemoved } = docxToSections(
		decoder.decode(docXml),
		stylesBytes ? decoder.decode(stylesBytes) : undefined,
	);
	const warnings: string[] = [];
	if (sections.length <= 2) warnings.push("few headings detected");
	const doc: Doc = {
		regdoc_id: meta.ref,
		title: meta.title,
		url: meta.canonicalUrl,
		source_type: "docx",
		scraped_at: new Date().toISOString(),
		sections,
	};
	return {
		doc,
		report: {
			adapter: "docx",
			parser_version: DOCX_PARSER_VERSION,
			pages: null,
			boilerplate_lines_removed: 0,
			toc_lines_removed: tocRemoved,
			warnings,
		},
	};
}
