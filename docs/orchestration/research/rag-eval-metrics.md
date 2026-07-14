# RAG Evaluation Metrics — Research Synthesis

Synthesized from three research sweeps (framework docs, academic literature, industry practice) as of 2026-07-13.
Target pipeline: `text-embedding-3-small` + pgvector top-k retrieval + `gpt-4o-mini` answerer with mandatory citations, over 15 CNSC REGDOCs (~400-token chunks).

Framework versions referenced: **ragas 0.4.3** (2026-01-13, repo now `vibrantlabsai/ragas`), **trulens 2.8.1** (2026-05-14, Snowflake; `trulens-eval` deprecated since 1.0), **deepeval 4.1.0** (2026-07-12, Confident AI). All Python >= 3.9.

---

## Metric catalog

| Metric | One-line definition | How it is computed | Ground truth? | Source(s) |
|---|---|---|---|---|
| **Faithfulness** (RAGAS) | How factually consistent the response is with the retrieved context | LLM judge decomposes response into claims, checks each for inferability from retrieved context; score = supported claims / total claims (0–1, higher better) | No | [RAGAS Faithfulness](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness/) |
| **Faithfulness** (DeepEval) | Same family, laxer standard: claims must merely not contradict the retrieval context | LLM extracts claims from `actual_output`, verdicts vs `retrieval_context`; score = truthful claims / total claims | No | [DeepEval Faithfulness](https://deepeval.com/docs/metrics-faithfulness) |
| **Groundedness** (TruLens triad) | Response "avoids straying from facts" in retrieved context | Response split into sentences, trivial statements filtered, judge searches context for evidence per claim (CoT reasons variant returns score + reasons); judge scores normalized to 0–1 | No | [TruLens RAG Triad](https://www.trulens.org/getting_started/core_concepts/rag_triad/), [LLMProvider ref](https://www.trulens.org/reference/trulens/feedback/llm_provider/) |
| **Answer / Response Relevancy** (RAGAS) | How well the response addresses the intent of the question (NOT factual accuracy) | LLM generates N artificial questions from the response (default N=3); score = mean cosine similarity of their embeddings vs the original question embedding. Needs an embedding model; nominally 0–1 (cosine can go negative) | No | [RAGAS Answer Relevance](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/answer_relevance/) |
| **Answer Relevancy** (DeepEval) | Fraction of response statements relevant to the input | LLM extracts statements from output, classifies each vs input; relevant / total | No | [DeepEval Answer Relevancy](https://deepeval.com/docs/metrics-answer-relevancy) |
| **Answer Relevance** (TruLens triad) | Final response helpfully addresses the original question | LLM judge scores response vs query on a configurable integer scale (0–3 or 0–10), normalized to 0–1; `_with_cot_reasons` variants emit reasoning | No | [TruLens RAG Triad](https://www.trulens.org/getting_started/core_concepts/rag_triad/) |
| **Context Relevance** (TruLens triad) | Each retrieved chunk is relevant to the query | Judge scores each chunk vs query; per-chunk scores aggregated with a user-chosen numpy aggregator (e.g. `np.mean`) | No | [TruLens RAG Triad](https://www.trulens.org/getting_started/core_concepts/rag_triad/) |
| **Context Precision** (RAGAS) | Retriever's ability to rank relevant chunks above irrelevant ones | CP@K = Σₖ (Precision@k × vₖ) / (relevant items in top K), vₖ ∈ {0,1}. Variants: LLM with-reference (needs gold answer), LLM without-reference (judged vs generated response), non-LLM string similarity, ID-based (matched IDs / retrieved IDs — zero judge cost) | With-reference & ID variants: yes; without-reference: no | [RAGAS Context Precision](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/) |
| **Contextual Precision** (DeepEval) | Rank-weighted precision of retrieved nodes judged against the ideal answer | (1/relevant nodes) × Σₖ [(relevant up to k / k) × rₖ]; judge decides node relevance using `expected_output` | Yes (`expected_output`) | [DeepEval Contextual Precision](https://deepeval.com/docs/metrics-contextual-precision) |
| **Context Recall** (RAGAS) | How much answer-relevant information the retriever actually fetched | LLM breaks the *reference answer* into claims, attributes each to retrieved context; supported / total. Non-LLM variant: retrieved reference contexts / total reference contexts; ID-based variant compares chunk IDs | Yes | [RAGAS Context Recall](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/) |
| **Contextual Recall** (DeepEval) | Whether every statement of the ideal answer is attributable to retrieved context | LLM extracts statements from `expected_output`, classifies attributability; attributable / total | Yes (`expected_output`) | [DeepEval Contextual Recall](https://deepeval.com/docs/metrics-contextual-recall) |
| **Contextual Relevancy** (DeepEval) | Signal-to-noise of the retrieved window | LLM extracts statements from `retrieval_context`, classifies relevance to input; relevant / total | No | [DeepEval Contextual Relevancy](https://deepeval.com/docs/metrics-contextual-relevancy) |
| **Answer Correctness** (RAGAS) | Agreement of the answer with the ground-truth answer | Weighted avg of claim-level F1 (TP = claims in both; F1 = TP / (TP + 0.5(FP+FN))) and embedding similarity; default weights [0.75 factual, 0.25 semantic] | Yes | [RAGAS Answer Correctness](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/answer_correctness/), [source](https://github.com/explodinggradients/ragas/blob/main/src/ragas/metrics/_answer_correctness.py), [issue #1040](https://github.com/vibrantlabsai/ragas/issues/1040) |
| **Noise Sensitivity** (RAGAS) | How often the system emits incorrect claims when using relevant or irrelevant retrieved docs (LOWER is better) | Extract claims from response, verify vs ground truth + contexts; incorrect claims / total claims. Modes: `relevant` (default) and `irrelevant` | Yes | [RAGAS Noise Sensitivity](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/noise_sensitivity/) |
| **Recall@k** | Fraction of relevant documents present in the top-k | \|relevant ∩ retrieved@k\| / \|relevant\|; with one gold chunk per question, equals hit rate@k | Yes (relevance labels) | [IR-book ch.8](https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-ranked-retrieval-results-1.html), [Wikipedia](https://en.wikipedia.org/wiki/Evaluation_measures_(information_retrieval)) |
| **Precision@k** | Fraction of top-k results that are relevant | relevant docs in top k / k | Yes | [IR-book ch.8](https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-ranked-retrieval-results-1.html) |
| **Hit rate@k** (success@k) | Whether at least one correct chunk appears in the top-k | Per query: 1 if gold chunk ∈ top k else 0; averaged over queries (LlamaIndex `hit_rate`) | Yes | [OpenAI cookbook](https://developers.openai.com/cookbook/examples/evaluation/evaluate_rag_with_llamaindex), [LlamaIndex retrieval eval](https://docs.llamaindex.ai/en/stable/module_guides/evaluating/usage_pattern_retrieval/) |
| **MRR** | Rewards putting the first relevant chunk near the top | Mean over queries of 1/rank of the first relevant document (rank 1 → 1.0, rank k → 1/k, missing → 0) | Yes | [IR-book ch.8](https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-ranked-retrieval-results-1.html), [OpenAI cookbook](https://developers.openai.com/cookbook/examples/evaluation/evaluate_rag_with_llamaindex) |
| **nDCG** | Rank quality with graded relevance support | DCGₚ = Σᵢ relᵢ / log₂(i+1); nDCG = DCG / IDCG (perfect ranking = 1.0). Supports graded labels (2 = answer-bearing, 1 = related, 0 = irrelevant) | Yes | [Wikipedia](https://en.wikipedia.org/wiki/Evaluation_measures_(information_retrieval)), [Pinecone eval guide](https://www.pinecone.io/learn/offline-evaluation/) |
| **TARr@N / TARa@N** (run-to-run consistency) | Total agreement rate across N identical runs — raw string (TARr) or parsed answer (TARa) | Run each question N times at fixed settings; % of questions with identical output across all N runs | No | [arXiv 2408.04667](https://arxiv.org/html/2408.04667v5) |
| **Flip rate** (judge/verdict consistency) | How often a judgment changes across repeated identical evaluations | Repeat identical judge calls; fraction of trials whose verdict differs from the modal verdict | No | [arXiv 2606.13685](https://arxiv.org/abs/2606.13685) |
| **SelfCheckGPT consistency** | Sentence-level hallucination score from cross-sample agreement | Sample multiple stochastic responses; score each sentence of the main answer by consistency with samples (BERTScore / QA / n-gram / NLI / LLM-prompt variants) | No | [arXiv 2303.08896](https://arxiv.org/abs/2303.08896) |
| **Semantic entropy** | Uncertainty over *meanings* of sampled answers (flags confabulations) | Cluster samples into meaning-equivalence classes via bidirectional NLI entailment; Shannon entropy over cluster distribution — paraphrases not penalized | No | [arXiv 2302.09664](https://arxiv.org/abs/2302.09664), [Nature 2024](https://www.nature.com/articles/s41586-024-07421-0) |
| **Paraphrase consistency** | Whether semantically equivalent queries produce equivalent answers | Generate 3–5 paraphrases per gold question; measure retrieval overlap (Jaccard of top-k chunk IDs), answer-equivalence rate (NLI/judge), citation-set stability; score = correct-and-consistent / total pairs | Partial (gold Q needed) | [arXiv 2604.10745](https://arxiv.org/abs/2604.10745), [arXiv 2502.12342](https://arxiv.org/pdf/2502.12342) |
| **Negative rejection rate** (RGB) | Whether the system refuses when no retrieved doc contains the answer | Fraction of no-answer cases where the model outputs the required refusal; RGB also defines noise-robustness accuracy (exact match under noise ratio 0–0.8), error detection/correction rates for counterfactual docs | Yes (curated probes) | [arXiv 2309.01431](https://arxiv.org/abs/2309.01431v2), [AAAI-24](https://ojs.aaai.org/index.php/AAAI/article/view/29728) |

Additional catalog notes:

- **TruLens RAG triad** = Context Relevance + Groundedness + Answer Relevance. All three are entirely reference-free, making the triad the cheapest full-coverage option before a labeled dataset exists. Feedback functions are provider-backed (OpenAI, Bedrock, LiteLLM…), so the triad can be judged by a stronger model than the answerer.
- **Strictness gradient in the faithfulness family**: RAGAS requires each claim be *inferable* from context (strictest), TruLens searches per-sentence for supporting evidence with CoT reasons, DeepEval only requires *non-contradiction* (laxest). For a regulatory corpus, prefer the inferable standard.
- **Ground-truth partition** — reference-free: RAGAS Faithfulness / Response Relevancy / LLM Context Precision (without reference); DeepEval Faithfulness / Answer Relevancy / Contextual Relevancy; the whole TruLens triad. Requires ground truth: RAGAS Context Recall, Context Precision (with-reference/ID), Noise Sensitivity, Answer Correctness; DeepEval Contextual Precision/Recall; all classic IR metrics; negative/counterfactual probes.
- **ARES** ([arXiv 2311.09476](https://arxiv.org/abs/2311.09476), NAACL 2024) is the academic alternative: fine-tuned DeBERTa-v3 judges on synthetic in-domain data + prediction-powered inference over 150–300 human labels → dimension scores with 95% CIs. It beat RAGAS by 59.9 pts on context-relevance accuracy. Overkill for this project's scale, but its PPI idea (anchor judges to a small human-labeled set) is worth borrowing.
- **DeepEval's differentiator** is pytest-style pass/fail thresholds per metric for CI gating; RAGAS is the most granular metric library; TruLens is strongest for reference-free production monitoring with CoT explanations.

---

## Recommended metric set for THIS pipeline

Seven categories, chosen for a 15-REGDOC corpus with mandatory citations, a small budget, and no pre-existing labels (the golden set below makes the ground-truth-dependent ones affordable):

1. **Retrieval quality — hit rate@k + MRR (ID-based), plus RAGAS Context Recall.** The pgvector/top-k stage must be scored in isolation; with source chunk IDs recorded in the golden set, hit rate and MRR cost zero judge tokens, and Context Recall catches multi-chunk questions where the single-gold-chunk assumption breaks. ([IR-book](https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-ranked-retrieval-results-1.html), [OpenAI cookbook](https://developers.openai.com/cookbook/examples/evaluation/evaluate_rag_with_llamaindex), [RAGAS](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/))
2. **Retrieval ranking / noise — RAGAS Context Precision (ID-based where possible).** With a fixed top-k window feeding gpt-4o-mini, irrelevant chunks in the window are the direct cause of noise-induced errors (RGB shows accuracy dropping 96% → 76% as noise ratio rises), so rank-aware precision is the tuning signal for the k sweep. ([RAGAS](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/), [RGB](https://arxiv.org/abs/2309.01431v2))
3. **Generation faithfulness — RAGAS Faithfulness (inferable-claim standard).** This is the hallucination gate for a nuclear-regulatory chatbot; RAGAS's strict "claim must be inferable from context" standard fits a domain where legal/citation-critical deployments gate at ~0.95+. ([RAGAS](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness/), [legal RAG case study](https://www.digitalapplied.com/blog/case-study-rag-deployment-legal-research-firm-2026))
4. **Answer relevancy — RAGAS Response Relevancy.** Guards against grounded-but-unhelpful answers, and is nearly free (3 generated questions + text-embedding-3-small cosine calls) so it rides along on every run. ([RAGAS](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/answer_relevance/))
5. **Citation correctness — custom two-part metric.** (a) *Citation validity*: every cited chunk/REGDOC ID must be in the retrieved set (deterministic string/ID check, zero cost); (b) *citation support*: judge verifies each answer claim is supported by its specifically cited chunk — a per-citation faithfulness check, since mandatory citations are this pipeline's core product promise. No framework ships this natively; build it on the OpenAI Evals API grader pattern (string_check + model grader). ([OpenAI graders](https://developers.openai.com/api/docs/guides/graders))
6. **Consistency — run-to-run (TARa-style ×N) + paraphrase invariance.** Temperature 0 does not make gpt-4o-mini deterministic (~24% of exact repeats differ), so measure parsed-answer agreement and citation-set agreement over N=5 repeats; separately, 3–5 paraphrases per question scored on retrieval Jaccard + answer-equivalence rate, because retrieval is highly vulnerable to query rephrasing. ([arXiv 2408.04667](https://arxiv.org/html/2408.04667v5), [arXiv 2601.19934](https://arxiv.org/pdf/2601.19934), [arXiv 2604.10745](https://arxiv.org/abs/2604.10745))
7. **Negative rejection / out-of-corpus abstention — RGB-style rejection rate.** A compliance chatbot must refuse rather than improvise when the 15 REGDOCs lack the answer; LLMs are documented as weak here (ChatGPT ~25% exact-match rejection), so it must be probed explicitly with out-of-corpus questions. ([RGB](https://arxiv.org/abs/2309.01431v2), [RARE](https://arxiv.org/pdf/2506.00789))

Deliberately deferred: RAGAS Noise Sensitivity and Answer Correctness (useful later, but overlap with #2/#3/#5 and double the judge bill), and ARES-style fine-tuned judges (not worth it at this corpus size).

---

## Experiment design recommendations

### Golden dataset construction

- **Size**: 60–100 curated questions (≈ 4–7 per REGDOC across 15 docs). Practitioner consensus is 50–200 examples, with 50–100 covering core use cases as the standard starting point. ([Statsig](https://www.statsig.com/perspectives/golden-datasets-evaluation-standards), [Maxim](https://www.getmaxim.ai/articles/building-a-golden-dataset-for-ai-evaluation-a-step-by-step-guide/))
- **Generation method**: LLM-generate from the corpus chunks using RAGAS `TestsetGenerator` (knowledge graph + query synthesizers; default distribution 50% single-hop specific, 25% multi-hop abstract, 25% multi-hop specific) or the OpenAI cookbook's `generate_question_context_pairs` (N questions per chunk). Use a **stronger model than the answerer** (GPT-4o-class) as the generator — both docs do, and it avoids the answerer grading questions written in its own style. ([RAGAS testset gen](https://docs.ragas.io/en/stable/getstarted/rag_testset_generation/), [OpenAI cookbook](https://developers.openai.com/cookbook/examples/evaluation/evaluate_rag_with_llamaindex))
- **Schema**: each record stores `question`, `ground_truth_answer`, and `source_chunk_ids` / `source_regdoc`. Without reference chunk IDs you cannot separate retrieval failure from generation failure, and you forfeit the free ID-based retrieval metrics. ([dev.to guide](https://dev.to/kuldeep_paul/how-to-evaluate-your-rag-system-a-complete-guide-to-metrics-methods-and-best-practices-18ne))
- **Spot-check**: synthetic generation is a draft, not a finished set — RAGAS docs explicitly instruct human curation. Human-review 100% of a 60–100-item set if feasible; at minimum verify every answer + chunk attribution for a 25–30% stratified sample and all multi-hop items. Also hand-write 10–15 questions (synthetic sets lack linguistic diversity). ([RAGAS docs](https://docs.ragas.io/en/stable/getstarted/rag_testset_generation/), [Anyscale](https://docs.anyscale.com/rag/evaluation))
- **Difficulty mix**: don't make it all single-chunk lookups — include reasoning, multi-context, and conditional questions (RAGAS v0.1 evolution paradigm: e.g. 50/20/20/10). ([RAGAS v0.1 docs](https://docs.ragas.io/en/v0.1.21/concepts/testset_generation.html))

### Experiments to run

| Experiment | Design | Primary metrics |
|---|---|---|
| **Baseline battery** | Full golden set through the pipeline once at production settings | All 7 categories; this is the scorecard every change is compared against |
| **Consistency ×N** | Repeat every golden question N=5 (10 for a publishable number) at fixed temp/seed | TARa-style parsed-answer agreement, citation-set agreement, exact-string TARr as a curiosity ([arXiv 2408.04667](https://arxiv.org/html/2408.04667v5); ~11 trials needed for 95% verdict confidence per [arXiv 2606.13685](https://arxiv.org/abs/2606.13685)) |
| **Paraphrase sets** | 3–5 LLM-generated paraphrases per question (validated for meaning-equivalence), run through the full pipeline | Top-k Jaccard overlap vs canonical phrasing, answer-equivalence rate, citation stability ([arXiv 2604.10745](https://arxiv.org/abs/2604.10745)) |
| **Top-k sweep** | Rerun baseline at k ∈ {3, 5, 8, 10} | Hit rate@k / MRR / context precision vs faithfulness and cost — find the knee where recall gains stop paying for noise ([RGB noise curve](https://arxiv.org/html/2309.01431v2)) |
| **Negative / out-of-corpus probes** | 15–25 questions answerable only outside the 15 REGDOCs (adjacent nuclear topics, other jurisdictions) + a few plausible-but-false premise questions | Rejection rate (does it refuse with no fabricated citation?), false-rejection rate on answerable controls ([RGB](https://arxiv.org/abs/2309.01431v2), [RARE](https://arxiv.org/pdf/2506.00789)) |

### Judge design

- **Judge one tier above the answerer, and a different model**: answerer is gpt-4o-mini, so judge with GPT-4o-class (or a Claude-class model). GPT-4-class judges hit >80% agreement with humans — the human-human level — and using a different model dodges self-enhancement bias (~10–25% self-favoring win-rate inflation documented). Downgrade to a mini-class judge only after demonstrating agreement with the strong judge on your own labeled sample (validated downgrades cut judge cost 10×; gpt-4o-mini judged at ~$1.01 / 1,000 evals in one study). ([Zheng et al.](https://arxiv.org/abs/2306.05685), [Databricks](https://www.databricks.com/blog/LLM-auto-eval-best-practices-RAG), [arXiv 2512.01232](https://arxiv.org/html/2512.01232v1))
- **Temperature 0, structured output**: no creativity needed in judging; accept residual nondeterminism (pairwise verdicts still flip ~13.6% on average) and make final score extraction mechanical. ([Evidently](https://www.evidentlyai.com/llm-guide/llm-as-a-judge), [arXiv 2606.13685](https://arxiv.org/abs/2606.13685))
- **Rubric**: binary pass/fail or 0–3 integer scale with a written description + example per score level — never 0–10 floats or 0–100. Require chain-of-thought reasoning *before* the verdict (G-Eval paradigm; CoT cut math-grading failures 70% → 30%, reference-guided judging to 15%). ([Databricks](https://www.databricks.com/blog/LLM-auto-eval-best-practices-RAG), [G-Eval](https://arxiv.org/abs/2303.16634), [Zheng et al.](https://arxiv.org/html/2306.05685v4))
- **Bias mitigations**: position bias — swap order and require consistency for any pairwise comparison; verbosity bias — instruct the rubric to ignore length; reference-guided judging for correctness questions (judge sees the golden answer). ([Zheng et al.](https://arxiv.org/abs/2306.05685), [Wang et al.](https://arxiv.org/abs/2305.17926))
- **Validate the judge itself**: hand-label 30–50 items, run the judge, measure precision/recall vs your labels, iterate the rubric until agreement is acceptable. The judge is a model that needs evaluation too; ARES formalizes this with PPI over 150–300 labels if statistical rigor is ever needed. ([Evidently](https://www.evidentlyai.com/llm-guide/llm-as-a-judge), [ARES](https://arxiv.org/abs/2311.09476))

### Logging requirements

Per eval item, persist: question ID + paraphrase ID, prompt hash, retrieved chunk IDs with ranks and similarity scores, generated answer, extracted citations, every per-metric score **with the judge's CoT reasons**, judge model + version, answerer model + version, embedding model, temperature/seed, k, timestamps, and token/cost counters. Cost controls: cache judge verdicts keyed on hash(judge model + rubric + input) so unchanged pairs are never re-scored; use ID-based retrieval metrics (zero judge tokens); run the full battery on gated events (PR to main), sampled subsets for anything more frequent. A 100-question full run with a GPT-4o judge is single-digit dollars; with caching + ID-based metrics, repeat runs drop to cents — relevant since this demo is funded out of pocket. ([qaskills CI guide](https://qaskills.sh/blog/ragas-faithfulness-answer-relevancy-guide), [Langfuse](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge), [Monte Carlo](https://montecarlo.ai/blog-llm-as-judge/))

---

## Realistic score expectations

No framework publishes official pass/fail thresholds (Anyscale explicitly refuses to); the numbers below are the citable reference points.

| Metric family | Good / target | Typical / concerning | Source |
|---|---|---|---|
| **Context recall** | >= 0.85 (OpenAI's published Q&A target) | Below that, answers are systematically incomplete | [OpenAI best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) |
| **Context precision** | > 0.70 (OpenAI's published target) | Lower means the top-k window is noise-heavy; expect faithfulness knock-on effects | [OpenAI best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) |
| **Faithfulness** | 0.85–0.90 = good production bar; **0.95–0.98 gate for citation-critical domains** (legal precedent — adopt for CNSC regulatory content) | < 0.85 = confident wrong answers reach users; < 0.7 = regular hallucination. Per-question scores are often near-binary (0.2 vs 1.0), so read aggregates as fraction-of-grounded-claims | [qaskills](https://qaskills.sh/blog/ragas-faithfulness-answer-relevancy-guide), [legal case study](https://www.digitalapplied.com/blog/case-study-rag-deployment-legal-research-firm-2026), [AWS ML blog](https://aws.amazon.com/blogs/machine-learning/evaluate-rag-responses-with-amazon-bedrock-llamaindex-and-ragas/), [Medium production post](https://medium.com/@bagheshri/i-thought-my-rag-pipeline-was-production-ready-ragas-disagreed-c1ab2ff234ff) |
| **Answer quality (human-rated)** | >= 70% positively rated answers | OpenAI's third published Q&A threshold | [OpenAI best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) |
| **Answer relevancy** | High-0.8s+ typical when retrieval works; must be read alongside faithfulness — either alone is unreliable | Penalizes incomplete AND over-detailed answers; not strictly bounded to [0,1] | [RAGAS docs](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/answer_relevance/), [qaskills](https://qaskills.sh/blog/ragas-faithfulness-answer-relevancy-guide) |
| **Noise robustness (generator)** | ChatGPT-class: 96.3% exact-match accuracy at 0% noise → 76.0% at 80% noise — expect degradation, plan the top-k sweep around it | Information integration is much worse: 55% clean → 34% at 40% noise | [RGB](https://arxiv.org/abs/2309.01431v2) |
| **Negative rejection** | Expect LOW out of the box: ~24.7% exact-match rejection (45% leniently judged) for ChatGPT — prompt engineering for refusal is mandatory, then re-measure | A high rejection score on answerable questions is its own failure — track false rejections | [RGB](https://arxiv.org/abs/2309.01431v2) |
| **Run-to-run consistency** | gpt-4o-mini at temp 0: ~24% of exact repeats produce distinct strings (avg Jaccard 0.89); accuracy can vary up to 15% between identical-setting runs. Parsed-answer (TARa) agreement is much higher than string agreement — target high-90s% TARa and treat citation-set agreement as the KPI | Judge verdicts flip 13.6% on average across repeats; some questions flip up to 50% even at temp 0 | [arXiv 2601.19934](https://arxiv.org/pdf/2601.19934), [arXiv 2408.04667](https://arxiv.org/html/2408.04667v5), [arXiv 2606.13685](https://arxiv.org/abs/2606.13685) |
| **Judge-human agreement** | 85% (GPT-4 vs human majority, excluding ties) — above human-human agreement of 81%; treat >= 80% on your own labeled sample as "judge validated" | Position-swap consistency without mitigation: GPT-4 65%, GPT-3.5 46%, Claude-v1 24% — mitigations are not optional | [Zheng et al.](https://arxiv.org/abs/2306.05685) |
| **Paraphrase robustness** | No canonical threshold yet; literature documents a "critical robustness gap" — report retrieval Jaccard + answer-equivalence rate and track deltas over time rather than gating on an absolute number initially | Small surface-level rephrasing can flip retrieval and downstream answers | [arXiv 2604.10745](https://arxiv.org/abs/2604.10745), [REAL-MM-RAG](https://arxiv.org/pdf/2502.12342) |

Interpretation caveats: (1) all faithfulness-family thresholds are practitioner heuristics, not standards — calibrate against the human-reviewed golden set; (2) consistency metrics miss *consistent errors* — a model that reliably repeats the same wrong answer scores perfectly, so consistency complements, never replaces, faithfulness/correctness ([Nature 2024](https://www.nature.com/articles/s41586-024-07421-0)); (3) with one gold chunk per question, MRR and binary-gain nDCG are monotonically related — reporting hit rate@k + MRR is sufficient.

---

## Sources

### Framework documentation (primary)

- https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness/
- https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/answer_relevance/
- https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/
- https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/
- https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/noise_sensitivity/
- https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/answer_correctness/
- https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/
- https://docs.ragas.io/en/stable/getstarted/rag_testset_generation/
- https://docs.ragas.io/en/v0.1.21/concepts/testset_generation.html
- https://pypi.org/project/ragas/
- https://github.com/explodinggradients/ragas/blob/main/src/ragas/metrics/_answer_correctness.py
- https://github.com/vibrantlabsai/ragas/issues/1040
- https://www.trulens.org/getting_started/core_concepts/rag_triad/
- https://www.trulens.org/reference/trulens/feedback/llm_provider/
- https://www.trulens.org/blog/2024/08/30/moving-to-trulens-v1-reliable-and-modular-logging-and-evaluation/
- https://www.trulens.org/component_guides/other/trulens_eval_migration/
- https://pypi.org/project/trulens/
- https://github.com/truera/trulens
- https://deepeval.com/docs/metrics-answer-relevancy
- https://deepeval.com/docs/metrics-faithfulness
- https://deepeval.com/docs/metrics-contextual-precision
- https://deepeval.com/docs/metrics-contextual-recall
- https://deepeval.com/docs/metrics-contextual-relevancy
- https://pypi.org/project/deepeval/
- https://github.com/confident-ai/deepeval
- https://deepeval.com/blog/llm-as-a-judge

### OpenAI official guidance (primary)

- https://developers.openai.com/cookbook/examples/evaluation/evaluate_rag_with_llamaindex
- https://github.com/openai/openai-cookbook/blob/main/examples/evaluation/Evaluate_RAG_with_LlamaIndex.ipynb
- https://developers.openai.com/api/docs/guides/graders
- https://developers.openai.com/api/docs/guides/evals
- https://developers.openai.com/api/docs/guides/evaluation-best-practices

### Academic literature

- https://arxiv.org/abs/2311.09476 (ARES) — full text: https://arxiv.org/html/2311.09476v2 — code: https://github.com/stanford-futuredata/ARES
- https://arxiv.org/abs/2309.01431v2 (RGB) — full text: https://arxiv.org/html/2309.01431v2 — AAAI-24: https://ojs.aaai.org/index.php/AAAI/article/view/29728
- https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-ranked-retrieval-results-1.html (Manning et al., IR-book ch.8)
- https://en.wikipedia.org/wiki/Evaluation_measures_(information_retrieval)
- https://arxiv.org/html/2408.04667v5 (Non-determinism of "deterministic" LLM settings — TARr/TARa)
- https://arxiv.org/abs/2606.13685 (The Coin Flip Judge — flip rate)
- https://arxiv.org/pdf/2601.19934 (Quantifying non-deterministic drift in LLMs)
- https://arxiv.org/pdf/2311.15180 (Benchmarking LLM volatility)
- https://arxiv.org/abs/2203.11171 (Self-Consistency, Wang et al.)
- https://arxiv.org/abs/2303.08896 (SelfCheckGPT)
- https://arxiv.org/abs/2302.09664 (Semantic Uncertainty, Kuhn et al.)
- https://www.nature.com/articles/s41586-024-07421-0 (Semantic entropy, Farquhar et al., Nature 2024)
- https://arxiv.org/pdf/2406.15927 (Semantic Entropy Probes)
- https://arxiv.org/abs/2604.10745 (How You Ask Matters — query-variation robustness)
- https://arxiv.org/pdf/2506.00789 (RARE — retrieval-aware robustness)
- https://arxiv.org/pdf/2502.12342 (REAL-MM-RAG — rephrasing robustness)
- https://arxiv.org/pdf/2509.18868 (RAG robustness survey — perturbed-query operationalization)
- https://arxiv.org/abs/2306.05685 (Zheng et al., LLM-as-a-judge / MT-Bench) — full text: https://arxiv.org/html/2306.05685v4
- https://arxiv.org/abs/2305.17926 (LLMs are not fair evaluators, Wang et al.)
- https://arxiv.org/abs/2508.06225 (Overconfidence in LLM-as-a-judge)
- https://arxiv.org/pdf/2411.15594 (Survey on LLM-as-a-judge)
- https://arxiv.org/abs/2303.16634 (G-Eval)
- https://arxiv.org/html/2512.01232v1 (LLM-as-judge cost/accuracy — gpt-4o-mini $1.01/1k evals)
- https://arxiv.org/abs/2501.17178 (Tuning LLM judge design for 1/1000 cost)

### Industry / practitioner

- https://www.databricks.com/blog/LLM-auto-eval-best-practices-RAG
- https://www.evidentlyai.com/llm-guide/llm-as-a-judge
- https://www.patronus.ai/llm-testing/llm-as-a-judge
- https://galtea.ai/blog/llm-as-a-judge-prompts-templates-rubrics-and-best-practices
- https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge
- https://montecarlo.ai/blog-llm-as-judge/
- https://docs.anyscale.com/rag/evaluation
- https://aws.amazon.com/blogs/machine-learning/evaluate-rag-responses-with-amazon-bedrock-llamaindex-and-ragas/
- https://qaskills.sh/blog/ragas-faithfulness-answer-relevancy-guide
- https://qaskills.sh/blog/ragas-context-precision-recall-faithfulness-guide
- https://www.digitalapplied.com/blog/case-study-rag-deployment-legal-research-firm-2026
- https://medium.com/@bagheshri/i-thought-my-rag-pipeline-was-production-ready-ragas-disagreed-c1ab2ff234ff
- https://www.statsig.com/perspectives/golden-datasets-evaluation-standards
- https://www.getmaxim.ai/articles/building-a-golden-dataset-for-ai-evaluation-a-step-by-step-guide/
- https://dev.to/kuldeep_paul/how-to-evaluate-your-rag-system-a-complete-guide-to-metrics-methods-and-best-practices-18ne
- https://dev.to/hadleyworks/llm-evaluation-in-ci-stop-manual-testing-before-it-costs-you-59i7
- https://pixion.co/blog/rag-in-practice-test-set-generation
- https://docs.llamaindex.ai/en/stable/module_guides/evaluating/usage_pattern_retrieval/
- https://www.pinecone.io/learn/offline-evaluation/
