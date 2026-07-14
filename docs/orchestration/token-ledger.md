# Token ledger

One line per role run. Budgets are SOFT targets for steward outlier analysis, NOT caps — quality outranks token savings. Seed budgets after a few runs; do not invent precise numbers.

Format: `| date | item | role | PR | verdict/outcome | approx tokens | notes |`

## Soft budgets (seeded 2026-07-14, first steward pass — SOFT targets for outlier analysis, NOT caps; quality outranks token savings)

| Role | Soft budget | Basis |
|---|---|---|
| planner | ~140k–150k | item-1 spec 148k, item-2 spec 139k (2 runs) |
| executor | ~120k–190k | PR6 180k, PR7 121k, PR8 187k (3 runs; wide range reflects slice size, not a quality signal — do not compress a slice to hit the low end) |
| reviewer | ~1.3M–2.1M (tiered) | PR7 tiered re-review 1,894k, 30/30 ballots landed. PR #8's three tiered review rounds (item-2 slice 2.1) widen the observed range to ~1.3M–2.1M — 30/30, 20/20, then 15/15 ballots landed across rounds 1-3 (declining count tracks a shrinking issue surface each round, not tier failures), and every round still found real REVISE-worthy defects. Figures are an orchestrator-relayed rollup across the 3 rounds, not an independently-verified per-round breakdown — see 2026-07-14 steward-pass-2 changelog entry. Historical untiered baseline ~2.4M (PR6, 2,446k, 31 agents) — kept as reference, not the active budget; see 2026-07-14 tiering changelog entries for the revert condition (0/3 triggers tripped through PR #8). Misfire/void runs (300k, 1,564k — dead-ballot noise from infra/encoding bugs, not real reviews) excluded from this basis. |
| fix | ~120k–370k | PR6 fix round ~120k (1 run). PR #8's three fix rounds (item-2 slice 2.1) widen the range to ~120k–370k — the higher end reflects rounds that swept multiple sibling call sites in one pass (round 2 alone landed 5 separate commits sweeping the vacuous-pass bug class across every experiment), not scope creep; per QUALITY OUTRANKS TOKEN SAVINGS this is expected cost for a full bug-class sweep, not drift. Orchestrator-relayed rollup, no independent per-round breakdown. |
| steward | ~100k–110k (2 runs) | 2 runs: item-1 gate + item-2 gate below — reseed after ≥3 steward runs. |

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
| 2026-07-14 | item-2 | reviewer (workflow, tiered) round 1 | 8 | REVISE — 7 issues (methodology/wallet) | ~1.3M–2.1M (rollup across 3 rounds, orchestrator-relayed — see note) | 30/30 ballots landed; every finding was a metric scoring a vacuous/wrong-reason case as a pass |
| 2026-07-14 | item-2 | fix round 1 | 8 | 7/7 issues fixed | ~120k–370k (rollup across 3 rounds, orchestrator-relayed — see note) | regression suite 60 → 137 checks; 12/12 mutations caught; scoped fixes to `baseline` only (gap found by round 2) |
| 2026-07-14 | item-2 | reviewer (workflow, tiered) round 2 | 8 | REVISE — un-swept vacuous-pass class + trace/cost findings | ~1.3M–2.1M (rollup) | 20/20 ballots landed; caught round 1's fix scoped to baseline while consistency/paraphrase carried the identical bug |
| 2026-07-14 | item-2 | fix round 2 | 8 | issues fixed across 5 commits | ~120k–370k (rollup) | regression suite 137 → 223 checks; 12/12 mutations caught; caught round 1's own partly-vacuous regression test (`.slice(0,30)`) |
| 2026-07-14 | item-2 | reviewer (workflow, tiered) round 3 | 8 | REVISE — 2 blocking + 1 nit; wallet/cost machinery APPROVED 0/5 | ~1.3M–2.1M (rollup) | 15/15 ballots landed; final round — answer relevancy's missing exclusion path + HTTP fail-loud on first live contact |
| 2026-07-14 | item-2 | fix round 3 | 8 | 2 blocking + 1 nit fixed | ~120k–370k (rollup) | regression suite 223 → 266 checks (steward-verified by independent re-run this pass); 6/6 mutations caught |
| 2026-07-14 | item-2 | executor/orchestrator | 8 | PR MERGED — main tip 6559609 | — | slice 2.1 complete after 3 review + 3 fix rounds; slice 2.2 (the battery) now BLOCKED on human (Supabase paused + dev server down) |
| 2026-07-14 | item-2 (gate) | steward | — (docs PR pending) | 3 template edits + friction drained + soft budgets widened | ~110k (est., self-reported — steward has no external cost readout) | drained 4 new PR #8 findings straight to Resolved (filed + fixed same pass, no prior Open entry existed for this evidence); planner.md +1 rule (metric exclusion policy up front), fix.md +3 rules (bug-class sweep, mandatory mutation-testing, test-count honesty), reviewer.md +1 rule (fix-round sibling-sweep check); executor.md/steward.md untouched (no matching friction — gap lived in spec design + fix-round discipline, not initial-PR execution); independently re-ran `bun run test:rag-eval` to verify the 266-check claim before writing the test-count-honesty rule |

## Audit ledger (typed records from canon-bound gates)

One fenced JSON line per gate outcome (workflow-runtime `AUDIT_LEDGER_ENTRY`): role / verdict / issues / tests_added / gate_decision; orchestrator stamps cost / ts / human_approval.

```json
{"role":"reviewer","cost":{"role":"reviewer","label":"review-pr6-wf_51620c92","tokens_in":0,"tokens_out":2445708},"verdict":"APPROVE","issues":[{"severity":"non_blocking","note":"30 non-blocking findings incl. recordOpenAICall-in-retrieveChunks (item-2 must inject), PROMPT_VERSION chat-cache churn (accepted); smell probe found unreachable limited-coverage callout → fix round 1"}],"tests_added":1,"gate_decision":"proceed","human_approval":null,"item":"item-1","pr":6,"ts":"2026-07-13T10:20:00-04:00"}
```

```json
{"role":"reviewer","cost":{"role":"reviewer","label":"review-pr13-embed-upgrade-wf_8414e344","tokens_in":0,"tokens_out":457273},"verdict":"REVISE — 1 issue","issues":[{"severity":"blocking_for_merge","note":"deploy-ordering: in-place vector(1536)→halfvec(3072) swap makes the RPC signature incompatible in both directions → guaranteed prod outage window in either merge order; DROP COLUMN empties live embeddings until re-ingest. Resolved OPERATIONALLY (PR held behind hosted runbook), not by code — branch code is correct for the migrated target state."},{"severity":"non_blocking","note":"migration DROP COLUMN is irreversible in-DB with no snapshot → optional CREATE TABLE ... AS SELECT embedding backup before push"},{"severity":"non_blocking","note":"recordOpenAICall(0) hardcodes $0 for embedding calls (pre-existing) → daily-cost breaker never counts embedding spend; trivial at current volume"}],"tests_added":0,"gate_decision":"hold","human_approval":null,"item":"item-2b","pr":13,"ts":"2026-07-14T14:20:00-04:00"}
```
