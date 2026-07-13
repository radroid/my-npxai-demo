# Prompt changelog

The SINGLE version record for the role templates (`docs/orchestration/prompts/*.md`) — templates carry no version headers. Every template change lands here tied to the KPI it targets. The steward also logs "no change" audit traces here every run.

## KPI definitions

- **planner/executor/reviewer cost** — approx tokens per run (from token-ledger).
- **review yield** — real issues per review that SURVIVE the fix (issue applied, not reverted/rejected).
- **escaped defects** — defects found after merge. Until a runtime smoke oracle exists, label this "escaped defects (build/unit-detectable only)" — it is 0-known, not 0-real.
- **plan-friction count** — friction-log entries attributable to spec gaps.
- **cycle overhead** — fix loops per PR.

## Changes

- **2026-07-13** — Seed. All five templates authored from the orchestrated-delivery loop contract + ANTI-BIAS clauses (reviewer embeds them verbatim; unified verdict grammar `APPROVE | REVISE — n | BLOCK — n`). Caveman report style encoded in every template's report section. No KPI data yet.
