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

## Audit ledger (typed records from canon-bound gates)

One fenced JSON line per gate outcome (workflow-runtime `AUDIT_LEDGER_ENTRY`): role / verdict / issues / tests_added / gate_decision; orchestrator stamps cost / ts / human_approval.
