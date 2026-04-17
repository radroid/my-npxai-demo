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

## Totals
- Lines before: 3674 (campaign-in-scope files)
- Lines after: 3677 (after §3)
- Net delta: +3 (§2+§3 cuts nearly offset §1's reorg cost)
