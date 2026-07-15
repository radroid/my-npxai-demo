#!/usr/bin/env bun
// Fetch best-practice source documents (CNSC + IAEA + US NRC) and emit them as
// scraped_regdocs/*.json in the exact schema scripts/ingest.ts consumes, so the
// existing chunk → embed → atomic-swap pipeline can ingest them unchanged.
//
// This does NOT touch any database. It only downloads public documents and
// writes local JSON. Ingestion is a separate, explicit step (`bun run ingest`).
//
// Source of truth for WHAT to fetch is the committed manifest
// resources/best-practices-sources.json (id, title, url, source, license,
// verdict, sca, topics). Only GREEN-verdict sources are fetched by default;
// RED is never fetched; YELLOW requires --allow-yellow. This keeps the licensing
// decision reviewable in git rather than buried in code.
//
// Extraction paths (see OVERNIGHT.md "Fetcher findings"):
//   source: "cnsc" — the CNSC site is a Gatsby SPA whose raw HTML is a JS shell.
//     We fetch the page-data JSON (…/page-data<path>page-data.json) and parse
//     result.data.mdx.body, which is the full document as clean HTML. We capture
//     <p> AND <li> (and table cells) because most "shall/must" requirements live
//     in bulleted lists.
//   source: "pdf" — IAEA / NRC documents. Download the PDF, extract text with
//     unpdf, and segment into sections by heading heuristics. Lower structural
//     fidelity than CNSC HTML, but the sentence-based chunker in ingest.ts
//     tolerates approximate section boundaries.
//
// CLI:
//   bun run scripts/fetch-best-practices.ts               # fetch all GREEN sources
//   bun run scripts/fetch-best-practices.ts --only=IAEA-SSG-14
//   bun run scripts/fetch-best-practices.ts --dry         # fetch+parse, print stats, no writes
//   bun run scripts/fetch-best-practices.ts --allow-yellow
//   bun run scripts/fetch-best-practices.ts --manifest=resources/best-practices-sources.json

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parse as parseHtml } from "node-html-parser";
import { extractText, getDocumentProxy } from "unpdf";

const REPO_ROOT = process.cwd();
const OUT_DIR = join(REPO_ROOT, "scraped_regdocs");
const RUN_LOG = join(OUT_DIR, "_best_practices_run_log.txt");
const USER_AGENT =
	"npxai-educational-rag-demo/1.0 (non-commercial; contact raj9dholakia@gmail.com)";
const FETCH_TIMEOUT_MS = 45_000;
const POLITE_DELAY_MS = 1500; // between requests to the same host family
const MAX_RESPONSE_BYTES = 80_000_000; // reject implausibly large downloads (OOM guard)

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const ALLOW_YELLOW = argv.includes("--allow-yellow");
const ONLY = argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const PUBLISHER = argv.find((a) => a.startsWith("--publisher="))?.split("=")[1];
const SOURCE_FILTER = argv
	.find((a) => a.startsWith("--source="))
	?.split("=")[1];
const MANIFEST_PATH =
	argv.find((a) => a.startsWith("--manifest="))?.split("=")[1] ??
	"resources/best-practices-sources.json";

type Verdict = "GREEN" | "YELLOW" | "RED";
type SourceKind = "cnsc" | "pdf";

interface ManifestSource {
	id: string; // becomes regdoc_id, e.g. "REGDOC-2.11.1-vol1", "IAEA-SSG-14", "NRC-RG-8.13"
	title: string;
	url: string;
	source: SourceKind;
	license: string;
	verdict: Verdict;
	publisher?: string;
	sca?: string[];
	topics?: string[];
}

type ReqType = "informational" | "guidance" | "requirement";

interface Paragraph {
	text: string;
	paragraph_number?: string;
	requirement_type?: ReqType;
}
interface Section {
	section_number: string;
	section_title: string;
	anchor?: string;
	paragraphs: Paragraph[];
}
interface Doc {
	regdoc_id: string;
	title: string;
	url: string;
	source_type: string;
	scraped_at: string;
	sections: Section[];
}

// Mirror ingest.ts's classifier so the JSON's per-paragraph requirement_type is
// honest. (ingest.ts re-classifies per assembled chunk, so this is advisory.)
function classifyRequirement(text: string): ReqType {
	if (/\bshall\b|\bmust\b|\brequired to\b|\bis required\b/i.test(text))
		return "requirement";
	if (
		/\bshould\b|\bmay\b|\bis recommended\b|\bit is expected that\b/i.test(text)
	)
		return "guidance";
	return "informational";
}

function normalizeWs(s: string): string {
	return s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

// "7.1 Waste classification" -> { number: "7.1", title: "Waste classification" }
// "1. Introduction" -> { number: "1", title: "Introduction" }
// "Appendix A: Foo" -> { number: "A", title: "Foo" }
// "Preface" -> { number: "", title: "Preface" }
function splitHeading(raw: string): { number: string; title: string } {
	const h = normalizeWs(raw);
	let m = h.match(/^(\d+(?:\.\d+)*)\.?\s+(.+)$/);
	if (m) return { number: m[1] ?? "", title: (m[2] ?? "").trim() || h };
	m = h.match(/^Appendix\s+([A-Z])\b[:.\s]*(.*)$/i);
	if (m)
		return {
			number: (m[1] ?? "").toUpperCase(),
			title: (m[2] || "").trim() || h,
		};
	m = h.match(/^([A-Z])\.\s+(.+)$/); // "A. Introduction"
	if (m) return { number: m[1] ?? "", title: (m[2] ?? "").trim() || h };
	return { number: "", title: h };
}

// ─── CNSC: Gatsby page-data → mdx.body HTML → sections ──────────────────────
function cnscPageDataUrl(docUrl: string): string {
	const u = new URL(docUrl);
	const path = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
	return `${u.origin}/page-data${path}page-data.json`;
}

// Walk the mdx.body DOM in document order, emitting heading/para events.
type FlowEvent =
	| { kind: "heading"; level: number; text: string }
	| { kind: "para"; text: string };

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const PARA_TAGS = new Set(["p", "li", "blockquote", "dd", "dt", "caption"]);

// biome-ignore lint/suspicious/noExplicitAny: node-html-parser node type
function flattenFlow(node: any, out: FlowEvent[]): void {
	for (const child of node.childNodes ?? []) {
		if (child.nodeType !== 1) continue; // element nodes only
		const tag = String(child.rawTagName || "").toLowerCase();
		if (HEADING_TAGS.has(tag)) {
			const text = normalizeWs(child.text ?? "");
			if (text) out.push({ kind: "heading", level: Number(tag[1]), text });
		} else if (tag === "table") {
			// flatten each row to "cell | cell | cell"
			for (const tr of child.querySelectorAll("tr")) {
				const cells = tr
					.querySelectorAll("th,td")
					// biome-ignore lint/suspicious/noExplicitAny: node
					.map((c: any) => normalizeWs(c.text ?? ""))
					.filter(Boolean);
				if (cells.length) out.push({ kind: "para", text: cells.join(" | ") });
			}
		} else if (tag === "ul" || tag === "ol") {
			for (const li of child.childNodes ?? []) {
				if (li.nodeType === 1 && String(li.rawTagName).toLowerCase() === "li") {
					const text = normalizeWs(li.text ?? "");
					if (text) out.push({ kind: "para", text });
				}
			}
		} else if (PARA_TAGS.has(tag)) {
			const text = normalizeWs(child.text ?? "");
			if (text) out.push({ kind: "para", text });
		} else if (tag === "div" || tag === "section" || tag === "article") {
			flattenFlow(child, out); // recurse into wrappers
		}
	}
}

// Administrative front-/back-matter sections that are near-IDENTICAL across
// every CNSC REGDOC (the same NSCA/regulation list, the same document-series
// blurb, the same preface). Ingesting them from 26 new docs injects 26 copies
// of low-signal boilerplate that broad queries collapse onto, measurably
// displacing substantive gold chunks (see docs/best-practices-corpus.md, the
// "§1.3 collision" root cause). We drop them so only the substantive technical
// sections enter the corpus. Titles/numbers are matched conservatively.
const DROP_SECTION_TITLE_RE =
	/^(preface|table of contents|foreword|about this document(?:ary series)?|relevant legislation|related (?:documents|information)|additional information|references|glossary(?: of terms)?|abbreviations(?: and acronyms)?)\b/i;
// "1.3 Relevant legislation" also arrives as section_number 1.3 with that title;
// match on title is sufficient, but front-matter series lists sometimes carry
// no number — the title match covers both.
function isBoilerplateSection(s: Section): boolean {
	return DROP_SECTION_TITLE_RE.test(s.section_title.trim());
}

export function cnscBodyToSections(bodyHtml: string): Section[] {
	const root = parseHtml(bodyHtml);
	const flow: FlowEvent[] = [];
	flattenFlow(root, flow);

	const sections: Section[] = [];
	let current: Section | null = null;
	const preamble: Paragraph[] = [];

	for (const ev of flow) {
		if (ev.kind === "heading") {
			// Only h2/h3 start a numbered/titled section; deeper headings become
			// a paragraph lead-in so their content isn't orphaned.
			if (ev.level <= 3) {
				const { number, title } = splitHeading(ev.text);
				current = {
					section_number: number,
					section_title: title,
					anchor: "",
					paragraphs: [],
				};
				sections.push(current);
			} else if (current) {
				current.paragraphs.push({
					text: ev.text,
					requirement_type: "informational",
				});
			}
		} else {
			const p: Paragraph = {
				text: ev.text,
				requirement_type: classifyRequirement(ev.text),
			};
			if (current) current.paragraphs.push(p);
			else preamble.push(p);
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
	return sections.filter(
		(s) => s.paragraphs.length > 0 && !isBoilerplateSection(s),
	);
}

async function fetchCnsc(src: ManifestSource): Promise<Doc> {
	const pdUrl = cnscPageDataUrl(src.url);
	const json = (await fetchJson(pdUrl)) as {
		result?: { data?: { mdx?: { body?: string } } };
	};
	const body = json?.result?.data?.mdx?.body;
	if (!body || body.length < 500) {
		throw new Error(
			`CNSC page-data has no usable mdx.body (len=${body?.length ?? 0})`,
		);
	}
	const sections = cnscBodyToSections(body);
	if (sections.length === 0) throw new Error("CNSC parse produced 0 sections");
	return {
		regdoc_id: src.id,
		title: src.title,
		url: src.url,
		source_type: "best-practice-cnsc",
		scraped_at: new Date().toISOString(),
		sections,
	};
}

// ─── PDF (IAEA / NRC): download → unpdf text → heuristic sections ────────────
// unpdf's mergePages returns the WHOLE document as one newline-free blob, so we
// cannot rely on line breaks. We sentence-split the blob and (a) start a new
// section whenever a sentence BEGINS with a heading marker (numbered "2.1 …",
// lettered "C. REGULATORY POSITION", or an ALL-CAPS run), and (b) fall back to
// fixed-size blocks so a heading-less doc still yields multiple sections. Fine
// boundaries aren't critical: ingest.ts re-splits each section into ~400-token
// chunks by sentence, so this only needs coherent grouping + usable labels.
const SENTENCES_PER_PARA = 3;
const PARAS_PER_FALLBACK_SECTION = 6;

// Split a leading heading off the front of a sentence, if present → [heading, rest].
function leadingHeading(sentence: string): [string, string] | null {
	const s = sentence.trimStart();
	// lettered: "C. REGULATORY POSITION Body…"
	let m = s.match(/^([A-Z]\.\s+[A-Z][A-Z][A-Z /&-]{2,48}?)(?=\s+[A-Z][a-z])/);
	if (m) return [m[1].trim(), s.slice(m[0].length).trim()];
	// numbered: "2.1 Occupational Dose Body…" / "3. Purpose …"
	m = s.match(
		/^(\d+(?:\.\d+){0,3}\.?\s+[A-Z][A-Za-z][A-Za-z ,/&-]{2,55}?)(?=\s+[A-Z][a-z])/,
	);
	if (m) return [m[1].trim(), s.slice(m[0].length).trim()];
	// bare ALL-CAPS heading run followed by sentence-case body
	m = s.match(/^([A-Z][A-Z][A-Z /&-]{4,48}?)(?=\s+[A-Z][a-z])/);
	if (m) return [m[1].trim(), s.slice(m[0].length).trim()];
	return null;
}

function splitSentencesLoose(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function pdfTextToSections(text: string): Section[] {
	// Normalize; drop hard page-break artifacts and hyphenation at line ends.
	const cleaned = text
		.replace(/\r/g, "")
		.replace(/-\n(?=[a-z])/g, "") // de-hyphenate line-wrapped words
		.replace(/ /g, " ");
	const sentences = splitSentencesLoose(normalizeWs(cleaned));

	const sections: Section[] = [];
	let current: Section = {
		section_number: "",
		section_title: "Introduction",
		anchor: "",
		paragraphs: [],
	};
	let paraBuf: string[] = [];

	const flushPara = () => {
		const t = normalizeWs(paraBuf.join(" "));
		paraBuf = [];
		if (t.length >= 40)
			current.paragraphs.push({
				text: t,
				requirement_type: classifyRequirement(t),
			});
	};
	const openSection = (heading: string) => {
		flushPara();
		if (current.paragraphs.length > 0) sections.push(current);
		const { number, title } = splitHeading(heading);
		current = {
			section_number: number,
			section_title: title || heading,
			anchor: "",
			paragraphs: [],
		};
	};

	for (const sentence of sentences) {
		const hd = leadingHeading(sentence);
		if (hd) {
			openSection(hd[0]);
			if (hd[1]) paraBuf.push(hd[1]);
		} else {
			paraBuf.push(sentence);
		}
		if (paraBuf.length >= SENTENCES_PER_PARA) flushPara();
	}
	flushPara();
	if (current.paragraphs.length > 0) sections.push(current);

	// Fallback: heading detection found nothing → one giant section. Re-slice its
	// paragraphs into fixed-size blocks so chunks form and stay topically local.
	if (sections.length <= 1 && sections[0]) {
		const paras = sections[0].paragraphs;
		const out: Section[] = [];
		for (let i = 0; i < paras.length; i += PARAS_PER_FALLBACK_SECTION) {
			out.push({
				section_number: String(out.length + 1),
				section_title: `Part ${out.length + 1}`,
				anchor: "",
				paragraphs: paras.slice(i, i + PARAS_PER_FALLBACK_SECTION),
			});
		}
		return out.filter((s) => s.paragraphs.length > 0);
	}
	return sections.filter((s) => s.paragraphs.length > 0);
}

async function fetchPdf(src: ManifestSource): Promise<Doc> {
	const buf = await fetchBytes(src.url);
	const pdf = await getDocumentProxy(new Uint8Array(buf));
	const { text } = await extractText(pdf, { mergePages: true });
	const full = Array.isArray(text) ? text.join("\n") : text;
	if (!full || full.length < 800)
		throw new Error(`PDF text too short (len=${full?.length ?? 0})`);
	const sections = pdfTextToSections(full);
	if (sections.length === 0) throw new Error("PDF parse produced 0 sections");
	return {
		regdoc_id: src.id,
		title: src.title,
		url: src.url,
		source_type: "best-practice-pdf",
		scraped_at: new Date().toISOString(),
		sections,
	};
}

// ─── fetch helpers (timeout + retry/backoff + polite UA) ────────────────────
async function fetchWith<T>(
	url: string,
	parse: (r: Response) => Promise<T>,
): Promise<T> {
	let attempt = 0;
	let delay = 1000;
	const maxAttempts = 4;
	while (true) {
		attempt++;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
		try {
			const r = await fetch(url, {
				headers: { "user-agent": USER_AGENT, accept: "*/*" },
				signal: ctrl.signal,
				redirect: "follow",
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			// Defense-in-depth: reject an implausibly large body before buffering it
			// (regulatory HTML/PDFs are well under this; largest seen ~2 MB).
			const declaredLen = Number(r.headers.get("content-length") ?? "0");
			if (declaredLen > MAX_RESPONSE_BYTES) {
				throw new Error(
					`response too large: ${declaredLen} bytes (cap ${MAX_RESPONSE_BYTES})`,
				);
			}
			return await parse(r);
		} catch (err) {
			if (attempt >= maxAttempts) throw err;
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`  retry ${attempt}/${maxAttempts - 1} (${msg}) …`);
			await sleep(delay);
			delay = Math.min(delay * 2, 16000);
		} finally {
			clearTimeout(timer);
		}
	}
}
const fetchJson = (url: string) => fetchWith(url, (r) => r.json());
const fetchBytes = (url: string) => fetchWith(url, (r) => r.arrayBuffer());
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ─── doc quality gate ───────────────────────────────────────────────────────
function docStats(doc: Doc) {
	const paras = doc.sections.flatMap((s) => s.paragraphs);
	const chars = paras.reduce((n, p) => n + p.text.length, 0);
	const alpha = paras.reduce(
		(n, p) => n + (p.text.match(/[a-zA-Z]/g)?.length ?? 0),
		0,
	);
	const req = paras.filter((p) => p.requirement_type === "requirement").length;
	return {
		sections: doc.sections.length,
		paragraphs: paras.length,
		chars,
		alphaRatio: chars ? +(alpha / chars).toFixed(3) : 0,
		requirements: req,
	};
}
// Reject obviously-garbled extractions (e.g. a PDF that came out as symbol soup).
function passesQualityGate(doc: Doc): { ok: boolean; reason?: string } {
	const s = docStats(doc);
	if (s.sections < 2)
		return { ok: false, reason: `only ${s.sections} section(s)` };
	if (s.paragraphs < 5)
		return { ok: false, reason: `only ${s.paragraphs} paragraph(s)` };
	if (s.chars < 1500)
		return { ok: false, reason: `only ${s.chars} chars of text` };
	if (s.alphaRatio < 0.6)
		return { ok: false, reason: `alpha ratio ${s.alphaRatio} (garbled?)` };
	return { ok: true };
}

function fileNameFor(id: string): string {
	return `bp-${id
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")}.json`;
}

async function main() {
	const manifestFull = isAbsolute(MANIFEST_PATH)
		? MANIFEST_PATH
		: join(REPO_ROOT, MANIFEST_PATH);
	const manifestRaw = await readFile(manifestFull, "utf-8");
	const manifest = JSON.parse(manifestRaw) as { sources: ManifestSource[] };
	let sources = manifest.sources ?? [];

	if (ONLY) sources = sources.filter((s) => s.id === ONLY);
	if (PUBLISHER)
		sources = sources.filter((s) => (s.publisher ?? "").includes(PUBLISHER));
	if (SOURCE_FILTER)
		sources = sources.filter((s) => s.source === SOURCE_FILTER);
	// Reference-only rows (e.g. IAEA bibliography) are never fetched into the corpus.
	// biome-ignore lint/suspicious/noExplicitAny: manifest rows carry an optional ingest flag
	sources = sources.filter(
		(s) => (s as any).ingest !== false && s.source !== "iaea-reference",
	);
	// Never fetch RED; YELLOW only with --allow-yellow.
	const skippedRed = sources.filter((s) => s.verdict === "RED");
	const skippedYellow = ALLOW_YELLOW
		? []
		: sources.filter((s) => s.verdict === "YELLOW");
	sources = sources.filter(
		(s) => s.verdict === "GREEN" || (ALLOW_YELLOW && s.verdict === "YELLOW"),
	);

	console.log(
		`Manifest: ${MANIFEST_PATH} — fetching ${sources.length} source(s)` +
			`${skippedRed.length ? `, skipping ${skippedRed.length} RED` : ""}` +
			`${skippedYellow.length ? `, skipping ${skippedYellow.length} YELLOW (use --allow-yellow)` : ""}` +
			`${DRY ? " [DRY]" : ""}`,
	);

	if (!DRY) await mkdir(OUT_DIR, { recursive: true });
	const logLines: string[] = [];
	let ok = 0;
	let failed = 0;

	for (const src of sources) {
		const t0 = Date.now();
		try {
			const doc =
				src.source === "cnsc" ? await fetchCnsc(src) : await fetchPdf(src);
			const gate = passesQualityGate(doc);
			const s = docStats(doc);
			if (!gate.ok) {
				failed++;
				const line = `${src.id} | REJECTED | ${gate.reason} | ${JSON.stringify(s)}`;
				console.warn(`  ✗ ${line}`);
				logLines.push(`${new Date().toISOString()} | ${line}`);
				continue;
			}
			if (!DRY)
				await writeFile(
					join(OUT_DIR, fileNameFor(src.id)),
					JSON.stringify(doc, null, 2),
				);
			ok++;
			const ms = Date.now() - t0;
			const line = `${src.id} | OK | ${s.sections} sec, ${s.paragraphs} para, ${s.requirements} req, alpha=${s.alphaRatio} | ${ms}ms`;
			console.log(`  ✓ ${line}`);
			logLines.push(`${new Date().toISOString()} | ${line}`);
		} catch (err) {
			failed++;
			const msg = err instanceof Error ? err.message : String(err);
			const line = `${src.id} | FAILED | ${msg}`;
			console.error(`  ✗ ${line}`);
			logLines.push(`${new Date().toISOString()} | ${line}`);
		}
		await sleep(POLITE_DELAY_MS);
	}

	if (!DRY && logLines.length) {
		await writeFile(RUN_LOG, `${logLines.join("\n")}\n`, { flag: "a" });
	}
	console.log(
		`\nDone: ${ok} ok, ${failed} failed/rejected of ${sources.length}.`,
	);
	if (ok === 0 && sources.length > 0) process.exit(1);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
