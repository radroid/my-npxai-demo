# Spec — item-1: Knowledge Hub Artifact mode

Planner spec, 2026-07-13. Dispatch DELTAs D1–D3 applied. All anchors verified read-only against branch `chore/orchestration-scaffolding`.

## Goal

Knowledge Hub users get a second search mode: a "Chat" ↔ "Artifact" toggle near the composer. Artifact mode takes one regulatory question and produces a high-quality, fully self-contained HTML explainer ("artifact") — summary-first structure, requirement-vs-guidance visual distinction, inline-SVG process diagrams, comparison tables, callouts, and citations back to REGDOC sections with real CNSC URLs — rendered in a sandboxed iframe with a Download-.html button. The document's look is carried by a deterministic NPX-brand shell our code injects; the LLM only fills content within a strict class/element contract. Chat behavior is completely unchanged when the toggle is on Chat.

## Slices

### Slice 1.1 — Artifact generation backend (route + shell + content contract)

**A. Extract the retrieval pipeline into `lib/retrieval.ts` (pure move).**
The chat route's retrieval machinery — `QUERY_DOC_RE` / `CONCEPT_DOC_HINTS` / `QUERY_SECTION_RE` / `SECTION_CONTEXT_NOUNS` / `CONCEPT_EXPANSIONS`, `extractMentionedDocs`, `extractMentionedSections`, `pickContextNoun`, `buildExpansions` (app/api/knowledge-hub/query/route.ts:58–181), the embed-inputs construction + primary/expansion RPC calls against `match_regdoc_chunks` (route.ts:353–417), merge/dedupe + doc-mention rerank + `selectDiverseEnvelope` (route.ts:419–484), and the calibrated constants `LOW_SIM_OOS` / `LOW_SIM_DISCLAIMER` / `MATCH_COUNT` / `ENVELOPE_CHUNKS` / `MIN_CHUNK_SIM` / `NAMED_DOC_BOOST` (route.ts:39–54) — moves to a new `lib/retrieval.ts` module. This MUST be an import-shuffle-only refactor: zero logic edits, zero constant changes; the chat route's diff is limited to imports and call sites, and every calibration comment travels with its constant. (Next.js route files cannot export non-handler symbols, which is why the move to `lib/` is required for reuse.) The module exposes one entry point that takes the sanitized query + supabase client + OpenAI client and returns the ranked pool, envelope selection, and the top/avg similarity numbers the caller needs for its OOS/disclaimer gates. One allowed signature: `retrieveChunks(query, deps, opts) => Promise<{ envelope: RetrievedChunk[]; topSim: number; avgSim: number; mentionedDocs: string[] }>` — `RetrievedChunk` already lives at lib/context-envelope.ts:5–14.

**B. New route `app/api/knowledge-hub/artifact/route.ts`.**
Wrapped in `withGuard({ route: "knowledge-hub/artifact" })` exactly like the chat route (app/api/knowledge-hub/query/route.ts:236) so tier resolution, rate limiting, circuit breaker, fail-open posture, and the single `logRequest` line (lib/guard.ts:126–292) all apply. Request body is JSON `{ query: string }` (not `UIMessage[]` — artifact mode is not thread-based); validate with a new zod schema in lib/validators.ts following the `generatorInputSchema` precedent (lib/validators.ts:138–142).

Input pipeline mirrors the chat route step-for-step (I1.2):
1. `stripHtmlTags(sanitizeQueryText(raw))` (route.ts:245; lib/validators.ts:71–115).
2. Empty check → 400; `HARD_INPUT_CEILING` (lib/validators.ts:27) then `ctx.inputCharCap` per-tier check → 400 with the same `{ error: "validation", message }` body shape and `logGuardEvent` reason `validation` (route.ts:257–283).
3. Jailbreak short-circuit: `decodeBase64Probe` + `detectJailbreakMarkers` on raw and decoded text (route.ts:290–313). On any marker: guard-log `jailbreak_markers:<n>`, set the same logFields, and return the refusal WITHOUT any OpenAI call. Since this route is not a UIMessage stream, the refusal is an SSE `error` event carrying `KNOWLEDGE_HUB_OUT_OF_SCOPE` (lib/prompts.ts:85) — see transport below.

Rate limits: add a `"knowledge-hub/artifact"` entry to `LIMITS` (lib/guard.ts:27–54). Per-artifact cost is ~4× a chat answer, so limits are strictly tighter than chat's: anon `{ minute: 1, hour: 2, day: 2 }` (matches generator anon posture, lib/guard.ts:40), signed_in `{ minute: 2, hour: 6, day: 10 }`, npx_circle `{ minute: 3, hour: 12, day: 30 }`. I1.2's "same tier rate limits" is satisfied by the same `withGuard` machinery with per-tier scoping; numbers may be tighter, never looser (see discovered invariant I1.9).

**Model + token cap (DELTA D1).** The artifact model id is read from env var `OPENAI_ARTIFACT_MODEL`, default `"gpt-4o-mini"`, resolved in lib/openai.ts alongside `OPENAI_MODELS` (lib/openai.ts:13–16) so both routes share one client (lib/openai.ts:5–11). Hard `max_tokens` cap: a route-level constant `ARTIFACT_MAX_TOKENS = 3000` at the call site (not tier-scoped — tiers differentiate via rate limits). Cost check for I1.5: 3000 output tokens of gpt-4o-mini ≈ 4× the anon chat answer cap of 800 (lib/validators.ts:11–15) — a small multiple. Document the env var in `.env.example` (optional, with default noted). Call `recordOpenAICall(0)` after both the embedding and completion calls (lib/guard.ts:295–307), matching route.ts:371 and route.ts:567.

**Retrieval + gates.** Call the extracted `lib/retrieval.ts` entry with an artifact-sized envelope of 12 chunks (explainers span more sections than chat answers; chat keeps its calibrated 8 via its own call site). Same thresholds: raw top-1 < 0.40 → return the out-of-scope refusal as an SSE `error` event with NO LLM call (mirrors route.ts:497–507, `fallback_taken: true`, `output_tokens: 0`); raw-pool mean similarity (`poolAvgSim`, computed over the full ranked candidate pool BEFORE the `MIN_CHUNK_SIM` filter — fix round 1) < 0.35 → generation proceeds but the server injects a "limited corpus coverage" warning callout at the top of the assembled document (server-injected, not LLM-prompted — analog of route.ts:543–547). Build the LLM user message with `buildContextEnvelope` (lib/context-envelope.ts:40–60) unchanged, including the multi-doc cue.

**C. Content contract — new system prompt `KNOWLEDGE_HUB_ARTIFACT_SYSTEM` in lib/prompts.ts, and bump `PROMPT_VERSION`** (lib/prompts.ts:5 — the file header says any change bumps it). The prompt carries over the chat prompt's security boundary, untrusted-data spotlighting, citation grammar, exact-phrasing rules, and requirement-vs-guidance language rules (lib/prompts.ts:7–80, esp. rules 2, 2a, 3), then demands this output contract — the spec's reliability core, enforced by the server, not hoped for:

- Output is an HTML FRAGMENT only: no doctype, `html`, `head`, `body`, `style`, `script`, `link`, `meta`, comments, or markdown fences. First element is an `h1` with class `art-title` naming the topic.
- Required skeleton, in order: (1) a summary section with class `art-summary` — 3–5 plain-language sentences answering the question FIRST (answer-first ordering is a hard-won convention in this repo — see commit 2a127d5); (2) two to five body sections, each `section` class `art-section` opening with an `h2`; (3) a requirements-vs-guidance section using callouts (below) whenever the envelope contains both `requirement` and `guidance` snippets (the envelope exposes `requirement_type` per chunk, lib/context-envelope.ts:35).
- Visual vocabulary the LLM MUST draw on where the content warrants: `div` callouts with classes `callout callout-requirement` / `callout-guidance` / `callout-note` / `callout-warning`; `span` badges `badge badge-requirement` / `badge-guidance`; comparison `table` with class `art-table` whenever two or more documents, options, or regimes are contrasted; at least ONE inline SVG diagram per artifact (process/flow, hierarchy, or relationship) inside `figure` class `art-figure` with a `figcaption` explaining it.
- SVG sub-contract (I1.4 + I1.6): elements limited to `svg g rect circle ellipse line polyline polygon path text tspan marker defs title desc`; sizing via `viewBox` only; ALL color comes from shell-defined classes (`svg-box`, `svg-box-req`, `svg-box-guid`, `svg-arrow`, `svg-text`, `svg-text-muted`, `svg-accent`) — the LLM must never write `fill`/`stroke`/`style` attributes or any hex value.
- Citations: inline plain-text `[REGDOC-X.X.X §Y.Z]` / `[NSCA §Y]` per the chat grammar (lib/prompts.ts:33–41), optionally wrapped in `cite` class `art-cite`. The LLM must NOT emit `a` elements or any `href`/URL anywhere — every link in the artifact is server-injected from retrieved chunk metadata (kills invented-URL risk outright).
- No attributes other than `class` (from the published class list), SVG geometry attributes, `viewBox`, `colspan`/`rowspan`/`scope`, and `data-ref`.

**D. Deterministic shell + sanitizer — new modules `lib/artifact-template.ts` and `lib/artifact-sanitizer.ts`** (executor may merge into one file).

Sanitizer (runs on the accumulated LLM output BEFORE assembly):
1. Strip a leading/trailing markdown code fence if present (gpt-4o-mini habitually fences HTML).
2. Tag allowlist pass: the fragment may contain only `h1 h2 h3 h4 p ul ol li strong em code blockquote table thead tbody tr th td section div span figure figcaption cite br` plus the SVG element list above. Any other element is stripped (tag-level removal); `script`/`iframe`/`object`/`embed`/`form`/`link`/`meta`/`base`/`style` content is dropped wholesale.
3. Attribute allowlist pass: strip `style`, all `on*`, `href`, `src`, `srcdoc`, and any attribute not in the contract list.
4. Color scan: any hex color pattern in the fragment (three-to-eight hex digits after `#`) is a contract violation → strip the attribute/occurrence, count it.
5. Final deny-scan: run `scanOutput` (lib/output-guard.ts:20–31) extended with `<link`, `<meta`, `<base`, `<form`, `<object`, `<embed`, `srcdoc` over the sanitized fragment. If it STILL trips, abort: guard-log reason `output_guard` (lib/logger.ts:77–96), emit SSE `error`, no artifact. Log the strip count in `ctx.logFields`.
6. Truncation repair: if the completion finished with `finish_reason === "length"`, deterministically close any open tags (a simple tag-stack balance pass) and have the assembler append a visible "response truncated — regenerate for the full explainer" warning callout. Also repair unbalanced tags on normal finishes (LLM slips happen); if balance cannot be repaired, abort as in step 5.
7. Refusal detection: if the sanitized fragment is shorter than ~400 characters or contains the `KNOWLEDGE_HUB_OUT_OF_SCOPE` sentence, return the out-of-scope SSE `error` instead of assembling a themed refusal page.

Template/assembler (the ONLY producer of the outer document, I1.4):
- Emits the full document: doctype, `html lang="en"`, `head` with charset + viewport + `title` (text of the LLM's `art-title`, fallback: truncated query), one embedded `style` block, `body` with: a branded header band (product wordmark text "NPXai — CNSC Knowledge Hub", the user's question, generated-on date), optional limited-coverage callout, `main` containing the sanitized fragment, and a footer with (a) a numbered Sources list built server-side from the retrieval chunks — regdoc id, §section, section title, and an `a` link to the chunk's `url` (these are DB-sourced `https://www.cnsc-ccsn.gc.ca/…` anchors, see supabase/migrations/20260418190000_fix_regdoc_chunks_url_anchors.sql) with `target="_blank" rel="noopener noreferrer"`; (b) the disclaimer "Generated by the NPXai demo from indexed CNSC REGDOC excerpts. Simulated demo — not for operational use." (wording precedent: components/app/AppShell.tsx:249); (c) a small provenance line with prompt version + model id.
- **Theme decision (dispatch asked for a call): the artifact ships FIXED NPX-brand dark.** Palette values are copied from the `.npx` token block (app/globals.css:227–241): `#151834` canvas, `#1c1f3d`/`#252848` surfaces, `#ffffff`/`#a1a1aa` text, `#3b82f6` accent, `#60a5fa` requirement, `#fbbf24` guidance, `#f87171` danger. Rationale: "aligned with NPX's theme" is literally the npxai.com dark-indigo identity; a fixed palette makes the downloaded file identical everywhere (no `prefers-color-scheme` divergence between the in-app preview, a colleague's OS, and offline viewing) and is the maximally deterministic reading of I1.4. Not `prefers-color-scheme`-aware. The in-app preview stays coherent by treating the iframe as a framed document surface (like a PDF preview): viewer chrome uses canonical app tokens in both themes; the dark branded page inside reads as the artifact's own identity. A `@media print` override forces white background/black text/underlined links, mirroring the app's print stylesheet approach (app/globals.css:346–395).
- Shell CSS defines every contract class (`art-*`, `callout*`, `badge*`, `svg-*`): max-width ~52rem centered column, system font stack (no external fonts — offline, I1.4), generous line-height, callouts with colored left borders + tinted backgrounds (requirement blue / guidance amber, matching the app's SourceBadge semantics, components/knowledge-hub/SourcesPanel.tsx:91–105), zebra tables wrapped for horizontal overflow on small screens, responsive SVG (`width: 100%`, height auto via viewBox).
- Hex containment: globals.css declares "zero hex values outside this file" (app/globals.css:11) — the artifact template is the ONE sanctioned additional home for hex, because the document must be self-contained. A comment in the template must say the values mirror `.npx` in app/globals.css and both must be edited together. App-side UI still uses canonical token utilities only (I1.3).

**E. Transport + caching + logging.**
- SSE response, following the generator precedent (`sseFrame`, app/api/generator/turnover/route.ts:18–30; stream shape route.ts:112–241): events `meta` (model, chunk count, cached flag), `progress` (periodic `{ tokens: n }` roughly every 250 accumulated completion tokens — keeps bytes flowing so proxies don't idle-out a 30–60s generation, and feeds the progress UI), `artifact` (final payload), `done`, `error`. Raw LLM deltas are NEVER sent to the client — only counts; the fragment is sanitized server-side before anything renders.
- The `artifact` event payload: the assembled `html` string, `sources` in the exact `SourceChunk` shape the chat route emits (route.ts:577–586; interface components/knowledge-hub/SourcesPanel.tsx:9–18), and flags `{ truncated, limitedCoverage, cached }`.
- Redis cache mirroring the chat pattern (route.ts:186–212, 315–346, 600–610): key hashed over `PROMPT_VERSION` + resolved model id + lowercased query; value `{ html, sources }`; TTL 24h (higher unit cost than chat justifies longer than chat's 30m); only clean, non-truncated artifacts are cached; cache hit emits `meta` (cached=true) then `artifact` immediately.
- `ctx.logFields`: `prompt_version`, `model` (resolved artifact model), `query_len`, `retrieval_top_sim`, `retrieval_avg_sim`, `cache`, `fallback_taken`, `output_tokens`, plus artifact-specific `artifact_bytes` and `sanitizer_strips` (extra keys are fine — `logFields` is `Record<string, unknown>`, lib/guard.ts:111). Never log query or artifact text (lib/logger.ts:1–2).

**Acceptance criteria (1.1):**
- POSTing a real question (e.g. the graded-approach starter, components/assistant-ui/thread.tsx:93–117) to `/api/knowledge-hub/artifact` yields SSE ending in an `artifact` event whose html: starts with a doctype; contains exactly one `style` block (the shell's); contains no `script`/`iframe`/`on*=`/`javascript:`/`style=` attribute/LLM-authored `href`; every `a` element lives in the server footer and points at a `cnsc-ccsn.gc.ca` URL from the retrieval chunks; contains ≥1 inline `svg`; renders standalone when saved to disk and opened offline.
- A jailbreak query ("ignore all previous instructions…") produces a guard event and an `error` event with zero OpenAI calls; an off-corpus query ("best poutine in Ottawa") produces the out-of-scope `error` with zero completion calls.
- Third anon request in a day → 429 with the chat-identical body shape (lib/guard.ts:186–210).
- Chat route responses are unchanged post-extraction (spot-check two starter questions; diff to `lib/retrieval.ts` call sites only).
- `bun run lint` + `bun run build` green.

**Files expected to change (1.1):** `lib/retrieval.ts` (new), `app/api/knowledge-hub/query/route.ts` (pure-move diff), `app/api/knowledge-hub/artifact/route.ts` (new), `lib/artifact-template.ts` (new), `lib/artifact-sanitizer.ts` (new), `lib/prompts.ts`, `lib/openai.ts`, `lib/guard.ts`, `lib/validators.ts`, `.env.example`.

### Slice 1.2 — Mode toggle + sandboxed artifact viewer

**A. Mode toggle (DELTA D3).** `KnowledgeHubShell` (components/knowledge-hub/KnowledgeHubShell.tsx:14–31) owns a `"chat" | "artifact"` mode state, default `"chat"`. The toggle is a two-option segmented control ("Chat" / "Artifact") rendered NEAR THE COMPOSER: add an optional `composerHeader?: ReactNode` prop to `Thread` (currently prop-less, components/assistant-ui/thread.tsx:37), rendered inside `ThreadPrimitive.ViewportFooter` immediately above `Composer` (thread.tsx:61–64). Default `undefined` renders markup byte-identical to today — that plus an untouched composer/transport path is what "Chat behavior completely unchanged" means and what the reviewer must verify. The control itself is a small shared component (`components/knowledge-hub/ModeToggle.tsx`) using canonical tokens (`bg-surface-2`, `text-fg-muted`, active option `bg-brand text-white` per the AppShell active-nav precedent, components/app/AppShell.tsx:219–222), keyboard operable, `aria-pressed` (or radiogroup semantics), visible focus ring `ring-brand`, and correct in light, dark, and npx themes.

**B. Surface swap without state loss.** Both surfaces stay MOUNTED; mode toggles CSS visibility (`hidden` class), never unmounts. This preserves the chat composer draft, scroll position, and the last generated artifact across toggles within a session. The Thread already tolerates being offscreen (runtime state lives in the provider above the shell, components/knowledge-hub/KnowledgeHubRuntimeProvider.tsx:109–121). The header strip hint text (KnowledgeHubShell.tsx:20–24) updates per mode ("Ask a regulatory question…" vs "Generate a self-contained HTML explainer…").

**C. ArtifactWorkbench (new, `components/knowledge-hub/ArtifactWorkbench.tsx`).** Contains, top to bottom: the shared ModeToggle (same position as chat's, above the input), then:
- Empty state: one-line explanation of what an artifact is + four starter TOPIC buttons tuned for explainer strength (deeper than the chat starters): "Explain the graded approach and how it applies across REGDOCs", "Defence in depth in reactor design (REGDOC-2.5.2) — levels and barriers", "Requirements vs guidance for radiation protection programs (REGDOC-2.7.1)", "How waste acceptance criteria work under REGDOC-2.11.1". Clicking fills the input and submits.
- Input: single textarea + Generate button, composer-styled (rounded, `border`, focus ring — visual kinship with thread.tsx:161–180). Disabled while a run is in flight; Escape or a Stop button aborts via AbortController (pattern: components/generator/use-generate-stream.ts:40–48).
- Streaming state machine in a new hook `hooks/use-artifact-stream.ts` (or co-located), parsing the SSE frames exactly like `useGenerateStream` (components/generator/use-generate-stream.ts:85–138): statuses idle → retrieving → drafting (show live token count from `progress` events, reuse the thinking-pill visual language of thread.tsx:238–275) → ready | error.
- Viewer: an `iframe` with `srcDoc` set to the artifact html, `title` describing the artifact, and EXACTLY `sandbox="allow-popups allow-popups-to-escape-sandbox"` — no `allow-scripts`, no `allow-same-origin` (I1.1; popups are needed only so the footer's `target="_blank"` CNSC citation links can open; with no allow-scripts nothing executes inside). Never `dangerouslySetInnerHTML`. Chrome around it: `border-border`, `rounded-xl`, `bg-surface`, fills available height (min ~60dvh on mobile), with a slim caption bar naming the query + generated time.
- Actions row: **Download .html** — build a Blob from the html string and trigger a download with a slugified filename (`npx-artifact-<topic-slug>-<yyyymmdd>.html`; strip path-hostile characters). Do NOT offer "open in new tab": a `blob:` URL created by the app inherits the app's origin, which would evade the sandbox (discovered invariant I1.7). A "cached" pill shows when the meta flag says so; truncated artifacts show the warning callout that's already baked into the html.
- Sources: render the returned chunks with the existing `SourcesPanel` (components/knowledge-hub/SourcesPanel.tsx:24 — it takes `{ data: { chunks } }` and is runtime-independent).
- Error states, each styled with tokens and offering Retry: validation 400 (server message verbatim), 429 rate-limit (server message — anon copy already upsells sign-in, lib/guard.ts:189–192), out-of-scope/jailbreak `error` event (canonical sentence), stream/network failure.

**Persistence: none in this slice (DELTA D2 applied).** Artifact history requires a new table + RPC family + a sidebar rail (the `generated_reports` pattern: supabase/migrations/20260417073838_generated_reports.sql:9–178 server-side plus the localStorage ring buffer lib/report-store.ts:30–75 for anon) — meaningful new surface, so it is Out of scope (below). Session state + Download covers the demo need.

**Acceptance criteria (1.2):**
- Toggle on Chat: thread renders and behaves exactly as before (send, regenerate, citations, sources, thread list, auto-title all untouched); the only chat-surface diff is the additive `composerHeader` slot.
- Toggle to Artifact: generate a starter topic → progress states → artifact renders in the sandboxed iframe; iframe attributes match the spec string exactly; Download yields a file that opens offline with identical rendering.
- Toggle back and forth mid-session: chat draft text and the generated artifact both survive.
- All workbench chrome verified in light AND dark (and not broken in npx theme); mobile (≤390px) shows usable input, readable artifact (its internal CSS is responsive), reachable Download.
- Anon rate-limit exhaustion shows the styled 429 message with sign-in upsell.
- `bun run lint` + `bun run build` green.

**Files expected to change (1.2):** `components/knowledge-hub/ArtifactWorkbench.tsx` (new), `components/knowledge-hub/ModeToggle.tsx` (new), `hooks/use-artifact-stream.ts` (new), `components/knowledge-hub/KnowledgeHubShell.tsx`, `components/assistant-ui/thread.tsx` (additive prop only).

## Edge cases

- **Empty / whitespace-only query:** Generate button disabled client-side; server independently returns 400 `empty_query` (mirrors app/api/knowledge-hub/query/route.ts:274).
- **Over-cap query:** server 400 with per-tier message (route.ts:277–283); UI shows it verbatim; textarea `maxLength` set to the largest tier cap (2500, lib/validators.ts:5–9) as a soft client bound.
- **Hostile input (jailbreak, base64-smuggled, leetspeak, French):** deterministic guard catches pre-LLM (lib/validators.ts:29–66); UI shows the canonical out-of-scope sentence; zero cost.
- **Off-corpus question:** top-sim gate returns out-of-scope with no completion call; UI communicates it's a corpus-scope limit, offers the starter topics.
- **Weak retrieval (raw-pool mean `poolAvgSim` < 0.35, e.g. one 0.42 chunk atop many weak ones):** artifact still generates, with the server-injected limited-coverage warning callout visible at top.
- **LLM returns fenced output:** sanitizer strips fences before validation.
- **LLM emits forbidden markup / hex / hrefs:** stripped and counted; if the final deny-scan still trips → `error` event + `output_guard` log; a paid call is lost but nothing unsafe ships.
- **`finish_reason: length` truncation:** tag-balance repair + visible truncation callout; NOT cached.
- **LLM refuses inside artifact mode:** refusal detection (short output / canonical sentence) → out-of-scope error, never a branded refusal page.
- **OpenAI error mid-stream:** SSE `error` event, UI error state with Retry (generator precedent, app/api/generator/turnover/route.ts:226–229).
- **Redis unavailable:** rate limits fail open with guard-log, request proceeds (lib/guard.ts:163–222); cache read/write failures are caught and non-fatal (route.ts:322–324 pattern).
- **Global circuit breaker tripped:** 429 demo-cap message (lib/guard.ts:236–255); UI renders it.
- **Rapid double-submit:** input disabled while running + AbortController cancels any in-flight run before starting a new one.
- **Toggle spam during generation:** switching to Chat does NOT abort the artifact run (surfaces stay mounted); the run completes hidden and is there on toggle-back.
- **Race: user signs out mid-session:** next request resolves tier server-side per-request (lib/guard.ts:134–149); a stale-cookie 429 surfaces the existing session-expired banner path only for chat; the workbench just shows the 429 message.
- **Both app themes + npx theme:** all workbench chrome uses canonical utilities; the iframe document is intentionally theme-fixed (NPX dark) in all three — verified as a deliberate design, not a bug.
- **Mobile:** artifact CSS is self-responsive (fluid column, overflow-x tables, viewBox SVG); viewer iframe gets adequate height; toggle + actions remain tappable at 390px.
- **Download on iOS Safari:** anchor-download of a Blob is the standard path; filename may be ignored by the browser — acceptable, note in manual verification.
- **Printing the artifact:** embedded `@media print` gives white/black output (dark backgrounds don't torch toner).
- **Anon localStorage privacy modes:** irrelevant — no artifact persistence in this item.

## Invariants

Verbatim from docs/orchestration/backlog.md (§item-1):

- I1.1 Generated artifact HTML renders ONLY inside a sandboxed iframe; NEVER `allow-same-origin` together with `allow-scripts`; never injected into the app DOM via `dangerouslySetInnerHTML`.
- I1.2 The artifact route passes the SAME deterministic prompt-injection guard, input validation, and tier rate limits as the chat route.
- I1.3 App UI (toggle, viewer chrome, states) uses canonical Tailwind token utilities per CLAUDE.md and works in BOTH light and dark themes.
- I1.4 The artifact document's brand shell (palette/typography/layout CSS) is injected deterministically by our code; the LLM fills content within provided classes/tokens — no LLM-invented hex, no external asset fetches; the artifact is fully self-contained (renders offline).
- I1.5 Output bounded: hard `max_tokens` cap at the call site; per-artifact cost within a small multiple of one chat answer; no new paid dependencies.
- I1.6 Diagrams/visuals are inline SVG (or CSS), self-contained in the file.

Discovered during planning (append):

- I1.7 Artifact HTML never becomes a `blob:`/object URL handed to `window.open` or an `href` target — blob URLs inherit the app origin and would bypass the iframe sandbox. Download-to-file only.
- I1.8 Artifact hex color literals live ONLY in the shell template module (mirroring the `.npx` block, app/globals.css:227–241, with a cross-reference comment); all app-side UI stays on canonical token utilities (globals.css hex-containment rule, app/globals.css:11).
- I1.9 Artifact per-tier rate limits are equal to or stricter than the chat route's for every tier and window; the completion call always carries the explicit `ARTIFACT_MAX_TOKENS` constant.
- I1.10 The retrieval extraction into `lib/retrieval.ts` is behavior-preserving for the chat route: no logic, constant, or threshold changes; calibration comments move intact.
- I1.11 Every URL in the artifact document is server-injected from retrieved chunk metadata (DB-sourced CNSC anchors); LLM-authored `href`/`src` attributes are always stripped.
- I1.12 Raw LLM deltas never leave the server in artifact mode; the client receives only progress counts and the final sanitized, assembled document.

## Open choices

- **Retrieval reuse: extract to `lib/retrieval.ts` (spec'd) vs duplicating a leaner retrieval inside the artifact route.** Lean strongly to extraction: duplication would fork six calibrated constants and the reranker, and the extraction is mechanically verifiable as a pure move (I1.10). Flip via DELTA only if the orchestrator wants zero chat-route diff in this item; the fallback then is a simplified single-embed retrieval (query-only embed, one RPC, top-12 ≥ 0.35) accepting weaker doc-mention handling.
- **Rate-limit numbers** (anon 1/2/2, signed_in 2/6/10, npx_circle 3/12/30) are planner-chosen within the tighter-than-chat rule; orchestrator may re-tune via DELTA without structural impact.

## Out of scope

- **Artifact persistence** (Supabase table + RPCs for signed-in, localStorage ring for anon, sidebar history rail). Needs a new migration + RPC family + rail UI — meaningful new surface per DELTA D2. If picked up later, copy the `generated_reports` pattern wholesale (supabase/migrations/20260417073838_generated_reports.sql, lib/report-store.ts, components/generator/RecentReports.tsx).
- Artifact generation from chat threads (turn a chat answer into an artifact), multi-turn artifact refinement, or artifact-aware thread titles.
- Streaming partial artifact rendering in the iframe; any `allow-scripts` interactivity inside the document.
- Public/shareable artifact URLs or server-side artifact hosting.
- Theme-switchable artifact documents (`prefers-color-scheme` variants) — the document is fixed NPX-dark by design this item.
- New runtime dependencies (sanitizer is hand-rolled allowlist logic; no `dompurify`/`sanitize-html`).
- Any change to chat behavior, prompts, thresholds, or limits beyond the pure-move extraction and the additive `composerHeader` prop.
- Deployment (`wrangler deploy`) and production env-var setup — Raj's call post-merge (set `OPENAI_ARTIFACT_MODEL` via `wrangler` CLI if overriding the default).

## Execution notes (PR #6)

Executor, 2026-07-13. Slice 1.1 only; branch `feat/artifact-backend`.

**What was built** — everything in spec §Slice 1.1, in two commits:

1. Pure-move extraction (`lib/retrieval.ts` + chat-route call-site diff). Mechanically verified: normalized line-level containment diff shows every moved line lands verbatim in `lib/retrieval.ts`; the only route-side residue is the 500-response glue (identical bodies/status, now keyed off a typed `RetrievalError{stage}`). Entry point matches the spec signature: `retrieveChunks(query, { supabase, openai }, { envelopeChunks }) => { envelope, topSim, avgSim, mentionedDocs }`. Note for reviewers: in the OOS case (`topSim < LOW_SIM_OOS`) `envelope` is the full ranked pool, not a k-trimmed envelope — that mirrors the pre-extraction `chunks` binding exactly (the old code also computed `avgSim` over the full pool in that branch, and the logged `retrieval_avg_sim` must stay identical).
2. Artifact backend: route, prompt (+`PROMPT_VERSION` → 2026-07-13.1 — chat's Redis answer cache keys include the version, so existing chat cache entries self-invalidate on deploy; behavior otherwise unchanged), sanitizer, template, guard `LIMITS` entry (same commit as the route — closed union), zod schema, `getArtifactModel()` in lib/openai.ts, `.env.example` entry.

**Deviations taken (small-call autonomy):**
- `id` on `<marker>` only + `marker-start/mid/end` `url(#…)` refs allowed (values pattern-validated: `^[a-zA-Z][\w-]*$` / `^url\(#…\)$`). The spec's attribute list omits them but its element list includes `marker`/`defs`, which are inert without them. Prompt instructs the LLM accordingly.
- Hex scan uses a `)` lookahead exemption so `url(#def)`-style marker refs with hex-looking ids survive; presentation attrs are stripped before the scan runs, so this loses nothing.
- Refusal detection matches the security-boundary sentence prefix ("This assistant only answers questions about the indexed CNSC regulatory documents") in addition to the full `KNOWLEDGE_HUB_OUT_OF_SCOPE` constant and the <400-char floor.
- `.art-table` gets `display:block; overflow-x:auto` — the contract gives the LLM no wrapper element, so the table itself is the scroll container.
- Tag-balance repair never aborts: stray closes are dropped, interleaved closes are resolved browser-style, unclosed tags are closed at the end. The only abort gates are the extended deny-scan (`output_guard`) and refusal detection — strictly safer than the spec's "abort if unrepairable" since repair is total.
- `text-anchor`/`dominant-baseline` (enum-validated) admitted as SVG layout attrs so diagram labels can center; font sizing stays shell-CSS-only.
- Sanitizer treats `<div/>`-style self-closing on HTML elements as an open tag (browser behavior); real self-close honored for SVG elements only.

**Verification run (no OpenAI spend):** `bun run lint` green (`Checked 94 files. No fixes applied.`); `bun run build` green (route registered). 42-check functional harness over sanitizer + assembler: hostile markup/hex/href/iframe/script stripped, truncation + interleave repaired, refusals detected, srcdoc deny-scan aborts, assembled document starts with doctype, exactly one style block, `a` elements footer-only and CNSC-only, renders offline. Live-path acceptance items that need a funded OpenAI call (real starter-question POST, 429 on third anon request) were NOT exercised — flagging for reviewer or a cheap manual check.

**What slice 1.2 needs:**
- POST `/api/knowledge-hub/artifact` with JSON `{ query: string }`. Non-2xx JSON errors: 400 `{ error: "validation", message }`, 429 guard shape, 500 `{ error: "internal_error", message }` — check `res.ok` before reading SSE.
- SSE events on 200: `meta` `{ model, chunks, cached }` → `progress` `{ tokens }` (every ~250) → `artifact` `{ html, sources, truncated, limitedCoverage, cached }` → `done` `{ cached }`; failure path emits `error` `{ code: "out_of_scope" | "output_guard" | "generation_failed", message }` (jailbreak/OOS responses are one-shot SSE bodies carrying only `error`).
- `sources` is exactly the `SourceChunk[]` shape `SourcesPanel` takes; `lib/artifact-template.ts` exports the matching `ArtifactSource` type if the hook wants it.
- The `html` string is the complete standalone document — feed to `iframe srcDoc` and the Download blob unmodified.

### Fix round 1

Fix executor, 2026-07-13. Review approved all 6 claims; the blind-hostile smell probe found one escaped defect, plus test debt.

1. **Unreachable limited-coverage callout (fixed).** The route gated `limitedCoverage` on the post-filter envelope `avgSim`, but the non-OOS envelope only contains chunks ≥ `MIN_CHUNK_SIM` (0.35 == `LOW_SIM_DISCLAIMER`), so the callout was dead code. `RetrievalResult` gained an ADDITIVE `poolAvgSim` field — mean over the full ranked candidate pool BEFORE the `MIN_CHUNK_SIM` filter, the same pool the OOS branch already averages (semantics match chat's logged full-pool quirk; in the OOS branch `avgSim === poolAvgSim`). The artifact route now computes `limitedCoverage = poolAvgSim < LOW_SIM_DISCLAIMER`, reachable when one ≥0.40 chunk clears the OOS gate atop many weak ones. Chat route untouched (zero diff): envelope `avgSim` semantics, disclaimer logic, and all calibrated constants unchanged. The identical dead-disclaimer pattern in the CHAT route (query/route.ts:283) is pre-existing and deliberately NOT touched (out of scope per dispatch). Spec §B "Retrieval + gates" line + weak-retrieval edge case updated above to the `poolAvgSim` wording.
2. **Committed test harness (`scripts/test-artifact.ts`, `bun run test:artifact`).** The executor's 42-check sanitizer/template functional harness now lives in the repo, extended with reviewer-mandated regression checks: (a) limited-coverage reachability — synthetic ranked pool with topSim ≥ 0.40 but pool mean < 0.35 → assembled document CONTAINS the callout; strong pool → does NOT; (b) dead-threshold guard — asserts the post-filter envelope average is structurally ≥ `MIN_CHUNK_SIM` (so it can never fire the callout) and source-asserts the route predicate reads `poolAvgSim`, not `avgSim` (mutation-tested: reverting the predicate fails 2 checks). Pure/offline: retrieval exercised through the real `retrieveChunks` with mocked supabase/openai deps and an in-process Upstash fetch stub; any other network call throws. 56 checks green.
