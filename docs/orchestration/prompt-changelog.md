# Prompt changelog

The SINGLE version record for the role templates (`docs/orchestration/prompts/*.md`) — templates carry no version headers. Every template change lands here tied to the KPI it targets. The steward also logs "no change" audit traces here every run.

## KPI definitions

- **planner/executor/reviewer cost** — approx tokens per run (from token-ledger).
- **review yield** — real issues per review that SURVIVE the fix (issue applied, not reverted/rejected).
- **escaped defects** — defects found after merge. Until a runtime smoke oracle exists, label this "escaped defects (build/unit-detectable only)" — it is 0-known, not 0-real.
- **plan-friction count** — friction-log entries attributable to spec gaps.
- **cycle overhead** — fix loops per PR.

## Changes

- **2026-07-14** — **Model tiering in the review gate** (targets: reviewer cost, without touching review yield). The canon review workflow previously let all 30 refuters inherit the session model — millions of tokens and a tripped usage limit that fail-closed a whole verdict into noise. Refuter lenses are now tiered per `agent()` call: `free-hunt` + `composition` (the two that need real reasoning — invent an unlisted failure mode / re-read cross-PR contracts) stay on the top tier at high effort, and the blind-hostile smell probe stays top-tier (it is what caught PR #6's escaped defect); `hostile`, `delta-consequence`, `no-self-marked-homework` drop to a mid-tier model at low/medium effort since they are mechanical verification against a stated contract. QUALITY OUTRANKS TOKEN SAVINGS still binds: if review yield drops or a defect escapes, revert the tiering — the changelog decides whether it stays.
- **2026-07-13** — Seed. All five templates authored from the orchestrated-delivery loop contract + ANTI-BIAS clauses (reviewer embeds them verbatim; unified verdict grammar `APPROVE | REVISE — n | BLOCK — n`). Caveman report style encoded in every template's report section. No KPI data yet.
