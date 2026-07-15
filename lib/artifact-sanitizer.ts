// Artifact fragment sanitizer (item-1 slice 1.1, spec §D). Hand-rolled
// allowlist pass over the LLM's HTML fragment — no new dependencies by
// design. The LLM output is treated as untrusted; everything that is not
// explicitly in the content contract is stripped and counted. The final
// deny-scan (scanOutput + artifact-specific patterns) is the abort gate:
// if the fragment still trips after sanitization, no artifact ships.
//
// Rendering context note: the document is only ever shown inside a
// sandboxed iframe with no allow-scripts (invariant I1.1) — this module is
// the second line of defense, not the only one.

import { scanOutput } from "./output-guard";
import { KNOWLEDGE_HUB_OUT_OF_SCOPE } from "./prompts";

// ---------------------------------------------------------------------------
// Contract tables

const HTML_ELEMENTS = new Set([
	"h1",
	"h2",
	"h3",
	"h4",
	"p",
	"ul",
	"ol",
	"li",
	"strong",
	"em",
	"code",
	"blockquote",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
	"section",
	"div",
	"span",
	"figure",
	"figcaption",
	"cite",
	"br",
]);

const SVG_ELEMENTS = new Set([
	"svg",
	"g",
	"rect",
	"circle",
	"ellipse",
	"line",
	"polyline",
	"polygon",
	"path",
	"text",
	"tspan",
	"marker",
	"defs",
	"title",
	"desc",
]);

// Elements whose CONTENT is dropped wholesale (spec step 2). Split by
// whether a close tag exists to skip to: void-ish ones drop the tag only.
const DROP_WITH_CONTENT = new Set([
	"script",
	"iframe",
	"object",
	"embed",
	"form",
	"style",
]);
const DROP_TAG_ONLY = new Set(["link", "meta", "base"]);

const VOID_ELEMENTS = new Set(["br"]);

// Published class list — the only classes the shell CSS defines
// (lib/artifact-template.ts). Unknown tokens are dropped and counted.
const ALLOWED_CLASSES = new Set([
	"art-title",
	"art-summary",
	"art-section",
	"art-keyfacts",
	"art-keyfact",
	"art-keyfact-value",
	"art-keyfact-label",
	"art-table",
	"art-figure",
	"art-cite",
	"callout",
	"callout-requirement",
	"callout-guidance",
	"callout-note",
	"callout-warning",
	"badge",
	"badge-requirement",
	"badge-guidance",
	"svg-box",
	"svg-box-req",
	"svg-box-guid",
	"svg-arrow",
	"svg-text",
	"svg-text-muted",
	"svg-accent",
]);

// SVG geometry/layout attributes (lowercased for matching; original casing
// is preserved on output so camelCase SVG attrs like viewBox survive).
const SVG_GEOMETRY_ATTRS = new Set([
	"x",
	"y",
	"x1",
	"y1",
	"x2",
	"y2",
	"cx",
	"cy",
	"r",
	"rx",
	"ry",
	"width",
	"height",
	"d",
	"points",
	"transform",
	"dx",
	"dy",
	"text-anchor",
	"dominant-baseline",
	"marker-start",
	"marker-mid",
	"marker-end",
]);

// Marker plumbing: arrowheads need <marker id="…"> + marker-end="url(#…)".
// Deviation from the strict attribute list, logged in the spec's execution
// notes: without id on <marker>, the marker/defs elements the contract
// allows would be inert. Values are pattern-validated below.
const MARKER_ONLY_ATTRS = new Set([
	"id",
	"refx",
	"refy",
	"markerwidth",
	"markerheight",
	"orient",
	"viewbox",
]);

const TABLE_CELL_ATTRS = new Set(["colspan", "rowspan", "scope"]);

const MARKER_ID_RE = /^[a-zA-Z][\w-]*$/;
const MARKER_REF_RE = /^url\(#[a-zA-Z][\w-]*\)$/;
// Generic safe-value shape for geometry attrs: numbers, path/transform
// letters, %, parens, signs. No quotes, colons (kills javascript:), or #.
const GEOMETRY_VALUE_RE = /^[\w\s.,%()+-]*$/;

// Hex color literal (3/4/6/8 hex digits). The `)` lookahead exemption keeps
// legitimate marker refs like url(#def) intact — presentation attributes
// carrying hex are already gone by the time this scan runs.
const HEX_COLOR_RE =
	/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z)])/g;

// Artifact-specific deny patterns layered on top of lib/output-guard.ts's
// scanOutput (spec step 5).
const EXTRA_DENY_PATTERNS: RegExp[] = [
	/<link/i,
	/<meta/i,
	/<base/i,
	/<form/i,
	/<object/i,
	/<embed/i,
	/srcdoc/i,
];

// Matches: comments, doctype/CDATA/processing instructions, and element tags
// (attribute section tolerates quoted `>` characters).
const TAG_RE =
	/<!--[\s\S]*?-->|<![^>]*>|<\?[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

const ATTR_RE =
	/([a-zA-Z][a-zA-Z0-9_:-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

// The security-boundary refusal sentence is a prefix of
// KNOWLEDGE_HUB_OUT_OF_SCOPE, so matching the prefix catches both.
const REFUSAL_SENTENCE =
	"This assistant only answers questions about the indexed CNSC regulatory documents";
const MIN_FRAGMENT_CHARS = 400;

// ---------------------------------------------------------------------------
// Public API

export interface SanitizeSuccess {
	ok: true;
	fragment: string;
	/** Count of contract violations removed (tags, attrs, classes, hex, …). */
	strips: number;
	/** Close tags appended/injected to repair balance (truncation, LLM slips). */
	repairs: number;
	/** Text of the first h1.art-title, for the document <title>. */
	title: string | null;
}

export interface SanitizeFailure {
	ok: false;
	reason: "output_guard" | "refusal";
	detail: string;
}

export type SanitizeResult = SanitizeSuccess | SanitizeFailure;

function escapeAttrValue(raw: string): string {
	return raw
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function unquote(raw: string): string {
	if (
		(raw.startsWith('"') && raw.endsWith('"')) ||
		(raw.startsWith("'") && raw.endsWith("'"))
	) {
		return raw.slice(1, -1);
	}
	return raw;
}

interface AttrPassResult {
	text: string;
	strips: number;
}

function sanitizeAttributes(tagName: string, rawAttrs: string): AttrPassResult {
	const isSvgEl = SVG_ELEMENTS.has(tagName);
	const parts: string[] = [];
	let strips = 0;
	// Trailing "/" of a self-closing tag is not an attribute.
	const source = rawAttrs.replace(/\/\s*$/, "");
	for (const m of source.matchAll(ATTR_RE)) {
		const name = m[1];
		const lower = name.toLowerCase();
		const value = m[2] === undefined ? "" : unquote(m[2]);

		let keep = false;
		if (lower === "class") {
			const tokens = value.split(/\s+/).filter(Boolean);
			const kept = tokens.filter((t) => ALLOWED_CLASSES.has(t));
			strips += tokens.length - kept.length;
			if (kept.length > 0) {
				parts.push(` class="${escapeAttrValue(kept.join(" "))}"`);
			}
			continue;
		} else if (lower === "data-ref") {
			keep = /^[\w\s.,§()-]*$/.test(value);
		} else if (tagName === "svg") {
			// Sizing via viewBox ONLY on the svg root — width/height stripped.
			keep =
				(lower === "viewbox" || lower === "preserveaspectratio") &&
				GEOMETRY_VALUE_RE.test(value);
		} else if (tagName === "marker" && MARKER_ONLY_ATTRS.has(lower)) {
			keep =
				lower === "id"
					? MARKER_ID_RE.test(value)
					: GEOMETRY_VALUE_RE.test(value) ||
						/^auto(-start-reverse)?$/.test(value);
		} else if (isSvgEl && SVG_GEOMETRY_ATTRS.has(lower)) {
			if (
				lower === "marker-start" ||
				lower === "marker-mid" ||
				lower === "marker-end"
			) {
				keep = MARKER_REF_RE.test(value);
			} else if (lower === "text-anchor") {
				keep = /^(start|middle|end)$/.test(value);
			} else if (lower === "dominant-baseline") {
				keep = /^[a-z-]+$/.test(value);
			} else {
				keep = GEOMETRY_VALUE_RE.test(value);
			}
		} else if (
			(tagName === "th" || tagName === "td") &&
			TABLE_CELL_ATTRS.has(lower)
		) {
			keep =
				lower === "scope"
					? /^(row|col|rowgroup|colgroup)$/.test(value)
					: /^\d{1,2}$/.test(value);
		}

		if (keep) {
			parts.push(` ${name}="${escapeAttrValue(value)}"`);
		} else {
			strips += 1;
		}
	}
	return { text: parts.join(""), strips };
}

/**
 * Sanitize the accumulated LLM output into a contract-clean HTML fragment.
 * Never throws; contract violations are stripped and counted, structural
 * imbalance is repaired, and only the deny-scan or refusal detection abort.
 */
export function sanitizeArtifactFragment(raw: string): SanitizeResult {
	// Step 1 — strip markdown fences (gpt-4o-mini habitually fences HTML).
	let input = raw.trim();
	input = input
		.replace(/^```[a-zA-Z]*[^\S\n]*\n?/, "")
		.replace(/\n?```\s*$/, "");
	input = input.trim();

	// Steps 2+3+6 — single walk: tag allowlist, attribute allowlist,
	// balance tracking + repair.
	const out: string[] = [];
	const stack: string[] = [];
	let strips = 0;
	let repairs = 0;
	let cursor = 0;

	const pushText = (text: string) => {
		if (text) out.push(text.replace(/</g, "&lt;"));
	};

	TAG_RE.lastIndex = 0;
	let m = TAG_RE.exec(input);
	while (m !== null) {
		pushText(input.slice(cursor, m.index));
		cursor = TAG_RE.lastIndex;

		const tagName = m[1]?.toLowerCase();
		if (!tagName) {
			// Comment / doctype / CDATA / processing instruction — forbidden.
			strips += 1;
		} else if (DROP_TAG_ONLY.has(tagName)) {
			strips += 1;
		} else if (DROP_WITH_CONTENT.has(tagName)) {
			strips += 1;
			if (!m[0].startsWith("</") && !m[0].endsWith("/>")) {
				// Drop everything through the matching close tag; if the LLM never
				// closed it, drop the remainder — the deny-scan double-checks below.
				const closeRe = new RegExp(`</${tagName}[^>]*>`, "gi");
				closeRe.lastIndex = cursor;
				const close = closeRe.exec(input);
				cursor = close ? close.index + close[0].length : input.length;
				TAG_RE.lastIndex = cursor;
			}
		} else if (!HTML_ELEMENTS.has(tagName) && !SVG_ELEMENTS.has(tagName)) {
			// Unknown element: tag-level removal, content flows through.
			strips += 1;
		} else if (m[0].startsWith("</")) {
			if (VOID_ELEMENTS.has(tagName)) {
				strips += 1; // </br> is junk
			} else if (stack[stack.length - 1] === tagName) {
				stack.pop();
				out.push(`</${tagName}>`);
			} else if (stack.includes(tagName)) {
				// Interleaved close (e.g. <strong><em></strong>): implicitly close
				// everything above the match, browser-style.
				while (stack.length > 0 && stack[stack.length - 1] !== tagName) {
					out.push(`</${stack.pop()}>`);
					repairs += 1;
				}
				stack.pop();
				out.push(`</${tagName}>`);
			} else {
				strips += 1; // stray close tag with no matching open
			}
		} else {
			const attrs = sanitizeAttributes(tagName, m[2] ?? "");
			strips += attrs.strips;
			// A "/>" self-close is only real syntax in SVG foreign content; HTML
			// parsers treat <div/> as an open tag, so we do too.
			const selfCloses =
				(SVG_ELEMENTS.has(tagName) && m[0].endsWith("/>")) ||
				VOID_ELEMENTS.has(tagName);
			if (selfCloses) {
				out.push(`<${tagName}${attrs.text} />`);
			} else {
				out.push(`<${tagName}${attrs.text}>`);
				stack.push(tagName);
			}
		}

		m = TAG_RE.exec(input);
	}
	pushText(input.slice(cursor));

	// Step 6 — deterministically close anything left open (finish_reason
	// "length" truncations and ordinary LLM slips).
	for (let i = stack.length - 1; i >= 0; i--) {
		out.push(`</${stack[i]}>`);
		repairs += 1;
	}

	let fragment = out.join("");

	// Step 4 — hex color literals are a contract violation anywhere.
	const hexHits = fragment.match(HEX_COLOR_RE);
	if (hexHits) {
		strips += hexHits.length;
		fragment = fragment.replace(HEX_COLOR_RE, "");
	}

	// Step 5 — final deny-scan. If this still trips after the allowlist
	// passes, something is deeply wrong: abort, ship nothing.
	const scan = scanOutput(fragment);
	if (!scan.safe) {
		return { ok: false, reason: "output_guard", detail: scan.reason ?? "deny" };
	}
	for (const pattern of EXTRA_DENY_PATTERNS) {
		if (pattern.test(fragment)) {
			return {
				ok: false,
				reason: "output_guard",
				detail: `artifact_deny_${pattern.source.replace(/[^a-z]/gi, "")}`,
			};
		}
	}

	// Step 7 — refusal detection: never assemble a branded refusal page.
	if (
		fragment.length < MIN_FRAGMENT_CHARS ||
		fragment.includes(REFUSAL_SENTENCE) ||
		fragment.includes(KNOWLEDGE_HUB_OUT_OF_SCOPE)
	) {
		return {
			ok: false,
			reason: "refusal",
			detail: "short_or_refusal_fragment",
		};
	}

	// Document <title> source: text of the LLM's h1.art-title.
	const titleMatch = fragment.match(
		/<h1[^>]*class="[^"]*\bart-title\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i,
	);
	const title = titleMatch
		? titleMatch[1]
				.replace(/<[^>]*>/g, "")
				.replace(/\s+/g, " ")
				.trim() || null
		: null;

	return { ok: true, fragment, strips, repairs, title };
}
