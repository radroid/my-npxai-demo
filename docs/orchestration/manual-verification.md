# Manual verification queue

Features that shipped on build/unit green but whose runtime oracle cannot run unattended. One item + exact repro recipe each. This queue is a FIRST-CLASS run deliverable — the morning handoff — not a per-PR footnote. Raj checks items off after live verification.

## Queue

### item-2 slice 2.1 — RAG eval framework

- [ ] **Un-pause the Supabase project, then generate the real golden set.** The project (`ptepxophdneugvcziqny`) is paused again — NXDOMAIN on the REST host, same signature as `supabase/RECOVERY.md` (a paused free-tier project drops its DNS record; NXDOMAIN alone does not prove deletion). Because the corpus of record was unreachable, `evals/rag-golden.jsonl` and `evals/rag-paraphrases.jsonl` shipped as clearly-labelled PLACEHOLDERS (`placeholder: true`), and the runner refuses to score them.
  - Repro / fix: un-pause from the dashboard → `bun run eval:rag:golden` (expected spend ≈ $0.60–0.90 at the gpt-4o judge tier, hard-capped by `EVAL_COST_CAP_USD`, default 2). It writes both datasets. Nothing else in the framework is blocked.
- [ ] **Human-review the generated golden set** (spec R3 curation). Once generated it is AGENT-CURATED only: no human has verified answerability or chunk attribution. Review every record's `ground_truth_answer` and `gold_chunks` — at minimum a 25–30% stratified sample plus ALL `difficulty: multi` items (research doc §Golden dataset construction). The slice-2.2 report MUST disclose the review status either way.
- [ ] **Smoke the answer harness against the live dev server** (slice 2.2's first act; the server was down during 2.1, so the HTTP path has never executed): `bun run eval:rag --experiment baseline --limit 5` with `EVAL_BYPASS_KEY` set. Expected: < $0.25, an `items.jsonl` + `manifest.json` under `evals/results/`, a printed three-way cost split; an immediate identical re-run should show judge cost ≈ $0 (disk cache hits).
