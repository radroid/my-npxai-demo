# Refactor Metrics — Phase 6 overnight LOC reduction campaign

Running tally of code refactored section-by-section. Goal: cut lines of code without sacrificing clarity, correctness, or both-theme correctness.

## Methodology
- Measure with `wc -l` on the target file(s) before and after.
- `before` is the committed state at the start of the refactor campaign (post-lint-cleanup, commit 1f9eb5b).
- `after` is the committed state once the section is reviewed + refactored.
- Record *why* lines dropped (dead code, duplicated logic extracted, collapsed helpers, etc.) — not just raw counts.

## Baseline snapshot (at campaign start, commit 1f9eb5b)

| File | Lines |
|---|---|
| `components/generator/GeneratorForm.tsx` | 887 |
| `components/assistant-ui/thread.tsx` | 446 |
| `app/api/knowledge-hub/query/route.ts` | 388 |
| `components/app/AppShell.tsx` | 342 |
| `app/globals.css` | 327 |
| `app/api/generator/turnover/route.ts` | 262 |
| `lib/guard.ts` | 249 |
| `lib/report-store.ts` | 122 |
| `lib/logger.ts` | 101 |
| `lib/thread-store.ts` | 98 |
| `components/knowledge-hub/KnowledgeHubShell.tsx` | 96 |
| `lib/validators.ts` | 89 |
| `lib/prompts.ts` | 75 |
| `lib/output-guard.ts` | 62 |
| `lib/context-envelope.ts` | 48 |
| `lib/supabase.ts` | 32 |
| `lib/openai.ts` | 18 |
| `lib/supabase-browser.ts` | 18 |
| `lib/initials.ts` | 8 |
| `lib/utils.ts` | 6 |
| **Total (core files)** | **3674** |

## Section log

| # | Section | Before (LOC) | After (LOC) | Δ | Why / notes |
|---|---------|--------------|-------------|---|-------------|
| 1 | `GeneratorForm.tsx` (split into 5 files) | 887 | 961 (274+150+107+239+191) | **+74** | Reorg, not a raw cut. Extracted `use-generate-stream.ts`, `StreamingView.tsx`, `ReportView.tsx`, `report-markdown.tsx`. Parent dropped 69% and is now comprehensible in one read, but net LOC grew. Landed on `main` before course-correction; remaining sections run on refactor branch with strict ≥5% cut criterion. |
| 2 | `components/assistant-ui/thread.tsx` | 446 | 413 | **−33 (−7.4%)** | Three genuine redundancies: (a) citation-sources derivation loop → `.find()` + `??`, (b) hoisted the duplicated `as unknown as { composer: … }` cast out of 5 starter-button click handlers, (c) 11 pure-JSX FC bodies collapsed from `() => { return (…); }` to implicit-return `() => (…)`. No UI / class / prop changes. |
| 3 | `app/api/knowledge-hub/query/route.ts` | 388 | 350 | **−38 (−9.8%)** | Genuine cuts: (a) merged `sha256Hex` helper into `cacheKey` (single call site), (b) closed over repeated `logGuardEvent` payload shape as `logValidation(detail)`, (c) closed over duplicated validation-400 response as `validationError(detail, msg)`, (d) dropped dead `prompt_version` + `cached_at` fields from `CachedAnswer` (never read), (e) inlined single-use `UIMessagePart` interface, (f) collapsed multi-line cache-hit write and `emit(delta).terminate` check, (g) tightened restate-the-code comments while keeping WHY. RAG thresholds / SSE frame shapes / cache key / guard wiring all unchanged. |
| 4 | `components/app/AppShell.tsx` | 342 | 323 | **−19 (−5.6%)** | Ten genuine cuts: (a) killed `hydrated` state + second persist effect — writes happen inside the setter now; (b) init collapsed to `setCollapsed(stored === "1")`; (c) shared `ICON_BTN` classname constant across 4 button sites; (d) unified the 3 sidebar-header action buttons (Expand/Close/Collapse) behind one data-driven renderer — was a nested ternary chain; (e) `THEME_CYCLE` lookup table replaces 3 parallel ternaries in `CollapsedThemeCycle`; (f) label span collapsed to `sr-only`-or-visible with one className conditional; (g) inlined single-use `initialsFromEmail` call; (h) dropped 2 restate-the-code block comments; (i) merged `PrimaryNavItem` type + array into one `as const` literal; (j) inlined `AppShellProps` into destructure. All UX invariants preserved. |
| 5 | `app/api/generator/turnover/route.ts` | 262 | 236 | **−26 (−9.9%)** | Genuine cuts: (a) `send(event, data)` closure inside `stream.start` collapses the `controller.enqueue(encoder.encode(sseFrame(...)))` triple-wrap that appeared at 6 callsites; (b) header comment compressed from 12 → 6 lines while keeping architectural info; (c) dropped 3 restate-the-code comments (auth.getUser commentary, `console.warn` flow narration, dedupe-lookup annotation); (d) minor formatting consolidation. Subagent explicitly rejected shared-helper extraction to `lib/guard.ts` — showed the math: import overhead across two routes exceeded the inline savings, and guard.ts's role is rate-limiting, not response-shaping. Behavior preserved: all 5 SSE frame types, `snapshot_hash`, RPC paths, `?force=true`, `StreamingGuard`. |
| 6 | `lib/guard.ts` | 249 | 233 | **−16 (−6.4%)** | Seven genuine cuts: (a) tier resolution two-step collapsed to one ternary — same fall-through semantics; (b) `resolveClientIp` optional-chain + `\|\|` fallback instead of nested if-chain; (c) inlined single-use `clientIp` temp; (d) shorter `getLimiter` signature via `type Window` alias; (e) `guardBase` const hoisted to close over the `{route, ip_hash, tier, user_hash}` shape shared by both `logGuardEvent` sites; (f) `today` hoisted in `recordOpenAICall` to dedupe `new Date().toISOString().slice(0,10)`; (g) header comment tightened. Subagent rejected inlining `LIMITS` to tuple arrays and inlining `WINDOW_MAP` — Biome formatter expands them back and the savings evaporate. All behavior preserved: rate-limit key format, tier resolution order, per-route/per-tier bucket sizes, `x-eval-bypass` flow, IP precedence (B.1), exported surface. |
| 7 | `app/globals.css` | 385 | 364 | **−21 (−5.5%)** | Dead shadcn-compat tokens removed after whole-codebase grep: `--color-card` + `--color-card-foreground` (no `bg-card`/`text-card`/`var(--card)` references anywhere), `--color-chart-1` through `--color-chart-5` (no chart component exists — the `LineChartIcon` lucide import is unrelated). Both the `@theme inline` declarations and the matching `:root` + `.dark` value declarations dropped for parity. Kept every token that's actually referenced, including all `--popover-*` (used by DropdownMenu + Select + Thread primitives) and all `--sidebar-*` (used by components/ui/sidebar.tsx). Reduced-motion !important block, aurora keyframes, print CSS, and WHY comments all intact. |
| 8 | `lib/report-store.ts` | 122 | 99 | **−23 (−18.9%)** | Biggest single-file cut of the campaign. Dead export `findAnonReportByHash` had zero call sites and was not in the protected-signatures list. Plus genuine compressions: loop-based string-field validator (`STRING_FIELDS.every(...)`) replacing 7 hand-written `typeof r.x === "string"` checks; dedup collapse of `saveAnonReport` from `findIndex` + dual branches + `filter((_, i) => i !== idx)` down to `find(id)` + single `filter(r => r.id !== record.id)`; `isBrowser` arrow expression; optional-chain for `window.crypto?.randomUUID`; trimmed restate comments. Ring buffer, storage key, relativeTime branches, and four public signatures unchanged. |
| 9 | `lib/logger.ts` | 101 | 95 | **−6 (−5.9%)** | Three cuts: (a) `saltedHash(prefix, value)` helper dedups `sha256Hex(${prefix}|${LOG_HASH_SALT}|${value}).slice(0,16)` shared by `hashIp` and `hashUser`; (b) `emit(event, fields)` helper dedups `console.log(JSON.stringify({t, event, …fields}))` shared by `logRequest` and `logGuardEvent`; (c) dropped `// YYYY-MM-DD` restate comment. Daily-salt composition, sha256-hex-truncated-to-16 format, logged field set, and exports unchanged. |
| 10 | `lib/thread-store.ts` | 98 | — | **abandoned (file is 100% dead code)** | Whole-file dead-code check: zero consumers in `app/`, `components/`, `lib/`, `hooks/`. Only `TODO.md` references it (as a planned future integration for Phase 6B.persistence). The 6B.persistence work will need a hybrid localStorage+Supabase store branching on session presence and a custom assistant-ui runtime — essentially a different shape. **Recommend deletion (requires Raj authorization — sandboxed refactor agent cannot delete pre-existing files unilaterally).** If kept: would save 0 lines now, will save ~98 once the real store lands. |
| 11 | `lib/validators.ts` | 89 | 70 | **−19 (−21.3%)** | Dead exports removed after whole-codebase grep: (a) `knowledgeHubQuerySchema(tier)` — 16 lines; KH route enforces char cap via `ctx.inputCharCap` from `withGuard`, never calls this factory. (b) `GeneratorInput` type (`z.infer<typeof generatorInputSchema>`) — 2 lines; turnover route calls `generatorInputSchema.safeParse` directly and doesn't import the inferred type. All other exports preserved: `OUTPUT_MAX_TOKENS`, `QUERY_CHAR_CAP`, `CONTROL_CHARS` + its biome-ignore, all 4 `JAILBREAK_PATTERNS` (verified no subsumption — each matches distinct literals), `generatorInputSchema`, `STATIONS`/`UNITS`/`SHIFTS`, `Tier`, `sanitizeQueryText`, `stripHtmlTags`, `detectJailbreakMarkers`. |
| 12 | `components/knowledge-hub/KnowledgeHubShell.tsx` | 96 | — | **abandoned (only 2.1% possible)** | Applied the §4 AppShell pattern (kill `hydrated` state + second persist effect) and verified it works, but only yielded -2 lines / -2.1%. Two large button className strings are near-duplicates but already single-line so extraction saves zero. `? (...) : null` → `&& (...)` rewrites don't save lines once Biome line-wraps. Sub-threshold — abandoned per rule 2. |
| 13 | `lib/output-guard.ts` | 62 | 55 | **−7 (−11.3%)** | Two genuine cuts: (a) `scanOutput` loop flattened — `if (match) { const cutoff = match.index; … }` → `if (!match) continue;` with `match.index` inlined into the slice. Drops one indent level, one temp var. (b) `StreamingGuard.push` — merged two single-use locals (`alreadyEmittedLen`, `trailingSafe`) into one destructure, and collapsed the 5-line return-object literal to shorthand single line. Deny-list patterns, truncate-on-hit, public surface all unchanged. |
| 14 | `lib/context-envelope.ts` | 48 | 45 | **−3 (−6.3%)** | Two cuts: (a) `wrapChunk` inlined single-use `const id = \`S${i+1}\`` into the attrs string, and dropped the `[...].join("")` array scaffold in favor of `+` concatenation. (b) `buildContextEnvelope` inlined the single-use `wrapped` local into the outer template literal; replaced `(c, i) => wrapChunk(c, i)` with bare `wrapChunk` reference (extra `array` arg from `.map` is ignored — same signature). `<context_snippet>` tag format and HTML-escape behavior unchanged. |
| 15 | `components/generator/report-markdown.tsx` | 239 | 218 | **−21 (−8.8%)** | Seven genuine cuts. Biggest: `styled(tag, className)` factory using `React.createElement` collapses 8 near-identical ReactMarkdown overrides (h1, h3, ul, ol, strong, table, th, td) that were each `({ node, ...props }) => <tag className="…" {...props} />`. Plus `CALLOUT_BASE` shared suffix across SEVERITY_TONES (`border-l-4 px-3 py-2 rounded-r-md`), `PRIORITY_CHIP_BASE` + lookup map replacing the 3-branch ternary in `PriorityBadge`, `TEXT_BODY` constant for the 4× repeated `"text-sm leading-relaxed text-[var(--text)]"`, `SeverityInner` absorbs tone lookup, `childrenToText()` helper for the inline `String(Array.isArray…join…)` H2 block, dropped redundant `SeverityTone.label` field (always equal to the key). Severity callout visual structure + slugify format + public exports unchanged. |

## Totals
- Lines before: 3674 (campaign-in-scope files, pre-§1 baseline)
- Lines after: 3516 (after §15)
- Net delta: **−158 lines overall** (or −256 if Raj authorizes `lib/thread-store.ts` deletion)

## Campaign summary

- **15 sections attempted.** 12 committed cuts, 2 abandoned (KnowledgeHubShell sub-threshold, thread-store is whole-file dead code pending deletion authorization), 1 reorg-not-cut (GeneratorForm split §1 landed on `main` before the course-correction that tightened criteria).
- **Biggest single-file wins by percent:** report-store.ts (−18.9%), validators.ts (−21.3%, two dead exports), output-guard.ts (−11.3%), KH query route (−9.8%), turnover route (−9.9%), report-markdown.tsx (−8.8%).
- **Biggest single-file wins by absolute lines:** KH query route (−38), thread.tsx (−33), turnover route (−26), report-store.ts (−23), report-markdown.tsx (−21), globals.css (−21).
- **Patterns that kept paying off**
  - Dead exports discovered by repo-wide grep (validators `knowledgeHubQuerySchema` + `GeneratorInput`, report-store `findAnonReportByHash`, globals.css chart + card token mappings)
  - Helper closures that dedup the envelope of repeated log calls / SSE emit calls / object-construction patterns (guard.ts `guardBase`, logger.ts `saltedHash` + `emit`, KH route `logValidation` + `validationError`, turnover route `send`)
  - Factory-style React helpers that collapse similar overrides (report-markdown `styled(tag, className)`)
  - Lookup tables replacing parallel ternary chains (AppShell `THEME_CYCLE`, report-markdown `PRIORITY_CHIP_CLS`, guard.ts tier table)
- **Patterns that did NOT pay off** (honest documentation so future passes skip them)
  - Inlining Tailwind 4 `LIMITS` / `WINDOW_MAP` objects — Biome reformats multi-line regardless.
  - Re-organizing already-tight files into more files — adds import headers and function signatures for negative net.
  - Rewriting assistant-ui composer type casts without changing behavior.
- **Gates held the whole campaign.** After every section: `bun run lint` → 0 errors / 0 warnings, `bun run build` → 15/15 routes compile.
- **Behavioral invariants preserved** (grouped by file). RAG thresholds (LOW_SIM_OOS=0.40, MIN_CHUNK_SIM=0.35), SSE frame shapes, cache key format, `withGuard` + `StreamingGuard` wiring, rate-limit key format, tier resolution order, per-tier scaling tables, daily-salt hash format, localStorage keys, assistant-ui runtime wiring, severity-callout visual structure, slugify format, print stylesheet hooks, aurora keyframes, reduced-motion resets.

## Open items for Raj

1. **Authorize deletion of `lib/thread-store.ts`** (98 lines, zero consumers). Whether to keep as scaffolding for 6B.persistence or start fresh when that work lands.
2. **Review the §1 GeneratorForm split** (commit 6adc4a2, already on `main`). It traded +74 net LOC for a 69%-smaller parent file and 4 single-concern siblings. Keep or re-squash at your call.
3. **Merge plan:** this branch is `refactor/overnight-loc-cut` from `main@403c96c`. No functional changes; every section is a mechanical refactor with passing lint + build. Ready to merge whenever you review.
