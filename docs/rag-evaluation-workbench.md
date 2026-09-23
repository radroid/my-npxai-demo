# RAG evaluation workbench

Use a **paired baseline/candidate run on the same questions and settings**. Keep
the production corpus untouched: this workbench ingests candidate variants into
local Supabase only. The question set is small (92 golden questions), so treat
percentage changes as diagnostic evidence, not a statistically precise estimate
of future user traffic.

## Fast loop

1. Start the local database with `bun run db:local` if it is not already
   running. Set `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` and
   `SUPABASE_SERVICE_ROLE_KEY` to the **local** service-role key for ingestion and
   eval commands; leave `.env.local` unchanged. Check the URL before every
   ingest. The ingest refuses non-local URLs without `--force`.
2. For a corpus ablation, create an empty directory outside `scraped_regdocs`
   and prepare the shared-series variant:

   ```bash
   variant_dir=$(mktemp -d /tmp/npx-rag-series.XXXXXX)
   bun run eval:rag:prepare-series --out-dir="$variant_dir"
   bun run ingest --source-dir="$variant_dir" --dry-run
   bun run ingest --source-dir="$variant_dir"
   ```

   The output contains 45 transformed REGDOC JSONs plus
   `_shared-series-reference.json` with every source wording and URL; underscore
   files are not ingested. A checked-in copy of that single reference is
   [`resources/cnsc-series-reference.json`](../resources/cnsc-series-reference.json);
   regenerate it by adding `--reference-file=resources/cnsc-series-reference.json`
   to the preparation command. The script changes **only** the exact-titled *CNSC
   Regulatory Document Series* section. It never strips *additional* Preface or
   §1.3 text; the existing fetcher already removed some from the 26 new docs.
3. Run a cheap retrieval check, then compare it with a saved baseline run:

   ```bash
   bun run eval:rag --experiment ksweep --only=h006,s006,s007,s020
   bun run eval:rag:compare \
     --baseline=evals/results/2026-07-15T07-23-12-803Z-ksweep \
     --candidate=evals/results/<new-run>-ksweep \
     --only=h006,s006,s007,s020
   ```

   Replace `<new-run>` with the directory printed by the runner. `ksweep` uses
   real query embeddings and local vector retrieval, but no answer-generation
   judge. It writes a per-question `items.jsonl` and `manifest.json` under
   gitignored `evals/results/`. The comparator reads saved logs only, checks
   matching golden-set hash, embedding model, `k`, thresholds, and question IDs,
   then reports paired hit@8, context recall@8, MRR, gold reachability after
   filtering, and transport occupancy.

For the 91-question comparable set, use `--exclude=h003` on **both** `ksweep`
and `eval:rag:compare`. The current h003 gold set includes one generic overview
chunk removed by this ablation; the original 31-chunk annotation needs review
before it can fairly score this variant. Do not quietly score that missing gold
chunk as a model failure or replace the reference set simply to improve a score.

## Diagnose the stage that failed

| Stage | Quick check | What a failure suggests |
|---|---|---|
| Source/extraction | Compare document/section counts, text, source URLs, and chunk counts in `--dry-run` | Missing or malformed content; extraction/chunking issue |
| Embedding/index | Confirm every staged row has an embedding and the atomic swap row count matches; inspect source fingerprints | Index/input mismatch, not a ranking-tuning problem |
| Candidate retrieval | Inspect `stages.raw_ranked_ids` and `stages.post_filter_ranked_ids` in an item log | Gold absent from raw candidates: retrieval/query problem; present before but absent after filter: threshold problem |
| Context selection | Compare `pool`, `k_sweep.k8`, hit@8 and context recall@8 | Gold eligible but displaced from the eight snippets shown to the model: ranking/diversity/boosting or `k` problem |
| Answer + citations | Run `bun run eval:rag --experiment baseline --only=<ids>` **only with a dev server configured for this same local corpus** | Good context but wrong answer/citation: generation problem; no matching context: upstream retrieval problem |
| Guard/refusal | Run `bun run eval:rag --experiment negative`, plus paraphrase/consistency as needed | False refusals, false acceptance, or instability; review the actual response, not only a score |

The server-backed experiments need `EVAL_BASE_URL`/`EVAL_BYPASS_KEY`, consume
OpenAI calls, and must never be aimed accidentally at the hosted-production
server while interpreting results as local-corpus results. This repo's running
dev server must not be restarted by an agent; arrange a supervised local-server
run when ready. `bun run eval:rag:report <run-dir>` summarizes scored runs.

## Evaluation practice

The current harness already covers retrieval hit/recall/precision/MRR,
faithfulness, answer relevance, citation support/coverage, negative rejection,
paraphrases, and consistency. Keep those. The bigger improvement is a small,
**human-reviewed challenge set** of actual operator questions with acceptable
answers, allowed sources, required citations, and when the system must abstain.
Include broad and narrow questions, document/version ambiguity, transport vs
facility radiation-protection scope, multi-document answers, and plausible
out-of-corpus claims. Review false positives and false negatives by slice; do
not rely on one overall percentage. Freeze a holdout set while tuning on a
separate development set, and calibrate any model judge against human judgments.
Before production load, independently test restoring the new documents' §1.3
and Preface sections: the current title-based fetcher filter removed them
without establishing that their content was duplicate or answer-irrelevant.

Relevant frameworks: [RAGAS](https://arxiv.org/abs/2309.15217) separates
context and answer quality; [ARES](https://arxiv.org/abs/2311.09476) emphasizes
calibration with human annotations; [RAGChecker](https://arxiv.org/abs/2408.08067)
breaks failures down to claims; [LangSmith evaluation types](https://docs.langchain.com/langsmith/evaluation-types)
shows offline regression sets and online trace-review workflows. None requires
replacing this repo's evaluation code immediately.
