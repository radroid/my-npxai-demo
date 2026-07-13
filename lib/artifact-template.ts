// Artifact document shell (item-1 slice 1.1, spec §D). This module is the
// ONLY producer of the outer document (invariant I1.4): doctype, head, the
// single embedded style block, branded header, footer with server-injected
// source links, and both server-injected warning callouts. The LLM fragment
// slots into <main> after lib/artifact-sanitizer.ts has enforced the
// class/element contract.
//
// HEX CONTAINMENT (invariant I1.8): app/globals.css declares "zero hex
// values outside this file"; this template is the ONE sanctioned additional
// home for hex because the downloaded artifact must be fully self-contained
// (offline, no external assets). Every value below mirrors the `.npx` token
// block in app/globals.css (lines ~227–241) — the artifact ships FIXED
// NPX-brand dark by design (no prefers-color-scheme variants). Edit the two
// files together.

// Matches the `sources` payload the artifact SSE route emits and the
// SourceChunk interface in components/knowledge-hub/SourcesPanel.tsx —
// keep in lock-step.
export interface ArtifactSource {
	id: number;
	regdoc_id: string;
	section_number: string | null;
	section_title: string | null;
	url: string | null;
	similarity: number;
	requirement_type: "requirement" | "guidance" | null;
	snippet: string;
}

export interface ArtifactAssemblyInput {
	/** Sanitized LLM fragment (lib/artifact-sanitizer.ts output). */
	fragment: string;
	/** Text of the LLM's h1.art-title; falls back to the truncated query. */
	title: string | null;
	/** Sanitized user question (never raw input). */
	query: string;
	sources: ArtifactSource[];
	/** Server-injected warning when the raw-pool mean similarity
	 * (poolAvgSim, pre-MIN_CHUNK_SIM filter) < LOW_SIM_DISCLAIMER. */
	limitedCoverage: boolean;
	/** Completion hit the token cap — append the regenerate warning. */
	truncated: boolean;
	model: string;
	promptVersion: string;
	generatedAt: Date;
}

function escapeHtml(raw: string): string {
	return raw
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// Only DB-sourced CNSC anchors become links (invariant I1.11) — see
// supabase/migrations/20260418190000_fix_regdoc_chunks_url_anchors.sql.
const CNSC_URL_PREFIX = "https://www.cnsc-ccsn.gc.ca/";

// Palette mirror of app/globals.css `.npx` — see header comment.
const SHELL_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #151834;
  color: #ffffff;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  line-height: 1.65;
  -webkit-text-size-adjust: 100%;
}
.shell-inner { max-width: 52rem; margin: 0 auto; padding: 0 1.5rem; }
.shell-header { background: #1c1f3d; border-bottom: 1px solid #2f3358; padding: 1.75rem 0; }
.shell-wordmark {
  margin: 0 0 0.5rem;
  color: #3b82f6;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.shell-question { margin: 0; color: #ffffff; font-size: 1.05rem; font-weight: 600; }
.shell-date { margin: 0.35rem 0 0; color: #a1a1aa; font-size: 0.8rem; }
main { display: block; padding: 2rem 0 3rem; }
h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 1rem; }
h2 { font-size: 1.35rem; line-height: 1.3; margin: 2rem 0 0.75rem; padding-bottom: 0.35rem; border-bottom: 1px solid #2f3358; }
h3 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
h4 { font-size: 1rem; margin: 1.25rem 0 0.5rem; }
p { margin: 0.75rem 0; }
ul, ol { margin: 0.75rem 0; padding-left: 1.5rem; }
li { margin: 0.35rem 0; }
strong { font-weight: 650; }
code {
  background: #252848;
  border-radius: 6px;
  padding: 0.15rem 0.4rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
}
blockquote {
  margin: 1rem 0;
  padding: 0.25rem 0 0.25rem 1rem;
  border-left: 3px solid #3d4270;
  color: #a1a1aa;
}
.art-summary {
  background: #1c1f3d;
  border: 1px solid #2f3358;
  border-radius: 12px;
  padding: 1rem 1.25rem;
  margin: 0 0 1.5rem;
  font-size: 1.02rem;
}
.art-section { margin: 0 0 1.5rem; }
cite, .art-cite { font-style: normal; color: #60a5fa; font-size: 0.85em; white-space: nowrap; }
/* Callouts — colored left borders + tinted backgrounds, matching the app's
   SourceBadge semantics (requirement blue / guidance amber). */
.callout {
  border-left: 4px solid #3d4270;
  border-radius: 10px;
  background: #1c1f3d;
  padding: 0.85rem 1.1rem;
  margin: 1rem 0;
}
.callout > :first-child { margin-top: 0; }
.callout > :last-child { margin-bottom: 0; }
.callout-requirement { border-left-color: #60a5fa; background: rgba(96, 165, 250, 0.1); }
.callout-guidance { border-left-color: #fbbf24; background: rgba(251, 191, 36, 0.08); }
.callout-note { border-left-color: #3b82f6; background: rgba(59, 130, 246, 0.08); }
.callout-warning { border-left-color: #f59e0b; background: rgba(245, 158, 11, 0.1); }
.badge {
  display: inline-block;
  border-radius: 999px;
  padding: 0.05rem 0.55rem;
  font-size: 0.72rem;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  vertical-align: middle;
}
.badge-requirement { color: #60a5fa; border: 1px solid rgba(96, 165, 250, 0.45); background: rgba(96, 165, 250, 0.12); }
.badge-guidance { color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.45); background: rgba(251, 191, 36, 0.1); }
/* Zebra tables; display:block gives horizontal overflow scrolling on small
   screens without needing a wrapper element the LLM can't emit. */
.art-table { display: block; overflow-x: auto; border-collapse: collapse; margin: 1.25rem 0; }
.art-table th, .art-table td { border: 1px solid #2f3358; padding: 0.6rem 0.75rem; text-align: left; vertical-align: top; }
.art-table th { background: #252848; font-weight: 650; }
.art-table tbody tr:nth-child(even) { background: #1c1f3d; }
.art-figure {
  margin: 1.5rem 0;
  padding: 1rem 1rem 0.75rem;
  background: #1c1f3d;
  border: 1px solid #2f3358;
  border-radius: 12px;
}
.art-figure figcaption { margin-top: 0.5rem; color: #a1a1aa; font-size: 0.85rem; }
/* Responsive SVG: viewBox drives the aspect ratio. */
svg { width: 100%; height: auto; display: block; }
.svg-box { fill: #252848; stroke: #3d4270; stroke-width: 1.5; }
.svg-box-req { fill: rgba(96, 165, 250, 0.16); stroke: #60a5fa; stroke-width: 1.5; }
.svg-box-guid { fill: rgba(251, 191, 36, 0.14); stroke: #fbbf24; stroke-width: 1.5; }
.svg-arrow { stroke: #a1a1aa; fill: #a1a1aa; stroke-width: 1.5; }
.svg-text { fill: #ffffff; font-size: 16px; }
.svg-text-muted { fill: #a1a1aa; font-size: 13px; }
.svg-accent { fill: #3b82f6; stroke: #3b82f6; }
.shell-footer { border-top: 1px solid #2f3358; background: #1c1f3d; padding: 1.75rem 0 2rem; margin-top: 1rem; }
.shell-footer h2 { border-bottom: 0; margin-top: 0; font-size: 1.1rem; }
.shell-sources { margin: 0.5rem 0 1rem; padding-left: 1.4rem; font-size: 0.9rem; }
.shell-sources li { margin: 0.4rem 0; }
.shell-sources a { color: #60a5fa; text-decoration: underline; text-underline-offset: 2px; }
.shell-disclaimer, .shell-provenance { color: #a1a1aa; font-size: 0.78rem; margin: 0.35rem 0; }
/* Print: white/black output so dark backgrounds don't torch toner —
   mirrors the app's print stylesheet approach (app/globals.css). */
@media print {
  *, *::before, *::after {
    background: #fff !important;
    color: #000 !important;
    box-shadow: none !important;
  }
  body { font-size: 11pt; }
  a { color: #000 !important; text-decoration: underline !important; }
  .svg-box, .svg-box-req, .svg-box-guid { fill: #fff !important; stroke: #000 !important; }
  .svg-arrow, .svg-text, .svg-text-muted, .svg-accent { fill: #000 !important; stroke: #000 !important; }
  .svg-arrow { fill: #000 !important; }
  h1, h2, h3 { page-break-after: avoid; }
  table, figure, blockquote { page-break-inside: avoid; }
}
`.trim();

function renderSourceItem(source: ArtifactSource): string {
	const label =
		source.regdoc_id +
		(source.section_number ? ` §${source.section_number}` : "");
	const title = source.section_title
		? ` — ${escapeHtml(source.section_title)}`
		: "";
	const link =
		source.url?.startsWith(CNSC_URL_PREFIX) === true
			? ` <a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">cnsc-ccsn.gc.ca</a>`
			: "";
	return `<li>[${escapeHtml(label)}]${title}${link}</li>`;
}

const LIMITED_COVERAGE_CALLOUT =
	'<div class="callout callout-warning"><p><strong>Limited corpus coverage.</strong> The indexed CNSC documents matched this question only weakly — this explainer is built from the strongest available snippets and may be incomplete.</p></div>';

const TRUNCATION_CALLOUT =
	'<div class="callout callout-warning"><p><strong>Response truncated</strong> — regenerate for the full explainer.</p></div>';

/** Assemble the full, self-contained artifact document around a sanitized fragment. */
export function assembleArtifactDocument(input: ArtifactAssemblyInput): string {
	const {
		fragment,
		title,
		query,
		sources,
		limitedCoverage,
		truncated,
		model,
		promptVersion,
		generatedAt,
	} = input;

	const docTitle = escapeHtml(title ?? query.slice(0, 80));
	const dateText = generatedAt.toISOString().slice(0, 10);
	const sourceItems = sources.map(renderSourceItem).join("\n      ");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${docTitle}</title>
<style>
${SHELL_CSS}
</style>
</head>
<body>
<header class="shell-header">
  <div class="shell-inner">
    <p class="shell-wordmark">NPXai — CNSC Knowledge Hub</p>
    <p class="shell-question">${escapeHtml(query)}</p>
    <p class="shell-date">Generated on ${dateText}</p>
  </div>
</header>
<main class="shell-inner">
${limitedCoverage ? `${LIMITED_COVERAGE_CALLOUT}\n` : ""}${fragment}
${truncated ? `${TRUNCATION_CALLOUT}\n` : ""}</main>
<footer class="shell-footer">
  <div class="shell-inner">
    <h2>Sources</h2>
    <ol class="shell-sources">
      ${sourceItems}
    </ol>
    <p class="shell-disclaimer">Generated by the NPXai demo from indexed CNSC REGDOC excerpts. Simulated demo — not for operational use.</p>
    <p class="shell-provenance">Prompt ${escapeHtml(promptVersion)} · Model ${escapeHtml(model)}</p>
  </div>
</footer>
</body>
</html>
`;
}
