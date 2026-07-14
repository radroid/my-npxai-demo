# Token ledger

One line per role run. Budgets are SOFT targets for steward outlier analysis, NOT caps — quality outranks token savings. Seed budgets after a few runs; do not invent precise numbers.

Format: `| date | item | role | PR | verdict/outcome | approx tokens | notes |`

## Soft budgets (seeded 2026-07-14, first steward pass — SOFT targets for outlier analysis, NOT caps; quality outranks token savings)

| Role | Soft budget | Basis |
|---|---|---|
| planner | ~140k–150k | item-1 spec 148k, item-2 spec 139k (2 runs) |
| executor | ~120k–190k | PR6 180k, PR7 121k, PR8 187k (3 runs; wide range reflects slice size, not a quality signal — do not compress a slice to hit the low end) |
| reviewer | ~1.9M (tiered) | PR7 tiered re-review 1,894k, 30/30 ballots landed. Historical untiered baseline ~2.4M (PR6, 2,446k, 31 agents) — kept as reference, not the active budget; see 2026-07-14 tiering changelog entries for the revert condition. Misfire/void runs (300k, 1,564k — dead-ballot noise from infra/encoding bugs, not real reviews) excluded from this basis. |
| fix | ~120k–160k | PR6 fix round ~120k (1 run so far); range widened pending a second data point — treat the upper bound as provisional, not evidence of drift. |
| steward | — | first steward run (this pass) below — reseed after ≥3 steward runs. |

## Runs

| Date | Item | Role | PR | Verdict/outcome | ~Tokens | Notes |
|---|---|---|---|---|---|---|
| 2026-07-13 | pre-item | reviewer | 5 | REVISE — 1 issue (+free-hunt fix) | 74k | docs-only scaffolding review; 1 wording issue + spec-custody ambiguity killed; one factual miss (claimed stale tree state) — filed as friction |
| 2026-07-13 | pre-item | fix (orchestrator inline) | 5 | fixed, merged | ~2k | trivial docs edits; merged after review evidence |
| 2026-07-13 | item-2 (pre) | research (workflow, 4 agents) | — | research doc written | 239k | multi-angle web sweep + synthesis → docs/orchestration/research/rag-eval-metrics.md |
| 2026-07-13 | item-1 | planner | — | spec written | 148k | 2 slices; 6 discovered invariants (I1.7–I1.12) |
| 2026-07-13 | item-2 | planner | — | spec written | 139k | 2 slices; found corpus truth 19 docs/~1,945 chunks; Redis-cache consistency trap |
| 2026-07-13 | item-1 | executor | 6 | PR open, gates green | 180k | slice 1.1 backend; 7 logged deviations; 42-check self-harness |
| 2026-07-13 | item-1 | reviewer (workflow, MISFIRE) | 6 | verdict DISCARDED | 300k | args string-encoding bug → script reviewed its demo fallback claims, not PR #6; re-run with inlined claims |
| 2026-07-13 | item-1 | reviewer (workflow, 31 agents) | 6 | APPROVE (all 6 claims) + SMELL HIT | 2,446k | run 2 died on Raj's monthly spend limit (19/30 refuters, fail-closed); run 3 resumed from cache; 30 non-blocking findings; smell probe caught unreachable limited-coverage callout |
| 2026-07-13 | item-1 | fix | 6 | poolAvgSim fix + test harness | ~120k | fix agent died on spend limit post-edits pre-build; orchestrator finished gates+commit; lint/build/test:artifact green |
| 2026-07-13 | item-1 | executor | 7 | PR open, 3 gates green | 121k | slice 1.2 frontend; 5 logged deviations; UI verification queued (dev server down) |
| 2026-07-13 | item-1 | reviewer (workflow, VOID) | 7 | discarded | 1,564k | Fable 5 usage limit killed 29/30 refuters → fail-closed REVISE was dead-ballot noise, not findings |
| 2026-07-14 | item-2 | executor (checkpoint + 2 dead predecessors) | 8 | PR open, 4 gates green | 187k | slice 2.1 eval framework; golden set BLOCKED (Supabase paused) → placeholder, runner refuses to score; $0.00 spent |
| 2026-07-14 | item-1 | reviewer (workflow, TIERED) | 7 | REVISE — real findings | 1,894k | 30/30 ballots; model-tiered (2 opus lenses + smell probe, 3 sonnet lenses); 1 blocking UX defect (sidebar dead in artifact mode) + scroll-promise lie + CSS var coupling + zero frontend tests |
| 2026-07-14 | item-1 (gate) | steward | — (docs PR pending) | 4 template edits + soft budgets seeded | ~100k (est., self-reported — steward has no external cost readout) | drained friction-log Open into Resolved (7 entries) + 2 left Open with explicit no-change reasons; planner.md +4 rules, executor.md +2 rules (checkpoint-push is the highest-value one), reviewer.md +1 rule (mandatory smell pass) + evidence-line hardening; fix.md/steward.md untouched (no matching friction) |

## Audit ledger (typed records from canon-bound gates)

One fenced JSON line per gate outcome (workflow-runtime `AUDIT_LEDGER_ENTRY`): role / verdict / issues / tests_added / gate_decision; orchestrator stamps cost / ts / human_approval.

```json
{"role":"reviewer","cost":{"role":"reviewer","label":"review-pr6-wf_51620c92","tokens_in":0,"tokens_out":2445708},"verdict":"APPROVE","issues":[{"severity":"non_blocking","note":"30 non-blocking findings incl. recordOpenAICall-in-retrieveChunks (item-2 must inject), PROMPT_VERSION chat-cache churn (accepted); smell probe found unreachable limited-coverage callout → fix round 1"}],"tests_added":1,"gate_decision":"proceed","human_approval":null,"item":"item-1","pr":6,"ts":"2026-07-13T10:20:00-04:00"}
```
