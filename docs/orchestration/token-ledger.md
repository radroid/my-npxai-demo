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

## Audit ledger (typed records from canon-bound gates)

One fenced JSON line per gate outcome (workflow-runtime `AUDIT_LEDGER_ENTRY`): role / verdict / issues / tests_added / gate_decision; orchestrator stamps cost / ts / human_approval.
