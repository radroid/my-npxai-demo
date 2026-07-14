# Spec — item-2: RAG eval framework + experiments

Planner: 2026-07-13. Backlog: `docs/orchestration/backlog.md` §item-2. Research base: `docs/orchestration/research/rag-eval-metrics.md` (untracked until Slice 2.1 commits it — every metric definition, experiment design, judge rule, and expected-range figure in this spec derives from it; cite IT, and through it its sources, in the final report).

## Goal

A manually-run (`bun run …`) evaluation framework that measures the Knowledge Hub RAG pipeline — retrieval, generation, citations, consistency, and refusal behavior — using established metrics (RAGAS/TruLens-family + classic IR), with per-run structured JSONL logging and a hard cost guard. Then run the full experiment battery and commit a scored report giving a realistic 0–100% per rating category, with methodology and citations. Raj funds this out of pocket: every OpenAI call is metered, capped, and cached.

## Context anchors (read before implementing)

- Answerer: `gpt-4o-mini`; embeddings: `text-embedding-3-small`, 1536 dims — `lib/openai.ts:13-18`.
- Production retrieval pipeline lives inline in `app/api/knowledge-hub/query/route.ts`: constants `MATCH_COUNT=20` (:45), `ENVELOPE_CHUNKS=8` (:49), `LOW_SIM_OOS=0.4` (:39), `LOW_SIM_DISCLAIMER=0.35` (:40), `MIN_CHUNK_SIM=0.35` (:50), `NAMED_DOC_BOOST=0.2` (:54); doc-mention extraction `extractMentionedDocs` (:80-90) + concept hints (:65-73); expansion queries `buildExpansions` (:160-181); embedding call (:362-371); primary `match_regdoc_chunks` RPC (:381-388); per-expansion RPCs (:402-417); merge/dedupe by chunk id keeping max similarity (:419-427); OOS gate on raw-pool top-1 (:431, :497-507); named-doc rerank boost (:437-444); doc-diversity envelope selection (:452-484).
- The RPC: `supabase/migrations/20260416120300_rpc_functions.sql:14-39` — cosine similarity = `1 - (embedding <=> query)`, hard row cap `LEAST(match_count, 20)` (:38). Anon-executable, SECURITY DEFINER.
- Chunk storage: `regdoc_chunks`, `id BIGSERIAL` — `supabase/migrations/20260416120100_core_tables.sql:16-28`. IDs are assigned at insert; `scripts/ingest.ts:314-320` wipes and re-inserts the whole table, so **chunk ids are NOT stable across re-ingests**. Chunk identity that survives re-ingest: (`regdoc_id`, `chunk_index`, hash of `chunk_text`) — `scripts/ingest.ts:149-158`. Corpus: 19 docs (18 REGDOCs + NSCA), ~1,945 chunks (comment at `core_tables.sql:12`), ~400-token chunks (`ingest.ts:21`).
- Answer path: system prompt + citation rules `lib/prompts.ts:7-80` (citation format rules 2/2a/2b/2c at :32-71); `PROMPT_VERSION` at `lib/prompts.ts:5`; canonical low-confidence and out-of-scope strings at `lib/prompts.ts:82-86`. Envelope format + `RetrievedChunk` shape: `lib/context-envelope.ts:5-14, 29-60`. Completion call: temperature 0.2, `max_tokens` = tier cap (`route.ts:550-559`); anon tier caps output at 800 tokens (`lib/validators.ts:11-15`).
- Response stream: AI SDK v6 SSE. Text via `text-delta` frames; retrieved envelope arrives as one `data-sources` frame carrying `{id, regdoc_id, section_number, section_title, url, similarity, requirement_type, snippet}` per chunk with snippet truncated to 260 chars (`route.ts:577-590`). Existing parser handles text only: `scripts/eval-kb.ts:147-165`.
- Guard bypass: `EVAL_BYPASS_KEY` env + `x-eval-bypass` header skips rate limits and circuit breaker (`lib/guard.ts:158-161`; client side `scripts/eval-kb.ts:133-135`). Anon limits without it: 3/min, 5/day (`lib/guard.ts:35`). `recordOpenAICall` still increments the global daily counter even for bypassed calls (`lib/guard.ts:295-307`, `route.ts:371,567`) against `GLOBAL_DAILY_CAP=2000` (`lib/guard.ts:12`).
- Redis answer cache: 30-min TTL keyed on (`PROMPT_VERSION`, lowercased query) (`route.ts:203-212`); `trigger: "regenerate-assistant-message"` bypasses AND invalidates it (`route.ts:246-251, 318-327`).
- Deterministic jailbreak guard: patterns `lib/validators.ts:29-48`, scan `detectJailbreakMarkers` `lib/validators.ts:119-126`, short-circuit branch `route.ts:290-313` — streams the canonical out-of-scope line, makes NO OpenAI call, emits NO `data-sources` frame. The similarity OOS gate (`route.ts:497-507`) behaves the same way.
- Existing harness idioms to copy: dev server on port 3001, `EVAL_BASE_URL` override (`scripts/eval-kb.ts:55`), UIMessage POST body (`scripts/eval-kb.ts:111-123`), citation regex `CITATION_RE`/`SECTION_RE` (`scripts/eval-kb.ts:65-67`), section-prefix matching (`scripts/eval-kb.ts:182-187`), refusal markers (`scripts/eval-security.ts:45-46`), JSONL datasets in `evals/*.jsonl`, direct service-role Supabase + OpenAI script pattern (`scripts/probe-sims.ts:8-13`). Bun auto-loads `.env.local` (`scripts/ingest.ts:250`). `bun run lint` does NOT cover `scripts/` (`package.json:10`) but DOES cover `lib/`.
- `scraped_regdocs/` is **gitignored** (`.gitignore` "scrapped docs" block) — it cannot be the golden set's corpus source of record.

## Slices

### Slice 2.1 — Framework core: golden dataset, metrics, runner, cost guard

**R1 — Commit the research doc.** Stage `docs/orchestration/research/rag-eval-metrics.md` by explicit path into this PR. It is the citation base for the Slice 2.2 report.

**R2 — Extract the retrieval pipeline into a lib module** (subject to Open choice 1; this spec is written for the extraction). Move the retrieval internals of `app/api/knowledge-hub/query/route.ts:56-181, 350-490` (doc/section extraction, expansions, embedding, primary + expansion RPCs, merge/dedupe, OOS decision, rerank boost, diversity envelope selection) into a new `lib/retrieval.ts`. One exported entry point; signature (one allowed one-liner):

`retrieveForQuery(deps: {openai, supabase}, query: string, opts?: {matchCount?, envelopeChunks?, thresholds?}) => Promise<RetrievalTrace>`

`RetrievalTrace` carries: expansion inputs used, the merged raw ranked pool (ids + similarities + ranks), the post-boost ranked list, the final envelope selection, `topSim`, `avgSim`, and the fallback decision (`oos` | `disclaimer` | `normal`). Defaults MUST equal today's constants (`route.ts:39-54`) and the route MUST call this function with defaults so production behavior is bit-identical — same OpenAI inputs, same RPC arguments, same ordering. The route keeps everything else (guards, cache, streaming, logging) unchanged. `RetrievedChunk` stays in `lib/context-envelope.ts:5-14`; import, don't duplicate. Acceptance for this requirement: `bun run eval:kb` ship suite and `bun run evals:security` both green against the live dev server after the change (turbopack hot-reloads; do NOT restart the server).

**R3 — Golden dataset generator + committed golden set** (`bun run eval:rag:golden` → `scripts/rag-eval/generate-golden.ts`; output committed at `evals/rag-golden.jsonl`). Corpus access decision (final): read the **Supabase `regdoc_chunks` table** via the service-role script pattern (`scripts/probe-sims.ts:8-13`), NOT `scraped_regdocs/` — the DB is what retrieval actually searches, the gold `chunk_id`s must be the same ids the RPC returns (`route.ts:577`), and `scraped_regdocs/` is gitignored so it doesn't exist on fresh clones. SELECT-only access.

- Size and mix per research doc §Golden dataset construction: 70–80 records total ≈ 4 per doc across 19 docs. Distribution: ~60% single-chunk specific, ~20% multi-chunk (adjacent `chunk_index` within a section, or cross-doc pairs seeded from the concept map at `route.ts:65-73` and the multi-doc rule at `lib/prompts.ts:58-68`), ~20% derived from the existing hand-curated battery: reuse `evals/knowledge-hub.jsonl` core questions as the human-written portion, resolving each `must_cite` doc+section to gold chunk ids by DB lookup.
- Question/answer generation uses the judge-tier model (R6), never the answerer — research doc §Golden dataset construction ("stronger model than the answerer").
- Record schema (JSONL, one per line): `question_id`, `question`, `ground_truth_answer`, `origin` (`synthetic` | `hand`), `difficulty` (`single` | `multi`), and `gold_chunks` — each entry holding `chunk_id` PLUS the stable fingerprint `regdoc_id`, `section_number`, `chunk_index`, and a short sha256 of `chunk_text`. The fingerprint is what survives re-ingest (see Edge case 6).
- Generator must reject any candidate question that trips `detectJailbreakMarkers` (`lib/validators.ts:119-126`) — otherwise the route's deterministic guard refuses it and poisons generation metrics — and any question whose gold chunk fails to place in the generator's own top-20 retrieval sanity probe (un-retrievable gold = mislabeled item).
- Curation: the executor reviews every generated record for answerability and chunk attribution (agent curation — the report must disclose no human review happened yet) and adds a human-review row to `docs/orchestration/manual-verification.md`.

**R4 — Negative / out-of-corpus probe set**, committed at `evals/rag-ooc-probes.jsonl`: 15–25 questions answerable only outside the corpus (US NRC / IAEA / other jurisdictions, general nuclear physics, adjacent CNSC documents not ingested) plus 3–5 plausible-but-false-premise questions, per research doc §Experiments (RGB negative rejection). Fields: `probe_id`, `question`, `category`, `expected: reject`. False-rejection controls come free from the baseline run over the golden set — do not duplicate questions here.

**R5 — Paraphrase set**, committed at `evals/rag-paraphrases.jsonl`: 3 paraphrases each for a stratified 20-question subset of the golden set (cover both difficulties and ≥10 distinct docs), LLM-generated at judge tier, each validated for meaning-equivalence (judge yes/no) before inclusion; fields: `parent_question_id`, `paraphrase_id`, `question`.

**R6 — Judge module** (shared by metrics): OpenAI chat completions; model from `EVAL_JUDGE_MODEL` env, default `gpt-4o` — one tier above the `gpt-4o-mini` answerer (`lib/openai.ts:14`), per research doc §Judge design. Temperature 0, JSON output, rubric per metric with binary or 0–3 integer scale ONLY, and a chain-of-thought `reasons` field emitted BEFORE the verdict field (G-Eval pattern; both per research doc §Judge design). Disk cache under `evals/.judge-cache/` (gitignored): key = sha256 over (judge model, metric id, rubric version string, question, answer hash, context hash); a cache hit costs zero tokens — ~~this is what makes re-runs cents~~ (research doc §Logging requirements). Parse failure handling per Edge case 3.

> **CORRECTION (PR #8 fix round 1, issue 6).** The struck-through clause is FALSE for the scoring metrics. Their cache key includes the ANSWER HASH; the answer harness must send `trigger: "regenerate-assistant-message"` (R8, mandatory) against a non-deterministic answerer, so every run yields new answer text → new hash → **zero cache hits**. Re-running a server-backed experiment costs FULL judge price. This is not fixable by a coarser key: a faithfulness verdict is about a *specific answer*, so keying on (question + chunk ids) would score answer B with answer A's verdict — precisely the kind of flattering-for-the-wrong-reason metric this item exists to prevent. The cache is KEPT (it is correct, and it genuinely saves money where the inputs are stable — see below); only the cost claim is withdrawn. Real re-run cost is in `### Fix round 1`.

**R7 — Metric implementations** (D3 categories; use standard names, no inventions — I2.4). All formulas per the research doc's Metric catalog rows; implement in TypeScript against its definitions (RAGAS/TruLens/DeepEval are Python-only — no new deps):

1. **Retrieval quality** — hit rate@k, MRR (ID-based, zero judge cost), and ID-based context recall (`|gold ∩ retrieved@k| / |gold|`), computed against the ranked envelope selection the pipeline would feed the LLM at that k (via R2's trace, offline — no dev server, no answerer cost).
2. **Context precision** — RAGAS CP@K formula, ID-based relevance labels (a retrieved chunk is "relevant" iff in the item's gold set), swept at k ∈ {3, 5, 8, 10} (RPC caps at 20 — `rpc_functions.sql:38` — so all sweep values are safe). Disclose in the report that ID-based labeling is strict (near-duplicate neighbor chunks count as irrelevant).
3. **Faithfulness** — RAGAS strict inferable-claim standard: judge decomposes the answer into claims, verifies each against the FULL text of the envelope chunks. The `data-sources` snippet is truncated at 260 chars (`route.ts:585`) — fetch full `chunk_text` by id from the DB before judging.
4. **Answer relevancy** — RAGAS Response Relevancy: judge generates 3 questions from the answer, embed all via `text-embedding-3-small`, score = mean cosine vs the original question embedding; clamp negatives to 0 for the 0–100 report, log raw values.
5. **Citation correctness** — two-part custom metric (research doc §Recommended set #5). (a) *Validity*, deterministic: extract citations with the `CITATION_RE`/`SECTION_RE` idiom (`scripts/eval-kb.ts:65-67`); a citation is valid iff its (regdoc, section) matches a chunk in that answer's `data-sources` set under the section-prefix semantics of `scripts/eval-kb.ts:182-187`. Zero cost. (b) *Support*, judged: each claim carrying a citation is verified against the specifically cited chunk's full text.
6. **Consistency** — run-to-run ×5 at fixed settings: primary KPI = citation-set agreement (deterministic); plus normalized-text exact agreement (TARr, as a curiosity); judge-based answer-equivalence invoked ONLY for repeat pairs whose citation sets differ (cost control — deterministic-first). Paraphrase invariance: retrieval Jaccard of top-k chunk-id sets (from `data-sources`, production truth) vs the canonical phrasing, plus judged answer-equivalence rate.
7. **Negative rejection** — a probe response counts as a rejection SUCCESS iff it contains the canonical out-of-scope line (`lib/prompts.ts:85-86`) OR the low-confidence line (`lib/prompts.ts:82-83`) OR the request was blocked with HTTP 4xx (mirrors `scripts/eval-security.ts:148-167`). Any REGDOC/NSCA citation inside a rejection = fabrication = failure. False-rejection rate computed from the baseline run's golden answers.

**R8 — Answer harness** (generation-stage metrics run against the REAL production path): POST to `${EVAL_BASE_URL ?? http://localhost:3001}/api/knowledge-hub/query` with the UIMessage body of `scripts/eval-kb.ts:111-123`, `x-eval-bypass` header (`scripts/eval-kb.ts:133-135`), and — mandatory — `trigger: "regenerate-assistant-message"` so the Redis answer cache is bypassed and invalidated (`route.ts:246-251`); without it, consistency ×5 measures the cache, not the model. Extend the SSE parser of `scripts/eval-kb.ts:147-165` to ALSO capture the `data-sources` frame (`route.ts:587-590`). Sequential requests only (one in flight, like the existing runners' loops).

**R9 — Cost accountant.** ONE module through which every OpenAI call in the framework flows (golden gen, paraphrase gen, judge, relevancy embeddings): exact token counts from API `usage` fields; server-side answerer + embedding cost ESTIMATED with `tiktoken` (already a dependency, `package.json:51`) over envelope-sized input + measured response text at `gpt-4o-mini` / `text-embedding-3-small` prices. Price-per-token table lives in one const with a dated source comment. Runner aborts (finalize logs, exit non-zero, print what was spent and why) when actual+estimated total reaches `EVAL_COST_CAP_USD` (env, default 2 — I2.3). Per-run summary prints tokens + $ split three ways: answerer-estimated / judge / embeddings.

**R10 — Experiment runner** (`bun run eval:rag` → `scripts/rag-eval/run.ts`): `--experiment baseline|ksweep|consistency|paraphrase|negative`, `--only <ids>`, `--limit N` (smoke). Preflight BEFORE any OpenAI spend: dev server reachable, Supabase reachable (cheap `regdoc_chunks` count via anon RPC or service-role select), `EVAL_BYPASS_KEY` present when the experiment hits the server, golden-set fingerprints verified against the DB (Edge case 6). Per item, log the full record per research doc §Logging requirements: question/paraphrase/repeat ids, `PROMPT_VERSION` (`lib/prompts.ts:5`), retrieved chunk ids + ranks + similarities, answer text, extracted citations, per-metric scores WITH judge reasons, judge + answerer + embedding model ids, k/thresholds, timestamps, token/cost counters. Output: `evals/results/<UTC-timestamp>-<experiment>/items.jsonl` + `manifest.json` (models, config, golden-set hash, totals, `aborted` flag). An aggregate command (`bun run eval:rag:report` or a flag) folds one or more result dirs into the per-category 0–100% markdown table used by Slice 2.2.

**R11 — Wiring.** `package.json` scripts: `eval:rag`, `eval:rag:golden`, `eval:rag:report` (Bun only). `.gitignore`: add `evals/results/` and `evals/.judge-cache/` (datasets `evals/*.jsonl` stay committed). New env vars documented where env is already documented (README or `.env.example` if present): `EVAL_JUDGE_MODEL`, `EVAL_COST_CAP_USD` (reuse existing `EVAL_BASE_URL`, `EVAL_BYPASS_KEY`, `OPENAI_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; Bun auto-loads `.env.local`, no new env plumbing).

**Acceptance (2.1):**
- `bun run lint` + `bun run build` green; `bun run eval:kb` (ship) + `bun run evals:security` green post-refactor.
- `evals/rag-golden.jsonl` (70–80 records), `evals/rag-ooc-probes.jsonl`, `evals/rag-paraphrases.jsonl` committed; every gold chunk fingerprint verifies against the live DB.
- Smoke: `bun run eval:rag --experiment baseline --limit 5` completes end-to-end for < $0.25, writes `items.jsonl` + `manifest.json`, prints the three-way cost split; an immediate identical re-run shows judge cost ≈ $0 (cache hits).
- Research doc committed. Execution notes appended to this spec file and staged into the PR (executor contract §6).

### Slice 2.2 — Run the battery, commit the scored report

Run all five experiments as separate runs (each under its own cap; see Open choice 2 for the baseline's cap override):

| Experiment | Scope | Expected dominant cost |
|---|---|---|
| `baseline` | full golden set once at production settings (k=8) | judge (faithfulness + citation support + relevancy) |
| `ksweep` | retrieval-only via R2 trace at k ∈ {3,5,8,10}, full golden set | embeddings only — no answerer, no judge |
| `consistency` | full golden set ×5 repeats, fixed settings | answerer estimates; judge only on citation-disagreeing pairs |
| `paraphrase` | 20 questions × 3 paraphrases + canonical comparison | answerer + equivalence judge |
| `negative` | all OOC probes once | near-zero (mostly deterministic scoring) |

Then commit the report at `evals/rag-eval-report.md` (Open choice 3) plus a small `evals/rag-eval-summary.json` of the aggregate numbers. Report requirements:

- Headline table: one 0–100% score per category — retrieval quality (headline: hit rate@8), context precision (CP@8, with the k-sweep table), faithfulness, answer relevancy, citation correctness (headline: claim-support rate; validity reported alongside), consistency (headline: citation-set agreement over ×5), negative rejection (with false-rejection rate alongside). Each row also shows the expected/realistic range from research doc §Realistic score expectations WITH its citations (e.g. faithfulness 0.95+ gate for citation-critical domains; context recall ≥ 0.85; CP > 0.70; rejection baselines ~25–45% for vanilla LLMs; TARa high-90s target) and one sentence of interpretation.
- Methodology section: metric definitions (cite the research doc's sources — RAGAS docs, TruLens, IR-book, RGB, Zheng et al., arXiv consistency papers), golden-set construction and curation status, judge design (model, rubrics, temp 0, CoT-before-verdict, caching), and the deterministic/judged split.
- Caveats section (mandatory): anon-tier 800-token output cap shapes answers (`lib/validators.ts:11-15`); agent-curated golden set pending human review; ID-based precision strictness; judge nondeterminism (verdict flip rates per research doc); scores tied to `PROMPT_VERSION` at run time; corpus = 19 docs / ~1,945 chunks.
- Cost appendix: actual $ and tokens per experiment from manifests; judge-error counts per run (must be < 5% of judged items per Edge case 3, else the run is rerun or the category flagged unreliable in the report).

**Acceptance (2.2):** five result dirs exist locally with finalized manifests (`aborted: false`); report + summary JSON committed; every category has measured % + expected range + citation; total battery spend printed and stated in the report; `git status` shows no stray artifacts (results/cache dirs ignored). Lint + build green.

## Edge cases

1. **Paused Supabase project** (`supabase/RECOVERY.md`): preflight fails fast BEFORE any OpenAI spend and prints a pointer to the runbook. Do not diagnose "deleted" from NXDOMAIN — paused projects drop DNS too (runbook, first section).
2. **Rate limits / missing bypass**: without a matching `EVAL_BYPASS_KEY`, anon caps are 3/min + 5/day (`lib/guard.ts:35`) — the runner treats the FIRST 429 as fatal (abort with a message naming the env var), never retry-spins. Also: bypassed calls still increment the global daily OpenAI counter (`lib/guard.ts:295-307`) against `GLOBAL_DAILY_CAP=2000` (`lib/guard.ts:12`); a full battery burns ~500 of it, so the runner prints the counter's remaining headroom impact in the post-run summary and the report notes real users share this budget.
3. **Judge parse failures / disagreement**: unparseable judge JSON → one retry with a repair instruction; second failure → the item is marked `judge_error`, excluded from that category's denominator, and counted in the manifest; > 5% judge errors invalidates the run for that category. Where the deterministic citation-validity check and the judge's support verdict disagree, both sub-scores are reported separately — the deterministic result is authoritative for validity, the judge only ever scores support.
4. **OOC probes intercepted before the LLM**: probes tripping the deterministic jailbreak guard (`route.ts:290-313`) or the similarity OOS gate (`route.ts:497-507`) return the canonical out-of-scope text with NO `data-sources` frame and no LLM call. These are rejection SUCCESSES, never errors — the SSE parser must tolerate an absent `data-sources` frame everywhere, and the negative-experiment scorer treats guard-blocked, sim-gated, and LLM-refused identically (log which layer fired, from response shape: 4xx vs canonical-text-no-sources vs canonical-text-with-sources).
5. **`PROMPT_VERSION` changes** (`lib/prompts.ts:5`): the judge cache key includes the answer hash, so new answers self-invalidate cached verdicts — no manual flush needed; the Redis answer cache is keyed on `PROMPT_VERSION` (`route.ts:206`) AND bypassed by the regenerate trigger anyway. Every manifest records `PROMPT_VERSION`; the aggregator refuses to fold result dirs with differing `PROMPT_VERSION` into one report table unless `--mixed` is passed.
6. **Chunk-id drift after re-ingest**: `scripts/ingest.ts:314-320` wipes and re-inserts `regdoc_chunks`, reassigning BIGSERIAL ids. Preflight re-verifies every gold `chunk_id` against its fingerprint (`regdoc_id`, `chunk_index`, text hash); on mismatch it re-maps by fingerprint and reports; if fingerprints themselves fail (corpus content changed), abort and instruct regenerating the golden set. Never score against stale ids.
7. **Redis answer cache masking consistency**: covered by the mandatory regenerate trigger (R8); acceptance includes verifying two back-to-back identical questions return non-cache-served answers (the ×5 repeats would otherwise agree 100% trivially).
8. **Cost-cap abort mid-run**: `items.jsonl` is append-only and stays valid; the manifest is finalized with `aborted: true` and totals; the aggregator skips aborted runs unless `--allow-partial`.
9. **Golden question falls into a fallback branch**: if a golden question OOS-gates (raw top-1 < 0.4) or triggers the low-confidence disclaimer prefix (`route.ts:543-547`), retrieval metrics score it honestly (hit rate 0 if gold missing), the item is flagged `fallback_taken`, and generation metrics still run on whatever text was produced — no exceptions thrown, no silent skips.
10. **Judge/generator output containing hostile or malformed content**: generated golden questions are filtered through `detectJailbreakMarkers` (R3); answer text is treated as data everywhere (never re-prompted verbatim as instructions outside clearly delimited judge-input blocks).
11. **Truncated answers** (StreamingGuard termination, `route.ts:519-541`, or tier `max_tokens`): scored as-is — a truncated answer legitimately loses faithfulness/citation points; no special-casing, but note the anon 800-token cap in the report caveats.
12. **Dev server staleness after the R2 refactor**: turbopack hot-reloads `lib/` changes on the next request. NEVER restart/kill the dev server (house rule + memory: state-dir corruption). If behavior looks stale, make one probe request and re-check.
13. **Negative-cosine relevancy scores**: possible per RAGAS definition — clamp to 0 for reporting, keep raw in logs.
14. **UI/theme/mobile/auth-tier matrix**: N/A — this item ships no UI. Tier note: all eval traffic is anon-tier (no auth cookies), which is the production-representative worst case; the report says so.

## Invariants

From dispatch (verbatim):

- I2.1 Eval runs are manual `bun run` scripts — never part of lint/build gate or any CI.
- I2.2 Every experiment run writes a timestamped structured log under `evals/`; the scored report is committed.
- I2.3 Per-run cost tracking: token usage recorded, $ estimate printed + logged, and a hard per-run budget guard that aborts when a configurable cap is exceeded (Raj funds this out of pocket).
- I2.4 Metrics follow established definitions (RAGAS/TruLens-family: faithfulness, answer relevancy, context precision, context recall, plus consistency/robustness) with sources cited in the report; no invented metric names where a standard one exists.
- I2.5 No secrets committed; reuse the existing env-loading pattern.
- I2.6 Follows the existing eval conventions (`scripts/eval-kb.ts`, `scripts/eval-security.ts`, `evals/*.jsonl`).

Discovered during planning:

- I2.7 The R2 retrieval extraction is behavior-identical: route defaults equal today's constants, and `bun run eval:kb` (ship) + `bun run evals:security` stay green in the same PR.
- I2.8 The framework is read-only against the database: service-role usage is SELECT/RPC only; no INSERT/UPDATE/DELETE, no migrations, no re-ingest.
- I2.9 OOC probes intercepted by the deterministic guard or the similarity gate are scored as rejection successes, never as errors.
- I2.10 Golden records carry re-ingest-stable fingerprints alongside chunk ids; the runner refuses to score against unverified ids.
- I2.11 The dev server is never started, restarted, or killed by any eval code or executor; server interaction is HTTP-only against port 3001.
- I2.12 Every OpenAI call path in the framework flows through the single cost accountant; judge verdicts are disk-cached so re-runs cost cents.
  - **CORRECTION (fix round 1, issue 6):** the first clause holds (and is now enforced BEFORE each call, not after — issue 4). The second clause is FALSE as written for the scoring metrics: their cache keys on the answer hash, answers are non-deterministic, so a re-run of a server-backed experiment gets **zero judge-cache hits and pays full price**. The cache does hit for the golden/paraphrase GENERATORS (stable inputs) and for byte-identical repeats within a run. Kept verbatim above because it is dispatch text; the honest restatement lives in `### Fix round 1`.

## Open choices

1. **Retrieval-stage access** — (A) extract the route's retrieval into `lib/retrieval.ts` and have the route import it (spec is written for this): zero drift between what's measured and what ships, sweep-able k, testable; cost: an eval PR touches the production route. (B) re-implement retrieval eval-side from the anchors: no production diff, but silently drifts the next time someone tunes `route.ts`. **Lean: A** — drift in a measurement tool is worse than a mechanical refactor guarded by green kb/security evals.
2. **Slice 2.2 baseline budget** — with the default `gpt-4o` judge, the baseline run's judged metrics land around $2–4, at/over the $2 default cap. (A) keep the $2 default and have the orchestrator authorize `EVAL_COST_CAP_USD=4` for the baseline run only (whole-battery worst case ≈ $5–8; ~~re-runs cents via cache~~ — **FALSE, see fix round 1 issue 6: a re-run costs the same $5–8, the judge cache cannot hit on regenerated answers**). (B) validate a `gpt-4o-mini` judge against a ~30-item spot sample (research doc §Judge design allows validated downgrades, ~10× cheaper) and run everything under $2. **Lean: A** for the committed report's credibility; B documented as the cost-reduction path.
3. **Report path** — (A) `evals/rag-eval-report.md` next to the datasets and logs (I2.2 scopes eval artifacts under `evals/`); (B) `docs/`. **Lean: A.**

## Out of scope

- No CI/lint/build-gate wiring for any eval command (I2.1).
- No new npm dependencies — `openai`, `tiktoken`, `@supabase/supabase-js`, `zod` cover everything. No Python, no RAGAS/TruLens/DeepEval packages: implement the formulas per the research doc.
- No prompt, threshold, or retrieval-parameter tuning. Findings become recommendations in the report, not code changes.
- No re-ingesting the corpus, no schema changes, no migrations, no dashboard operations.
- No UI surface of any kind.
- Do not touch `docs/orchestration/specs/item-1-artifact-mode.md` or any artifact-mode files (parallel item).
- Do not commit raw per-item result logs or the judge cache — only the datasets, the report, and the summary JSON.
- Do not start/restart/kill the dev server; do not clear `.next/`.

## Execution notes (PR #8)

Slice 2.1 only. Written by the third executor on this slice — the first two died on
infra errors (usage limits / stream stalls) after pushing a checkpoint commit
(`135ea8b`, "wip(rag-eval): framework checkpoint pre-judge-module"). This section
inventories what the checkpoint contained and what this executor added, because a
reviewer reading the PR diff alone cannot tell the two apart.

### What the checkpoint already contained (verified, not rewritten)

- `lib/retrieval.ts` — the R2 extraction did NOT happen in this PR. It already existed
  from PR #6 (item-1), per the Resolved DELTA "retrieval access = reuse `lib/retrieval.ts`
  from PR #6 (never re-extract)". The checkpoint added three ADDITIVE things to it, all
  gated so production behavior is unchanged:
  - `RetrievalTrace` + `opts.withTrace` (DELTA D1) — the ranked pool with pre/post-boost
    ranks, expansions, `topSim`, and the fallback decision. Neither route sets `withTrace`,
    so neither pays for it.
  - `deriveEnvelopeAtK(trace, k)` — replays the route's own envelope selection at any k, so
    the k-sweep costs ONE embedding for four k values instead of four retrievals.
  - `deps.recordUsage?` (DELTA D2) — the OpenAI-call accounting hook, defaulting to
    `recordOpenAICall`. **This DELTA was already complete, not half-done**: the call site is
    `await (deps.recordUsage ?? recordOpenAICall)(0)` and both production routes omit the
    dep, so they keep the byte-identical default. This executor verified it rather than
    re-implementing it, and added the missing proof (below).
- `scripts/rag-eval/{config,cost,datasets,metrics,citations,sse}.ts` — config + price table,
  the cost accountant with `CostCapError`, dataset schemas + JSONL IO + fingerprint
  verification, the deterministic metrics (hit rate/MRR/recall/CP@K, TAR-style agreement,
  Jaccard, rejection scorer, cosine), citation extraction/validity, and the SSE parser
  extended to capture the `data-sources` frame. All of it correct on inspection; none of it
  was rewritten. `datasets.ts` already carried the `placeholder?: boolean` field, i.e. the
  prior executor had already hit the Supabase outage below.

### What this executor added

- **R6 judge** (`judge.ts`): `EVAL_JUDGE_MODEL` (default `gpt-4o`), temperature 0, JSON
  output, CoT `reasons` emitted BEFORE the verdict in every rubric (G-Eval), binary/0-3
  scales only, rubrics that explicitly neutralize verbosity bias and treat answer text as
  DATA (Edge case 10). Verdicts are disk-cached under `evals/.judge-cache/` keyed on
  sha256(judge model, metric id, `RUBRIC_VERSION`, question, answer hash, context hash) —
  a hit costs zero tokens. `PROMPT_VERSION` changes self-invalidate for free: a new prompt
  produces a new answer, which changes the answer hash (Edge case 5; there is a self-test
  check for exactly this). Unparseable/off-schema JSON → ONE repair retry → `judge_error`,
  uncached, excluded from that metric's denominator, counted in the manifest (Edge case 3).
  Judged metrics: faithfulness (RAGAS inferable-claim standard, judged against FULL chunk
  text fetched from the DB — the SSE snippet is truncated at 260 chars), citation support
  (R7 5b), relevancy reverse-questions, answer equivalence, plus golden/paraphrase
  generation and paraphrase meaning-equivalence validation.
- **R9 metering** (`openai.ts`): every framework OpenAI call flows through the accountant.
  `meteredOpenAI()` is a Proxy over the client handed to `retrieveChunks`, so retrieval's
  internal embedding spend is charged from its real `usage` field WITHOUT adding cost
  plumbing to `lib/retrieval.ts` (which the production routes share).
- **R8 answer harness** (`answer.ts`): POSTs the real route with `x-eval-bypass` and the
  mandatory `trigger: "regenerate-assistant-message"`; first 429 is fatal, never retried;
  answerer + server-embedding cost estimated with tiktoken. **Ships but is UNEXERCISED** —
  the dev server was down for this slice and I2.11 forbids starting it. Slice 2.2 is its
  first real execution.
- **Corpus access** (`supabase.ts`): read-only (I2.8) against `regdoc_chunks`; full
  `chunk_text` by id for judging; fingerprint verify/re-map so a re-ingest's BIGSERIAL drift
  can never silently mis-score (Edge case 6 / I2.10).
- **`headroom.ts`**: reads (never writes) the production `GLOBAL_DAILY_CAP` counter so every
  server-backed run prints its impact on the 2000-call budget real users share (Edge case 2).
- **R3/R5 generator** (`generate-golden.ts`) and **R4 probe set**
  (`evals/rag-ooc-probes.jsonl`, 23 probes: 19 out-of-corpus + 4 false-premise; verified that
  0 of them trip `detectJailbreakMarkers`, so they exercise the similarity gate / LLM refusal
  rather than short-circuiting at the request boundary).
- **R10 runner + aggregator** (`run.ts`, `report.ts`) and **R11 wiring** (`eval:rag`,
  `eval:rag:golden`, `eval:rag:report`, `test:rag-eval`; `.gitignore` for `evals/results/` +
  `evals/.judge-cache/`; the four eval env vars documented in `.env.example`).
- **`test:rag-eval`** — offline self-test, fixtures only, following `scripts/test-artifact.ts`
  conventions (throwing `fetch` stub, `check()` helper, exit 1 on any failure). 60 checks.

### Deviations (all small-call, logged per contract §2)

1. **Golden set + paraphrases shipped as PLACEHOLDERS** (spec D4 fallback, explicitly
   authorized). The Supabase project is paused again — NXDOMAIN on the REST host, the exact
   signature in `supabase/RECOVERY.md`. The generator's preflight aborted before spending a
   cent (**$0.00 actually spent**), which is Edge case 1 working as designed. Both files carry
   `placeholder: true` and the runner REFUSES to score them. `evals/rag-ooc-probes.jsonl` is
   real and complete — it needs no corpus access.
2. **Paraphrase generation lives inside `eval:rag:golden`**, not a separate script. Paraphrases
   are derived from the golden set, so a separate entry point could only ever run after it;
   one command keeps them in sync. Spec R5 does not name a command.
3. **Hand-written golden records carry an empty `ground_truth_answer`.** They are reused from
   `evals/knowledge-hub.jsonl`, which asserts *behavior* (must_cite / must_contain), not a
   reference answer. Their `gold_chunks` (resolved from `must_cite` + `must_cite_section` by DB
   lookup) are what the ID-based retrieval metrics need, and the generation metrics used here
   (faithfulness, relevancy) are reference-free. Fabricating a reference answer would have been
   worse than leaving it empty.
4. **Baseline retrieval metrics are computed from the `data-sources` frame**, not from an
   offline trace. That frame IS the envelope the LLM saw, so it is the more honest source; the
   offline trace is used for the k-sweep, where four k values must come from one embedding.
5. **`bun.lock` was left untouched.** `bun install` rewrote it (the committed lockfile carried
   stale `latest` specifiers against a pinned `package.json`), which is unrelated churn — this
   PR adds no dependencies, so the rewrite was reverted rather than committed.

### Proof of zero production drift (DELTA D2 / I2.7)

`bun run test:artifact` stays green — it drives the real `retrieveChunks` through the routes'
default path. On top of that, `test:rag-eval` §10 drives `retrieveChunks` with the eval path's
no-op `recordUsage` under a `fetch` stub that THROWS on any network call: `recordOpenAICall`
talks to Upstash over REST, so if the no-op were not honored, the check would fail loudly.
That is the executable proof that eval-path **retrieval** never increments the production daily
circuit-breaker. The same section also asserts that `deriveEnvelopeAtK(trace, k)` returns a
byte-identical envelope to a direct `retrieveChunks` at that `k`, for every k in {3,5,8,10} —
the k-sweep's cost optimization cannot silently change what it measures.

> **CORRECTION (fix round 1, issue 5).** D2 was over-claimed in this PR's original notes and in
> `headroom.ts`'s framing. The honest statement, in full: **retrieval-path calls are isolated**
> (no-op `recordUsage` → the production counter is never touched), **but the ANSWER harness runs
> the REAL production route and DOES consume the shared daily-cap budget, by design.**
> `x-eval-bypass` skips the circuit-breaker CHECK, not its INCREMENT — every server-backed
> question books ~2 calls against `GLOBAL_DAILY_CAP=2000`, which real users share. "The eval
> cannot touch the breaker" is false as a blanket claim; it is true only of the retrieval path.
> The framework knew the ~500-call figure but only read the counter in FINALIZE, i.e. after the
> spend. It now reads it in PREFLIGHT and refuses to start a run the headroom cannot absorb.

### What slice 2.2 must know

- **Un-pause Supabase first**, then `bun run eval:rag:golden`. Everything else is blocked on
  the golden set. Three rows are queued in `docs/orchestration/manual-verification.md`.
- The answer harness has never made a live request. Smoke it (`--experiment baseline --limit 5`)
  before committing to the full battery.
- The `gpt-4o` judge baseline will need `EVAL_COST_CAP_USD=4` (authorized in the backlog's
  Resolved DELTAs); every other experiment fits under the default 2.
- `ksweep` needs no dev server and no judge — it is embeddings-only and can run while the
  server is down.
- Cost-reduction path if the battery runs hot: validate a `gpt-4o-mini` judge against a ~30-item
  spot sample (research doc §Judge design allows validated downgrades, ~10× cheaper) — set
  `EVAL_JUDGE_MODEL`, and note that the cache key includes the model, so a downgrade does not
  reuse gpt-4o verdicts.

### Fix round 1

Applied against the 30-ballot adversarial review's VERDICT: REVISE. Every finding was a
**methodology** bug, and most of them would have made the committed report print a *flattering
percentage for the wrong reason*. A metric that reads 100% because it silently scores vacuous
cases as passes is worse than no metric — this round exists to make that impossible. Each fix
carries a regression test in `scripts/test-rag-eval.ts` (§§11-17) that was **mutation-tested**:
the fix was reverted, the suite was confirmed RED, the fix was restored. 12/12 mutations caught.

1. **Citation validity scored vacuous answers as perfect (CRITICAL).**
   `scoreCitationValidity` returned `score: 1` for an answer with ZERO citations, and
   `report.ts`'s `meanDefined` only drops null/undefined — so OOS refusals, low-confidence
   fallbacks, guard-blocked responses and empty answers were all averaged in as PERFECT citation
   validity. The "Citation validity (deterministic)" row would have read ~100% *precisely when
   citations disappeared*. Now: `score: null` (EXCLUDED from the mean, never a pass) plus a
   companion `hasCitations` → a new **"Citation coverage (answers carrying ≥ 1 citation)"** row
   over the FULL denominator. Both are in the per-item JSONL (`citation_validity`,
   `citation_coverage`, `citation_count`) and the aggregated table. Zero-citation-ness is now
   visible in the report, never silently a pass.

2. **The low-confidence / disclaimer sentinels matched a string the app never emits.**
   `scoreRejection` and `run.ts`'s `fallbackTaken` detected the "low-confidence branch" by
   matching `KNOWLEDGE_HUB_LOW_CONFIDENCE`. Nothing in the app emits that on that branch: the
   route's low-avg-similarity branch emits its own hardcoded literal, and
   `KNOWLEDGE_HUB_LOW_CONFIDENCE` is what the *model* is told to say (system-prompt answer rule
   4). Two different events, conflated, so both were measuring nothing. Also, `scoreRejection`
   claimed to mirror `eval-security.ts`'s `grade()` but did a case-SENSITIVE exact match where
   `grade()` deliberately matches LOWERCASED SUBSTRINGS — a re-cased or prose-wrapped model
   refusal scored as "answered_instead_of_rejecting", i.e. a false FAILURE that would have made
   the negative-rejection row read low for the wrong reason. Fixed at the source:
   `KNOWLEDGE_HUB_LIMITED_CONTEXT` now lives in `lib/prompts.ts` and the route **imports** it
   (byte-identical emission — the delta is unchanged, `test:artifact` + `lint` + `build` stay
   green); the lowercased markers (`REFUSAL_MARKER`, `LOW_CONFIDENCE_MARKER`,
   `LIMITED_CONTEXT_MARKER`) are shared from `lib/prompts.ts`, and `eval-security.ts` now imports
   them instead of holding a second copy. `classifyBranch()` reports the four branches the app can
   actually take (`oos_or_guard` / `llm_refusal` / `low_confidence` / `limited_context`). The
   limited-context disclaimer is **not** a refusal — the model still answers — so it no longer
   inflates the false-rejection rate.

3. **The cost accountant under-counted the answerer 4-6× (WALLET).** `chargeAnswer` estimated the
   answerer's input from `sources[].snippet` — but `snippet` is the SSE *display* projection
   `chunk_text.slice(0, 260)`, while the model's real prompt carries the FULL ~400-token
   `chunk_text` via `buildContextEnvelope`. Real spend systematically exceeded what
   `EVAL_COST_CAP_USD` bounded. Now the harness re-fetches the full chunk text by id and
   reconstructs the REAL prompt with the production `buildContextEnvelope`. Every component it
   cannot observe is charged with a documented factor that **errs high**: unresolvable chunks at
   `SNIPPET_TO_FULL_CHUNK_FACTOR` (7), the route's embedding expansions at
   `EMBED_INPUT_MULTIPLIER` (5). Wallet protection fails safe: the estimate may over-state spend,
   never under-state it.

4. **The cost cap fired after the spend, and the abort was swallowed (WALLET).**
   (a) `CostAccountant.record()` pushed the entry and *then* threw — it aborted after the money
   was gone. Added `reserve()` / `wouldExceed()`: every call site now checks the PROJECTED total
   **before** the call leaves the process (judge completions, embeddings, and — critically — each
   server answer, whose spend happens inside the dev server where a post-hoc `record()` is
   useless). `record()` remains as the actuals ledger.
   (b) A `CostCapError` raised inside an eval retrieval embedding gets wrapped by
   `lib/retrieval.ts` into `RetrievalError("embedding", err)`, so the runners'
   `err instanceof CostCapError` checks MISSED it, rethrew, and skipped the finalize block: no
   `manifest.json`, no cost totals, and the operator saw `retrieval_failed:embedding` — which
   reads like an *outage* and invites a re-run, i.e. MORE spend. `asCostCapError()` walks the
   cause chain, so a cap trip always lands in the normal aborted-run finalize path.

5. **The battery could circuit-break production for real users (WALLET/PROD).** The answer harness
   POSTs the REAL route (correct — generation metrics must score the real path), and
   `recordOpenAICall` increments the shared `GLOBAL_DAILY_CAP=2000` counter even for
   `EVAL_BYPASS_KEY` calls: the bypass skips the CHECK, not the INCREMENT. The framework knew a
   battery burns ~500 of that budget but only called `readHeadroom()` in FINALIZE — reporting the
   damage after doing it. `readHeadroom()` now runs in PREFLIGHT: the run prints its projected
   server-call count and the remaining headroom, and **aborts before any spend** if the headroom
   cannot absorb it. An unreadable counter warns loudly but does not block (a Redis outage is not
   a breach). See also the D2 correction above — this is the same overclaim, from the other end.

6. **The judge cache could never hit, while the cost model claimed it did. → Chose: KEEP the
   cache, DELETE the false claim.** The scoring metrics key on `sha256(answer_text)`, but the
   answer harness hardcodes `trigger: "regenerate-assistant-message"` (mandatory, to defeat the
   Redis answer cache) against a non-deterministic answerer — so every run produces new answer
   text, new hashes, and **zero cache hits**. "Re-runs cost cents" was false.
   *Why not a stable key:* a faithfulness verdict is a judgement about a SPECIFIC answer. Keying
   it on (question + retrieved-chunk-id-set + metric) would reuse answer A's verdict to score
   answer B — a flattering-for-the-wrong-reason metric of exactly the kind this item exists to
   stamp out. No stable key is *sound* for faithfulness, citation support, relevancy, or answer
   equivalence, so none was invented.
   *What the cache actually saves (kept, because this part is real):* the golden/paraphrase
   **generators** key on stable inputs (chunk text, question text — no model output), so
   `eval:rag:golden` re-runs really are ~free for anything already generated; and byte-identical
   repeats within a run hit. **Honest re-run cost: a re-run of a server-backed experiment costs
   FULL judge price — the same $2-4 baseline / ~$5-8 whole battery as the first run, every time.**
   The false claim is struck from R6, I2.12, and Open choice 2 above, and from `judge.ts`.

7. **Rank-sensitive metrics were computed over a list that was never ranked.** MRR and context
   precision are POSITIONAL, but the baseline read `rankedIds = sources.map(s => s.id)` from the
   `data-sources` frame — whose order is the DIVERSITY-REORDERED envelope
   (`selectDiverseEnvelope`, plus the named-doc boost), not similarity rank. They now come from
   the true cosine-similarity ranking of the candidate pool via the additive `RetrievalTrace` /
   `withTrace` seam (`similarityRankedIdsFromTrace`, sorting on `rankPreBoost`) — the seam exists
   precisely for this. The traced retrieval is offline (no-op `recordUsage`, so it never touches
   the production counter) and costs one embedding per baseline question.
   Separately: on the OOS branch the route emits NO `data-sources` frame while retrieval still
   ran, so `sources === null` → `rankedIds = []` → hit-rate/recall scored a silent **0**. Those
   items are now EXCLUDED (null) from retrieval-quality means with an explicit
   `retrieval_excluded_reason`, and the exclusion is counted and printed. Silent zeros are as
   dishonest as silent ones — both directions are now visible.
   *Scope note:* the `ksweep` rows remain positional over the ENVELOPE the route would select at
   each k, because that selection IS what the sweep measures. `report.ts` now discloses this
   distinction in the output rather than leaving the reader to assume otherwise.

**Report honesty (cross-cutting).** `report.ts` now emits an `n` (samples counted) AND an
`Excluded (why)` column on every aggregated row, a branch census for the baseline, and a
"Production budget impact" section. A metric that cannot be honestly computed prints `n/a` — it is
never given a number. `report.ts` is now importable (`import.meta.main`-guarded), so the
aggregation itself is unit-tested: §13 asserts that a run in which nothing is measurable prints
`n/a` over `n=0` rather than a flattering percentage.

**Still open / for slice 2.2.** `docs/orchestration/backlog.md`'s Resolved DELTAs line still says
"judge cache makes re-runs cents" — same false claim as issue 6, in a file this item does not own.
The steward should strike it.
