# Best-practices corpus expansion

Adds regulatory **best-practice** guidance documents to the knowledge-hub RAG
corpus so the assistant can answer "how do I actually comply" questions — e.g.
*how to safely store radioactive waste*, *what environmental monitoring is
required* — not just "what does REGDOC-X say."

**Status:** prepared for review. The production Supabase corpus is **NOT**
modified by this PR — everything was built and validated against a local
Supabase. Loading production is a separate, supervised step (see
[Runbook](#runbook-supervised-production-load)).

## What was added

| Layer | Publisher | Count | License | In this PR |
|---|---|---|---|---|
| **Ingested** | CNSC REGDOCs (best-practice/guidance) | **26 new docs** | Crown Copyright, non-commercial OK ✅ GREEN | fetched + local-ingested + eval'd |
| Reference-only | IAEA Safety Standards & Guides | 16 | Copyright; excerpt-only ⚠️ YELLOW | manifest bibliography only (see below) |
| Follow-up | US NRC Regulatory Guides / NUREGs | 15 | US-gov public domain ✅ GREEN | fetched + segmenter validated; **not ingested** (needs integration, below) |

The 26 CNSC docs span every Safety and Control Area — waste management &
decommissioning (REGDOC-2.11, 2.11.1-VolII/III, 2.11.2), radiation protection &
dosimetry (2.7.2-VolI/II, 2.7.3, 1.6.2), environmental protection & effluent
monitoring (2.9.2), safety analysis (2.4.2 PSA, 2.4.3 criticality, 2.4.4, 2.4.5),
security (2.12.2), packaging & transport (2.14.1-VolI/II), human performance &
fitness-for-duty (2.2.1, 2.2.3-VolI/III, 2.2.4-VolI/II), conduct & operations
(2.3.1, 2.3.3), reliability & maintenance (2.6.1, 2.6.2), and safety culture
(2.1.2).

Corpus grew **19 → 45 documents, ~1,945 → 3,394 chunks** (local, verified: 0
NULL embeddings, atomic swap clean; 3,394 is after the boilerplate-section drop
described in the eval section — 175 near-identical front/back-matter chunks
removed).

The full, license-annotated source list is committed at
[`resources/best-practices-sources.json`](../resources/best-practices-sources.json)
— it is the source of truth for the fetcher and the reviewable licensing record.

## How it was built

1. **`scripts/fetch-best-practices.ts`** downloads each manifest source and emits
   `scraped_regdocs/*.json` in the exact schema `scripts/ingest.ts` already
   consumes. Two extraction paths:
   - **CNSC** (`source: "cnsc"`): the CNSC site is a Gatsby SPA (raw HTML is a JS
     shell), so we fetch the page-data JSON and parse `result.data.mdx.body` —
     clean document HTML. We capture `<p>` **and** `<li>`/table cells because most
     "shall/must" requirements live in bulleted lists.
   - **PDF** (`source: "pdf"`, NRC/IAEA): download + `unpdf` text extraction, then
     sentence-split with heading detection (validated against real NRC Regulatory
     Guides: it recovers INTRODUCTION / DISCUSSION / REGULATORY POSITION /
     IMPLEMENTATION structure).
   Only GREEN-verdict, `ingest: true` rows are fetched; RED never; YELLOW only
   with `--allow-yellow`. A quality gate rejects garbled extractions (≥2 sections,
   ≥5 paragraphs, ≥1500 chars, alpha ratio ≥ 0.6).
2. `scripts/ingest.ts` (unchanged) chunks → embeds (text-embedding-3-large@3072)
   → atomic-swaps into `regdoc_chunks`. Run against **local** via inline env.

## Eval evidence

Two measurements against the local expanded corpus (`bun run eval:rag --experiment
ksweep`, offline; and the new best-practices probe). **No production traffic.**

All numbers below are committed in
[`evals/best-practices-eval-results.json`](../evals/best-practices-eval-results.json)
and reproducible via `bun run eval:rag --experiment ksweep` and `bun run
scripts/rag-eval/probe-best-practices.ts` against a local corpus.

### 1. Naive ingestion regressed retrieval on existing questions — and only the boilerplate fix partly recovered it

Same 92 golden questions, identical retrieval thresholds and query expansions
across runs (verified per-question), so this is a clean corpus-only comparison:

| Metric | Baseline (19-doc) | Expanded, unfiltered (45-doc) | Expanded, boilerplate-filtered (45-doc) |
|---|---|---|---|
| hit rate@3 | 88.0% | 87.0% | 87.0% |
| hit rate@5 | 92.4% | 90.2% | 90.2% |
| hit rate@8 | **96.7%** | **91.3%** | **93.5%** |
| hit rate@10 | 97.8% | 93.5% | 94.6% |
| context recall@8 | 86.0% | 80.8% | 83.6% |
| MRR | 80.8% | 77.9% | 78.1% |

**This is a real, one-directional regression — not a measurement artifact.**
Dropping 26 new documents into the corpus lowered hit@8 by 5.4 points, and
**zero of the 92 questions improved on any metric at any k** while ~15 degraded.
A monotonic, zero-improvement shift is the signature of *distractor injection*,
not neutral corpus growth. Two systematic causes (from per-question inspection of
the displacing chunks):

1. **"§1.3 / front-matter" boilerplate collision (the dominant cause).** Every
   CNSC REGDOC opens with near-identical administrative sections — Preface, "1.3
   Relevant legislation" (the same NSCA/regulation list verbatim), the
   document-series blurb. Adding 26 of them created 26 near-duplicate low-signal
   chunks that broad queries collapse onto, shoving substantive gold chunks past
   `k`. ~10 of the 92 questions ended up with ≥4 of their top-8 being generic
   "§1.3" intros.
2. **REGDOC-2.14.1 (Packaging & Transport) is an over-broad distractor** that
   intruded into the top-8 of several unrelated queries (radiation protection,
   record-keeping), off-topic.

**Mitigation applied:** the fetcher now drops the near-identical front/back-matter
sections from the new docs (`DROP_SECTION_TITLE_RE` in
`scripts/fetch-best-practices.ts`). That recovered **~half** the hit@8 drop
(91.3 → 93.5) and recall@8 (80.8 → 83.6), and removed 175 boilerplate chunks
(3,569 → 3,394). **But a residual regression remains: 12 questions still degrade
vs baseline, 0 improve.** This residual is genuine cross-doc competition on broad
queries plus the 2.14.1 distractor — it is NOT resolved, and is NOT just
frozen-golden staleness.

### 2. New content is retrievable — best-practices probe (a weak, isolation-only check)

`bun run scripts/rag-eval/probe-best-practices.ts` over 18 hand-authored
best-practice questions (`evals/best-practices-probes.jsonl`): **expected-doc
hit@8 = 16/18 (88.9%)**, top-1 10/18. The 2 misses (bp001, bp018) retrieved a
sibling volume of the same series.

Read this as weak evidence only. Each probe is an on-the-nose paraphrase of one
target doc's *title*, so it tests retrievability **in isolation** and is
structurally incapable of detecting the cross-doc competition the ksweep exposes
— indeed the radiation-protection probes (bp006–008) "pass" while the
near-identical *golden* question h006 ("radiation protection requirements for
workers") **fails** at k=8. The probe covers only 18 of the 26 new docs. It
confirms the content is present and findable; it does **not** show the corpus is
net-positive.

### What this eval could NOT establish overnight

- **Generation quality** (Faithfulness, Answer relevancy, Citation support) —
  requires a dev server pointed at the local corpus. The running dev server
  (`:3001`) reads `.env.local` at boot (→ production) and per repo rules must not
  be restarted, so the server-backed experiments were **not** run. Only the
  offline `ksweep` ran locally. So whether the residual retrieval shift actually
  degrades *answers* is unmeasured.

## Recommendation

**Do not load this corpus to production as-is.** The content is high quality and
license-clean, but naive ingestion measurably regresses retrieval on broad
existing queries, and the boilerplate fix only halved that — a residual
one-directional regression (12 degraded / 0 improved) remains. Before any prod
load:

1. Run the generation eval (dev server against local — see runbook) to see whether
   the residual retrieval shift actually harms answers, or whether the model still
   answers correctly from the retained relevant chunks.
2. If answers hold, load. If they degrade, address the residual first — candidates:
   demote/dedupe the over-broad REGDOC-2.14.1 chunks, tune the envelope `k` or
   `MIN_CHUNK_SIM`, or regenerate the golden set against the expanded corpus for a
   fair re-measure — **each validated by the generation eval, never blind.**

This is a supervised decision. The overnight run's job was to gather the data, make
it loadable, and measure honestly — the measurement says "not yet."

## Runbook (supervised production load)

Prerequisites: local Supabase running (`bun run db:local`), `.env.local` present.

1. **Fetch** the CNSC corpus locally (writes gitignored `scraped_regdocs/*.json`):
   ```bash
   bun run scripts/fetch-best-practices.ts --source=cnsc
   ```
2. **Validate on local** (never prod) — ingest + probe + ksweep:
   ```bash
   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
   SUPABASE_SERVICE_ROLE_KEY=$(bunx supabase status -o env | grep '^SERVICE_ROLE_KEY=' | cut -d'"' -f2) \
   bun run ingest
   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
   SUPABASE_SERVICE_ROLE_KEY=$(bunx supabase status -o env | grep '^SERVICE_ROLE_KEY=' | cut -d'"' -f2) \
   bun run scripts/rag-eval/probe-best-practices.ts
   ```
3. **Generation eval** (the step overnight could not do): boot a *second* dev
   server against local on a spare port and point the eval at it (does not touch
   your `:3001`):
   ```bash
   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
   SUPABASE_SERVICE_ROLE_KEY=$(bunx supabase status -o env | grep '^SERVICE_ROLE_KEY=' | cut -d'"' -f2) \
   EVAL_BYPASS_KEY=<key> bun run start -p 3002 &   # or `dev`
   EVAL_BASE_URL=http://localhost:3002 EVAL_BYPASS_KEY=<key> \
   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
   SUPABASE_SERVICE_ROLE_KEY=$(...) bun run eval:rag --experiment baseline
   ```
   Compare Faithfulness / Citation support / negative-rejection to the committed
   baseline. Regenerate the golden set for a fair retrieval number if desired
   (`bun run eval:rag:golden`, which **overwrites** `evals/rag-golden.jsonl`).
4. **Load production** — only when satisfied. This TRUNCATE-and-REFILLs the live
   corpus via the atomic staged swap (safe: rolls back on any failure):
   ```bash
   bun run ingest --force            # or ALLOW_REMOTE_INGEST=1; .env.local → hosted
   ```
5. Smoke-test https://npx.curlycloud.dev with a best-practice question.

## Follow-up: NRC + IAEA (not in this PR's corpus)

The manifest and fetcher already support these; ingesting them is deferred because
it needs a coherent **source-aware integration** that touches user-facing
rendering and the security prompt — too much to land unsupervised. Required work
(spec in `OVERNIGHT.md`):

- **Citation plumbing** — every citation regex and the artifact source-link gate
  is `REGDOC-`/CNSC-hardcoded; NRC ids would render as plain text, lose links, and
  be mislabeled "cnsc-ccsn.gc.ca". Generalize the id grammar, switch the artifact
  link-gate to a trusted-domain allowlist (cnsc-ccsn.gc.ca, nrc.gov), derive the
  publisher at read time, parameterize labels.
- **Prompt security boundary** — the prompt currently refuses "non-Canadian
  regulation" outright, so NRC questions would be refused or misattributed. This
  must be rewritten to name CNSC + NRC in-scope **without weakening the
  prompt-injection hardening** (`bun run evals:security` must stay green) — a
  security-sensitive change that warrants human review.
- **Threshold recalibration** — OOS/similarity thresholds were tuned on the
  CNSC-only corpus; a cross-jurisdiction corpus needs `scripts/probe-sims.ts` +
  ksweep re-run and possible retune to avoid confident wrong-jurisdiction answers.
- **Eval** — the negative set encodes "NRC/IAEA = out of corpus"; those probes
  must be relabeled and new-jurisdiction probes added once NRC is in-corpus.

**IAEA is reference-only by license.** IAEA permits *excerpts in teaching
material* with a "© IAEA, year, page, DOI/URL" citation, but storing full
publications in a corpus requires prior written permission from the IAEA
Publishing Section. The 16 IAEA guides are kept as a curated bibliography in the
manifest; full-text ingestion is a decision for you (email IAEA for
non-commercial permission, or keep them reference-only).
