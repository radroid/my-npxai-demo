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
| 1 | `GeneratorForm.tsx` (split into 5 files) | 887 | 961 (274+150+107+239+191) | **+74** | Reorg, not a raw cut. Extracted `use-generate-stream.ts`, `StreamingView.tsx`, `ReportView.tsx`, `report-markdown.tsx`. Parent dropped 69% and is now comprehensible in one read. Import headers + function boundaries added ~74 lines. Accepted as a readability/maintenance win; downstream sections should produce raw cuts. |

## Totals
- Lines before: 3674 (campaign-in-scope files)
- Lines after: 3748 (after §1)
- Net delta: +74
