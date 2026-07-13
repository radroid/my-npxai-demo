# Token ledger

One line per role run. Budgets are SOFT targets for steward outlier analysis, NOT caps — quality outranks token savings. Seed budgets after a few runs; do not invent precise numbers.

Format: `| date | item | role | PR | verdict/outcome | approx tokens | notes |`

## Soft budgets (unseeded — steward fills after ≥3 runs per role)

| Role | Soft budget | Basis |
|---|---|---|
| planner | — | |
| executor | — | |
| reviewer | — | |
| fix | — | |
| steward | — | |

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

## Audit ledger (typed records from canon-bound gates)

One fenced JSON line per gate outcome (workflow-runtime `AUDIT_LEDGER_ENTRY`): role / verdict / issues / tests_added / gate_decision; orchestrator stamps cost / ts / human_approval.

```json
{"role":"reviewer","cost":{"role":"reviewer","label":"review-pr6-wf_51620c92","tokens_in":0,"tokens_out":2445708},"verdict":"APPROVE","issues":[{"severity":"non_blocking","note":"30 non-blocking findings incl. recordOpenAICall-in-retrieveChunks (item-2 must inject), PROMPT_VERSION chat-cache churn (accepted); smell probe found unreachable limited-coverage callout → fix round 1"}],"tests_added":1,"gate_decision":"proceed","human_approval":null,"item":"item-1","pr":6,"ts":"2026-07-13T10:20:00-04:00"}
```
