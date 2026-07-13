# Friction log

Anything that slowed a role down or forced a workaround. Entry format: `- [role-tag] (date, run) problem — implication`. The steward drains `## Open` into template changes and moves entries to `## Resolved` with a pointer to the change.

## Open

- [reviewer] (2026-07-13, PR 5) reviewer asserted local-working-tree state ("timelapse files still present") that was factually stale/wrong — its own contract says diff + `gh` only; template may need an explicit "never assert local-tree state as evidence" line.
- [orchestrator] (2026-07-13, PR 5) permission gate denies `gh pr merge` without prior review evidence — loop adapted: every PR (even docs-only) gets a reviewer pass before the merge attempt; merge command description must cite the review verdict.
- [planner] (2026-07-13, item-1) spec's SVG attribute contract omitted `id` on `<marker>` + `marker-end` while the element list included marker/defs — executor had to deviate to make arrows functional; planner template could demand element/attribute list reconciliation.
- [planner] (2026-07-13, item-2) docs said "15 REGDOCs" but corpus truth is 19 docs / ~1,945 chunks; `scraped_regdocs/` being gitignored killed the file-based golden-gen option late — backlog now names corpus-of-record = Supabase DB.
- [executor] (2026-07-13, PR 6) `withGuard` fires `logRequest` at handler return but SSE work continues after — `output_tokens`/`artifact_bytes` land in ctx.logFields post-log on ALL streaming routes (pre-existing on chat/generator too). Backlog candidate for a later hardening item, not this sprint.
- [orchestrator] (2026-07-13, PR 6 review) Workflow `args` arrived inside the script as a JSON-encoded STRING, so `args.claims` was undefined and the canon review script silently reviewed its inline DEMO claims (fake paginate/auth diffs) — 300k tokens burned on a meaningless verdict. Counter-move adopted: never rely on `args` for the canon scripts; copy the script and INLINE the claims in the body, run via scriptPath. The fallback-demo-claims design converts a malformed dispatch into a plausible-looking wrong result — worth an upstream fix (fail loudly when args are absent).
- [orchestrator] (2026-07-13, item-1/item-2) both planners independently spec'd the SAME lib/retrieval.ts extraction — cross-item dependency only caught at orchestrator level; backlog Needs column now records it. Planner dispatches for overlapping items should name in-flight sibling specs.

## Resolved
