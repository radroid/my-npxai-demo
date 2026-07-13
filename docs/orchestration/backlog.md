# Orchestration backlog — 2026-07-13 sprint

Sprint brief (Raj, 2026-07-13): (1) Knowledge Hub "Artifact" mode — a search-time toggle that, instead of the chat interface, generates a high-quality self-contained HTML explainer ("artifact", as the AI labs call it) for a complex topic; success criteria: HTML files that explain boring nuclear regulations well, aligned with the NPX theme, containing diagrams and visuals that aid the text. (2) A RAG-pipeline evaluation framework: experiments comparing what is in the ingested files vs what the agent answers, using established metrics (web-researched), with heavy logging, delivering realistic percentages across multiple rating categories. Timelapse-file cleanup was a pre-item (done inline by the orchestrator).

**Progress:** item-1 planner + item-2 metrics research running in parallel. Shipped: PR #5 (scaffolding, merged after review). Ledger/friction updates ride in the next PR (staged by explicit path by the next executor).

## Items

ONE numbering scheme: backlog item IDs (`item-N`), slices (`N.M`). PR numbers are GitHub's and are mapped in dispatches, never here.

| ID | Item | Slices | Needs | Status |
|---|---|---|---|---|
| item-1 | Knowledge Hub Artifact mode | 1.1 artifact generation backend (RAG → themed self-contained HTML w/ inline-SVG diagrams); 1.2 UI toggle + sandboxed artifact viewer (planner may re-slice) | — | planning |
| item-2 | RAG eval framework + experiments | 2.1 framework core (golden dataset, metrics, experiment runner w/ logging + cost guard); 2.2 run experiments + committed scored report (realistic % per category) | metrics research pre-step (orchestrator-dispatched, parallel) | queued |

## item-1 — Knowledge Hub Artifact mode

**Invariants:**
- I1.1 Generated artifact HTML renders ONLY inside a sandboxed iframe; NEVER `allow-same-origin` together with `allow-scripts`; never injected into the app DOM via `dangerouslySetInnerHTML`.
- I1.2 The artifact route passes the SAME deterministic prompt-injection guard, input validation, and tier rate limits as the chat route.
- I1.3 App UI (toggle, viewer chrome, states) uses canonical Tailwind token utilities per CLAUDE.md and works in BOTH light and dark themes.
- I1.4 The artifact document's brand shell (palette/typography/layout CSS) is injected deterministically by our code; the LLM fills content within provided classes/tokens — no LLM-invented hex, no external asset fetches; the artifact is fully self-contained (renders offline).
- I1.5 Output bounded: hard `max_tokens` cap at the call site; per-artifact cost within a small multiple of one chat answer; no new paid dependencies.
- I1.6 Diagrams/visuals are inline SVG (or CSS), self-contained in the file.

## item-2 — RAG eval framework + experiments

**Invariants:**
- I2.1 Eval runs are manual `bun run` scripts — never part of lint/build gate or any CI.
- I2.2 Every experiment run writes a timestamped structured log under `evals/`; the scored report is committed.
- I2.3 Per-run cost tracking: token usage recorded, $ estimate printed + logged, and a hard per-run budget guard that aborts when a configurable cap is exceeded (Raj funds this out of pocket).
- I2.4 Metrics follow established definitions (RAGAS/TruLens-family: faithfulness, answer relevancy, context precision, context recall, plus consistency/robustness) with sources cited in the report; no invented metric names where a standard one exists.
- I2.5 No secrets committed; reuse the existing env-loading pattern.
- I2.6 Follows the existing eval conventions (`scripts/eval-kb.ts`, `scripts/eval-security.ts`, `evals/*.jsonl`).
