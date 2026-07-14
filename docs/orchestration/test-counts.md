# Verified suite sizes (runner output, not remembered figures)

`docs/orchestration/prompts/fix.md` item 8 forbids reporting a test count you did not read from the runner's own output. This file exists so that rule's OWN evidence obeys it — the PR #10 reviewer correctly refused to accept an asserted "266" that appeared in no reproducible artifact.

Reproduce any row yourself; each command prints the tally line for that suite.

| Suite | Command | `ok` lines | Verified |
|---|---|---|---|
| RAG eval framework | `bun run test:rag-eval \| grep -c '^  ok'` | **266** | 2026-07-14, on `steward/item-2` (main @ 6559609) |
| Artifact backend (sanitizer/template/thresholds) | `bun run test:artifact \| grep -c '^ok:'` | **56** | 2026-07-14, same tree |
| Artifact frontend (sandbox/mode/DOM contracts) | `bun run test:frontend \| grep -c '^ok:'` | **25** | 2026-07-14, same tree |

All three print `ALL CHECKS PASSED` on exit.

## Why this file exists (the incident)

PR #8's fix round 3 reported "93 total" checks. The true figure was 266 — the round had counted only the checks it added plus a stale base, and nobody would have noticed had the orchestrator not re-run the suite. The count had already drifted once before (60 → 137 → 223 across rounds), each figure asserted in prose rather than read from output.

The rule that came out of it ("quote the runner's printed tally, never a remembered one") was then itself justified in the friction log and changelog with a bare assertion of "266" — verifiable nowhere on GitHub. A reviewer caught that, which is the whole point: a rule about evidence must itself be evidenced. Hence this table, and the commands to regenerate it.

**Suite sizes drift with every fix round. Do not cite a number from this file without re-running its command.**
