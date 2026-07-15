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
// (offline, no external assets). The artifact ships FIXED NPX-brand dark by
// design (no prefers-color-scheme variants). Every visual here is
// self-contained: CSS gradients + a CSS blueprint grid, no external or data:
// assets, so it renders identically offline and inside the sandboxed iframe.

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

// Palette mirror of app/globals.css `.npx`, extended with elevation +
// gradient stops for the report layout. All hex is contained to this file.
const SHELL_CSS = `
:root {
  color-scheme: dark;
  --bg-0: #0e1128;
  --bg-1: #12152e;
  --surface: #1a1e40;
  --surface-2: #21264c;
  --surface-3: #262c58;
  --line: #2f3358;
  --line-2: #3d4270;
  --fg: #f5f6ff;
  --fg-muted: #a6abcf;
  --fg-dim: #7f85ad;
  --brand: #3b82f6;
  --brand-2: #60a5fa;
  --req: #60a5fa;
  --guid: #fbbf24;
  --warn: #f59e0b;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  color: var(--fg);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  line-height: 1.7;
  letter-spacing: 0.005em;
  -webkit-text-size-adjust: 100%;
  -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(1100px 560px at 50% -160px, rgba(59,130,246,0.20), transparent 62%),
    radial-gradient(900px 500px at 88% 8%, rgba(96,165,250,0.10), transparent 55%),
    linear-gradient(180deg, var(--bg-1) 0%, var(--bg-0) 60%);
  background-attachment: fixed;
}
/* Faint blueprint grid, faded toward the edges — a subtle technical texture,
   zero assets. Sits behind content; content carries its own stacking. */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(96,165,250,0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(96,165,250,0.05) 1px, transparent 1px);
  background-size: 46px 46px;
  -webkit-mask-image: radial-gradient(120% 90% at 50% 0%, #000 30%, transparent 78%);
  mask-image: radial-gradient(120% 90% at 50% 0%, #000 30%, transparent 78%);
}
.shell-inner { max-width: 56rem; margin: 0 auto; padding: 0 1.6rem; position: relative; z-index: 1; }

/* ---- Hero ---------------------------------------------------------------- */
.shell-header {
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(700px 300px at 12% -60%, rgba(59,130,246,0.28), transparent 60%),
    linear-gradient(135deg, #1b2050 0%, #141834 55%, #10132c 100%);
  border-bottom: 1px solid var(--line);
  padding: 3rem 0 2.4rem;
}
.shell-header::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(96,165,250,0.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(96,165,250,0.06) 1px, transparent 1px);
  background-size: 30px 30px;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 40%, #000 100%);
  mask-image: linear-gradient(90deg, transparent, #000 40%, #000 100%);
  opacity: 0.7;
}
.shell-eyebrow {
  margin: 0 0 0.85rem;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--brand-2);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
.shell-eyebrow::before {
  content: "";
  width: 1.4rem;
  height: 2px;
  background: var(--brand);
  border-radius: 2px;
}
.shell-question {
  margin: 0;
  color: #fff;
  font-size: clamp(1.4rem, 3.4vw, 2rem);
  font-weight: 700;
  line-height: 1.22;
  letter-spacing: -0.015em;
  text-wrap: balance;
  max-width: 44rem;
}
.shell-meta { margin: 1.25rem 0 0; display: flex; flex-wrap: wrap; gap: 0.5rem; }
.shell-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--fg-muted);
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 0.28rem 0.75rem;
}
.shell-chip-accent { color: var(--brand-2); border-color: rgba(96,165,250,0.4); background: rgba(96,165,250,0.1); }

/* ---- Body typography ----------------------------------------------------- */
main { display: block; padding: 2.4rem 0 3rem; }
h1 { font-size: clamp(1.7rem, 3.4vw, 2.15rem); line-height: 1.2; margin: 0 0 1rem; letter-spacing: -0.02em; text-wrap: balance; }
h2 {
  font-size: 1.4rem;
  line-height: 1.28;
  margin: 2.4rem 0 0.9rem;
  padding-bottom: 0.45rem;
  letter-spacing: -0.01em;
  border-bottom: 1px solid var(--line);
  position: relative;
}
h2::after { content: ""; position: absolute; left: 0; bottom: -1px; width: 3.5rem; height: 2px; background: linear-gradient(90deg, var(--brand), transparent); }
h3 { font-size: 1.14rem; margin: 1.6rem 0 0.5rem; letter-spacing: -0.005em; }
h4 { font-size: 1rem; margin: 1.25rem 0 0.5rem; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.82rem; }
p { margin: 0.8rem 0; }
ul, ol { margin: 0.8rem 0; padding-left: 1.4rem; }
li { margin: 0.4rem 0; }
li::marker { color: var(--brand-2); }
strong { font-weight: 680; color: #fff; }
a { color: var(--brand-2); }
code {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0.12rem 0.4rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.88em;
}
blockquote {
  margin: 1.25rem 0;
  padding: 0.5rem 0 0.5rem 1.15rem;
  border-left: 3px solid var(--line-2);
  color: var(--fg-muted);
  font-style: italic;
}

/* ---- Lead / summary ------------------------------------------------------ */
.art-summary {
  position: relative;
  background: linear-gradient(135deg, rgba(59,130,246,0.12), rgba(96,165,250,0.04));
  border: 1px solid rgba(96,165,250,0.28);
  border-radius: 16px;
  padding: 1.35rem 1.6rem 1.35rem 1.85rem;
  margin: 0 0 1.75rem;
  font-size: 1.08rem;
  line-height: 1.65;
  color: #eef1ff;
}
.art-summary::before {
  content: "";
  position: absolute;
  left: 0; top: 1.35rem; bottom: 1.35rem;
  width: 4px;
  border-radius: 4px;
  background: linear-gradient(180deg, var(--brand-2), var(--brand));
}
.art-summary > :first-child { margin-top: 0; }
.art-summary > :last-child { margin-bottom: 0; }

/* ---- Key facts strip ----------------------------------------------------- */
.art-keyfacts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.85rem;
  margin: 1.5rem 0 2rem;
}
.art-keyfact {
  background: linear-gradient(160deg, var(--surface-2), var(--surface));
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 1.1rem 1.15rem;
}
.art-keyfact-value {
  display: block;
  font-size: 1.7rem;
  font-weight: 750;
  line-height: 1.1;
  letter-spacing: -0.02em;
  color: var(--brand-2);
}
.art-keyfact-label { display: block; margin-top: 0.4rem; font-size: 0.82rem; line-height: 1.4; color: var(--fg-muted); }

.art-section { margin: 0 0 0.5rem; }

cite, .art-cite { font-style: normal; color: var(--brand-2); font-size: 0.82em; white-space: nowrap; opacity: 0.92; }

/* ---- Callouts ------------------------------------------------------------ */
.callout {
  border-left: 4px solid var(--line-2);
  border-radius: 12px;
  background: var(--surface);
  border-top: 1px solid var(--line);
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  padding: 1rem 1.2rem;
  margin: 1.15rem 0;
}
.callout > :first-child { margin-top: 0; }
.callout > :last-child { margin-bottom: 0; }
.callout-requirement { border-left-color: var(--req); background: linear-gradient(135deg, rgba(96,165,250,0.13), rgba(96,165,250,0.03)); }
.callout-guidance { border-left-color: var(--guid); background: linear-gradient(135deg, rgba(251,191,36,0.11), rgba(251,191,36,0.02)); }
.callout-note { border-left-color: var(--brand); background: linear-gradient(135deg, rgba(59,130,246,0.1), transparent); }
.callout-warning { border-left-color: var(--warn); background: linear-gradient(135deg, rgba(245,158,11,0.12), transparent); }

/* ---- Badges -------------------------------------------------------------- */
.badge {
  display: inline-block;
  border-radius: 999px;
  padding: 0.08rem 0.6rem;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  vertical-align: middle;
}
.badge-requirement { color: var(--req); border: 1px solid rgba(96,165,250,0.45); background: rgba(96,165,250,0.13); }
.badge-guidance { color: var(--guid); border: 1px solid rgba(251,191,36,0.45); background: rgba(251,191,36,0.1); }

/* ---- Tables -------------------------------------------------------------- */
.art-table { display: block; overflow-x: auto; border-collapse: collapse; margin: 1.5rem 0; width: 100%; border: 1px solid var(--line); border-radius: 12px; }
.art-table th, .art-table td { border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); padding: 0.7rem 0.9rem; text-align: left; vertical-align: top; }
.art-table th { background: var(--surface-2); font-weight: 680; color: #fff; letter-spacing: 0.01em; position: sticky; top: 0; }
.art-table tbody tr:nth-child(even) { background: rgba(255,255,255,0.018); }
.art-table tbody tr:last-child td { border-bottom: 0; }
.art-table tr > :last-child { border-right: 0; }

/* ---- Figures / diagrams -------------------------------------------------- */
.art-figure {
  margin: 1.75rem 0;
  padding: 1.6rem 1.6rem 1rem;
  background:
    radial-gradient(600px 200px at 50% 0%, rgba(59,130,246,0.08), transparent 70%),
    var(--surface);
  border: 1px solid var(--line);
  border-radius: 16px;
}
.art-figure figcaption { margin-top: 0.9rem; padding-top: 0.75rem; border-top: 1px dashed var(--line); color: var(--fg-muted); font-size: 0.85rem; line-height: 1.5; }
/* Responsive SVG: viewBox drives the aspect ratio. Generous default keeps
   diagram labels legible; the box padding above stops any edge clipping. */
svg { width: 100%; height: auto; display: block; overflow: visible; }
.svg-box { fill: var(--surface-2); stroke: var(--line-2); stroke-width: 1.5; }
.svg-box-req { fill: rgba(96,165,250,0.16); stroke: var(--req); stroke-width: 1.5; }
.svg-box-guid { fill: rgba(251,191,36,0.14); stroke: var(--guid); stroke-width: 1.5; }
.svg-arrow { stroke: var(--fg-muted); fill: var(--fg-muted); stroke-width: 1.5; }
.svg-text { fill: #fff; font-size: 15px; font-family: inherit; }
.svg-text-muted { fill: var(--fg-muted); font-size: 12.5px; font-family: inherit; }
.svg-accent { fill: var(--brand); stroke: var(--brand); }

/* ---- Footer -------------------------------------------------------------- */
.shell-footer { border-top: 1px solid var(--line); background: linear-gradient(180deg, transparent, rgba(26,30,64,0.6)); padding: 2rem 0 2.4rem; margin-top: 2rem; }
.shell-footer h2 { border-bottom: 0; margin: 0 0 0.75rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--fg-muted); }
.shell-footer h2::after { display: none; }
.shell-sources { margin: 0.25rem 0 1.25rem; padding-left: 1.3rem; font-size: 0.9rem; color: var(--fg-muted); }
.shell-sources li { margin: 0.4rem 0; }
.shell-sources a { color: var(--brand-2); text-decoration: underline; text-underline-offset: 2px; }
.shell-disclaimer, .shell-provenance { color: var(--fg-dim); font-size: 0.78rem; margin: 0.35rem 0; }

/* ---- Print --------------------------------------------------------------- */
@media print {
  body::before, .shell-header::after { display: none !important; }
  *, *::before, *::after { background: #fff !important; color: #000 !important; box-shadow: none !important; }
  body { font-size: 11pt; }
  a { color: #000 !important; text-decoration: underline !important; }
  .art-summary, .callout, .art-keyfact, .art-figure, .art-table { border: 1px solid #999 !important; }
  .svg-box, .svg-box-req, .svg-box-guid { fill: #fff !important; stroke: #000 !important; }
  .svg-arrow, .svg-text, .svg-text-muted, .svg-accent { fill: #000 !important; stroke: #000 !important; }
  h1, h2, h3 { page-break-after: avoid; }
  table, figure, blockquote, .art-keyfact { page-break-inside: avoid; }
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
	const distinctDocs = new Set(sources.map((s) => s.regdoc_id)).size;
	const sourceChip =
		distinctDocs > 0
			? `<span class="shell-chip">${distinctDocs} REGDOC${distinctDocs === 1 ? "" : "s"} · ${sources.length} excerpt${sources.length === 1 ? "" : "s"}</span>`
			: "";

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
    <p class="shell-eyebrow">NPXai · CNSC Knowledge Hub</p>
    <p class="shell-question">${escapeHtml(query)}</p>
    <div class="shell-meta">
      <span class="shell-chip">${dateText}</span>
      ${sourceChip}
      <span class="shell-chip shell-chip-accent">REGDOC explainer</span>
    </div>
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
