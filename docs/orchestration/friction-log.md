# Friction log

Anything that slowed a role down or forced a workaround. Entry format: `- [role-tag] (date, run) problem — implication`. The steward drains `## Open` into template changes and moves entries to `## Resolved` with a pointer to the change.

## Open

- [reviewer] (2026-07-13, PR 5) reviewer asserted local-working-tree state ("timelapse files still present") that was factually stale/wrong — its own contract says diff + `gh` only; template may need an explicit "never assert local-tree state as evidence" line.
- [orchestrator] (2026-07-13, PR 5) permission gate denies `gh pr merge` without prior review evidence — loop adapted: every PR (even docs-only) gets a reviewer pass before the merge attempt; merge command description must cite the review verdict.

## Resolved
