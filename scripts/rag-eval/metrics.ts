// RAG eval framework — metric implementations (item-2 slice 2.1, R7).
//
// Standard definitions only (I2.4) — formulas per
// docs/orchestration/research/rag-eval-metrics.md Metric catalog:
//   hit rate@k / MRR / recall@k  — IR-book ch.8, LlamaIndex retrieval eval
//   context precision CP@K       — RAGAS (ID-based relevance labels)
//   TARr / citation-set agreement — arXiv 2408.04667 (run-to-run consistency)
//   paraphrase retrieval Jaccard  — arXiv 2604.10745
//   negative rejection            — RGB, arXiv 2309.01431
// Judge-backed metrics (faithfulness, relevancy, citation support,
// answer-equivalence) live in judge.ts; these are the deterministic ones.

import {
	isLimitedContextText,
	isLowConfidenceText,
	isRefusalText,
} from "../../lib/prompts";
import {
	type RetrievalTrace,
	envelopeIdsAtK,
	postFilterRankedIdsFromTrace,
} from "../../lib/retrieval";
import { citationSetKey, extractCitations } from "./citations";

// ---------------------------------------------------------------------------
// 1. Retrieval quality (ID-based, zero judge cost)

/** Hit rate@k: 1 iff at least one gold chunk id appears in the top-k. */
export function hitRateAtK(
	rankedIds: number[],
	goldIds: Set<number>,
	k: number,
): 0 | 1 {
	return rankedIds.slice(0, k).some((id) => goldIds.has(id)) ? 1 : 0;
}

/** MRR contribution: 1/rank of the FIRST relevant id (0 when absent). */
export function reciprocalRank(
	rankedIds: number[],
	goldIds: Set<number>,
): number {
	const idx = rankedIds.findIndex((id) => goldIds.has(id));
	return idx === -1 ? 0 : 1 / (idx + 1);
}

// ---------------------------------------------------------------------------
// 1b. WHICH STAGE does a retrieval metric score? (PR #8 fix round 2, issue 2)
//
// Fix round 1 was right that the `data-sources` frame is not a RANKING, and
// moved the rank-sensitive metrics onto lib/retrieval's `RetrievalTrace`. But it
// then scored them over `trace.pool` — the UNFILTERED merged candidate list out
// of match_regdoc_chunks. That is a SUPERSET production never surfaces: a
// context-precision or MRR number computed over it does not describe the shipped
// pipeline. A metric that reports a number for a pool nobody was ever shown is
// exactly the failure mode this item exists to prevent.
//
// So every retrieval metric now names the stage its DEFINITION requires, and the
// report prints that stage in the row label. No metric may silently pick
// whichever list flatters it.
export type RetrievalStageId = "raw_pool" | "post_filter_pool" | "envelope";

export const RETRIEVAL_STAGE_LABELS: Record<RetrievalStageId, string> = {
	// Diagnostic only. NO reported metric scores this — production never shows it.
	raw_pool:
		"raw candidate pool (pre-filter, pre-boost) — never shown to the LLM; diagnostic only",
	// MRR: a rank metric needs a genuine ranking, restricted to what could
	// actually be surfaced. Chunks below MIN_CHUNK_SIM are ineligible, so ranking
	// them would credit the retriever with a rank production discards.
	post_filter_pool:
		"post-MIN_CHUNK_SIM similarity-ranked pool — the candidates production could actually surface",
	// hit rate / context recall / context precision: RAGAS scores these over
	// `retrieved_contexts`, i.e. the window handed to the generator. Ours is the
	// envelope, in prompt order — the order the model reads, and the order whose
	// noise causes the generation errors context precision exists to measure.
	envelope:
		"envelope the LLM was shown (RAGAS retrieved_contexts), in prompt order",
};

/** Which stage each reported retrieval metric scores. The report prints these. */
export const RETRIEVAL_METRIC_STAGE = {
	hit_rate_at_k: "envelope",
	context_recall_at_k: "envelope",
	context_precision_at_k: "envelope",
	reciprocal_rank: "post_filter_pool",
} as const satisfies Record<string, RetrievalStageId>;

/**
 * The RAW (pre-filter, pre-boost) cosine-similarity order of the candidate pool.
 *
 * PR #8 fix round 1 (issue 7a) introduced this because the trace's `pool` arrives
 * in POST-boost order: `rankPreBoost` is each chunk's position in the raw pool
 * sorted by cosine similarity, and a named-doc boost can lift a chunk to the
 * front of the pool while its similarity rank is 4th — score positionally over
 * the pool's own order and you credit a rank the retriever never gave it.
 *
 * PR #8 fix round 2 (issue 2): it is NO LONGER what MRR reads. The raw pool is
 * unfiltered — it contains chunks below MIN_CHUNK_SIM that production can never
 * surface. MRR now reads `postFilterRankedIdsFromTrace`. This function survives
 * as the definition of the `raw_pool` stage (diagnostic, and the invariant that
 * pins `trace.stages.rawRankedIds` to genuine cosine order — see the self-test).
 */
export function similarityRankedIdsFromTrace(trace: {
	pool: Array<{ chunk: { id: number }; rankPreBoost: number }>;
}): number[] {
	return trace.pool
		.slice()
		.sort((a, b) => a.rankPreBoost - b.rankPreBoost)
		.map((e) => e.chunk.id);
}

// ---------------------------------------------------------------------------
// 1c. The stage-correct retrieval scorers (PR #8 fix round 2, issue 2).
//
// These take the TRACE and the SERVED envelope and pick the stage themselves, so
// a caller CANNOT wire a metric to the wrong pool. The stage choice is the thing
// that was wrong; putting it behind a pure, unit-tested function makes the wrong
// thing impossible rather than merely asserted. run.ts calls these; the self-test
// drives them directly with fixtures.

export interface RetrievalStageScores {
	/** STAGE: envelope (RAGAS retrieved_contexts). null = EXCLUDED, never 0. */
	hit_rate_at_k: number | null;
	context_recall_at_k: number | null;
	context_precision_at_k: number | null;
	/** STAGE: post-filter similarity-ranked pool. null = EXCLUDED, never 0. */
	reciprocal_rank: number | null;
	envelopeExcludedReason: string | null;
	mrrExcludedReason: string | null;
}

/**
 * Baseline retrieval scoring, one stage per metric.
 *
 *  - hit rate / context recall / context precision score the ENVELOPE the LLM was
 *    actually shown (`servedEnvelopeIds` — the data-sources frame, which route.ts
 *    builds from the very array it hands buildContextEnvelope, so its order IS
 *    the prompt order). That is RAGAS's `retrieved_contexts`.
 *  - MRR ranks the POST-FILTER pool from the trace: the candidates production
 *    could actually surface. The RAW pool would credit the retriever with ranks
 *    for chunks MIN_CHUNK_SIM discards and the model never sees.
 *
 * Every unmeasurable case is EXCLUDED with a reason — never a silent 0 (which
 * would deflate) and never a silent 1 (which would flatter).
 */
export function scoreRetrievalStages(args: {
	goldIds: Set<number>;
	k: number;
	/** The served data-sources frame ids, or null when the route emitted no frame. */
	servedEnvelopeIds: number[] | null;
	/** The offline retrieval trace, or null when it could not be captured. */
	trace: RetrievalTrace | null;
	traceError?: string | null;
}): RetrievalStageScores {
	const { goldIds, k } = args;
	const noGold = goldIds.size === 0;

	const envelopeExcludedReason = noGold
		? "no_gold_chunks:denominator_is_empty"
		: args.servedEnvelopeIds === null
			? "no_envelope_emitted:oos_or_guard_branch"
			: args.servedEnvelopeIds.length === 0
				? "empty_envelope:nothing_surfaced"
				: null;

	// The pool stage is EMPTY on the OOS branch — a different condition from the
	// envelope's, so it carries its own reason rather than borrowing one.
	const pool = args.trace ? postFilterRankedIdsFromTrace(args.trace) : null;
	const mrrExcludedReason = noGold
		? "no_gold_chunks:denominator_is_empty"
		: pool === null
			? `no_trace:${args.traceError ?? "unknown"}`
			: pool.length === 0
				? "oos_gate:no_eligible_pool"
				: null;

	const env = args.servedEnvelopeIds ?? [];
	return {
		hit_rate_at_k:
			envelopeExcludedReason === null ? hitRateAtK(env, goldIds, k) : null,
		context_recall_at_k:
			envelopeExcludedReason === null ? contextRecallAtK(env, goldIds, k) : null,
		context_precision_at_k:
			envelopeExcludedReason === null
				? contextPrecisionAtK(env, goldIds, k)
				: null,
		reciprocal_rank:
			mrrExcludedReason === null ? reciprocalRank(pool ?? [], goldIds) : null,
		envelopeExcludedReason,
		mrrExcludedReason,
	};
}

export interface KSweepStageScores {
	stage: RetrievalStageId;
	retrieved_ids: number[];
	hit_rate: number | null;
	context_recall: number | null;
	context_precision: number | null;
}

/**
 * K-sweep scoring at one k — always the ENVELOPE stage, because the envelope
 * selection at k IS what the sweep measures.
 *
 * `envelopeIdsAtK` returns [] on the OOS branch, where the route refuses and
 * builds no envelope at ANY k (the gate fires on the raw pool's top-1 and is
 * k-independent). `deriveEnvelopeAtK` — which mirrors retrieveChunks' RETURN
 * value, and that value is the full ranked pool there — must NOT be used: slicing
 * that pool to k would report a hit rate for chunks the pipeline explicitly
 * declined to show anyone, and would vary the denominator across k, which alone
 * makes the across-k comparison the sweep exists for ill-formed.
 */
export function scoreEnvelopeAtK(args: {
	trace: RetrievalTrace;
	goldIds: Set<number>;
	k: number;
	/** Set when the item is excluded outright (OOS gate, no gold chunk). */
	excludedReason: string | null;
}): KSweepStageScores {
	const ids = envelopeIdsAtK(args.trace, args.k);
	const ok = args.excludedReason === null;
	return {
		stage: "envelope",
		retrieved_ids: ids,
		hit_rate: ok ? hitRateAtK(ids, args.goldIds, args.k) : null,
		context_recall: ok ? contextRecallAtK(ids, args.goldIds, args.k) : null,
		context_precision: ok ? contextPrecisionAtK(ids, args.goldIds, args.k) : null,
	};
}

/** Why this item is unscoreable in the k-sweep (null = scoreable). */
export function kSweepExclusion(
	trace: RetrievalTrace,
	goldIds: Set<number>,
): string | null {
	if (goldIds.size === 0) return "no_gold_chunks:denominator_is_empty";
	if (trace.decision === "oos") return "oos_gate:no_envelope_at_any_k";
	return null;
}

/** ID-based context recall: |gold ∩ retrieved@k| / |gold|. */
export function contextRecallAtK(
	rankedIds: number[],
	goldIds: Set<number>,
	k: number,
): number {
	if (goldIds.size === 0) return 0;
	const top = new Set(rankedIds.slice(0, k));
	let hit = 0;
	for (const id of goldIds) if (top.has(id)) hit++;
	return hit / goldIds.size;
}

// ---------------------------------------------------------------------------
// 2. Context precision — RAGAS CP@K with ID-based relevance labels:
//    CP@K = Σ_i (Precision@i × v_i) / (relevant items in top K), v_i ∈ {0,1}.
//    ID-based labeling is strict: near-duplicate neighbor chunks count as
//    irrelevant (disclosed in the report).

export function contextPrecisionAtK(
	rankedIds: number[],
	goldIds: Set<number>,
	k: number,
): number {
	const top = rankedIds.slice(0, k);
	let relevantSoFar = 0;
	let acc = 0;
	for (let i = 0; i < top.length; i++) {
		const v = goldIds.has(top[i]) ? 1 : 0;
		relevantSoFar += v;
		if (v === 1) acc += relevantSoFar / (i + 1);
	}
	return relevantSoFar === 0 ? 0 : acc / relevantSoFar;
}

// ---------------------------------------------------------------------------
// 6. Consistency (deterministic parts)

/** Jaccard similarity of two id sets (1 when both empty). */
export function jaccard(a: Set<number>, b: Set<number>): number {
	if (a.size === 0 && b.size === 0) return 1;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	return inter / (a.size + b.size - inter);
}

/**
 * Total agreement across N runs of one question: 1 iff every run produced
 * the same key (TAR-style, arXiv 2408.04667). Used with citationSetKey for
 * the citation-set KPI and with normalizeText for TARr.
 */
export function totalAgreement(keys: string[]): 0 | 1 {
	return keys.every((k) => k === keys[0]) ? 1 : 0;
}

/**
 * Normalization for TARr "normalized-text exact agreement": collapse
 * whitespace + trim only — anything stronger stops being "exact".
 */
export function normalizeText(raw: string): string {
	return raw.replace(/\s+/g, " ").trim();
}

/**
 * Index pairs (i, j) of runs whose citation sets differ — the ONLY pairs the
 * answer-equivalence judge is invoked for (cost control, R7 metric 6).
 */
export function disagreeingPairs(
	keys: Array<string | null>,
): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (let i = 0; i < keys.length; i++) {
		for (let j = i + 1; j < keys.length; j++) {
			if (keys[i] !== keys[j]) out.push([i, j]);
		}
	}
	return out;
}

/**
 * Total agreement across N repeats, WITH vacuity discipline (issue 1a).
 *
 *   every key NULL      → NOT MEASURABLE (null). N answers that all cited
 *                         nothing are not "consistent"; they are all uncitable,
 *                         and there is no set to agree about. EXCLUDED + counted.
 *   some null, some not → a genuine DISAGREEMENT (0). One repeat cited and
 *                         another did not — that IS instability, and it is real,
 *                         so it is measured rather than hidden.
 *   all equal, non-null → 1.
 */
export function totalAgreementOrNull(
	keys: Array<string | null>,
): 0 | 1 | null {
	if (keys.length === 0) return null;
	if (keys.every((k) => k === null)) return null;
	return keys.every((k) => k === keys[0]) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 6b. CONSISTENCY scorer — the same exclude-with-reason discipline round 1 gave
// baseline, applied uniformly (PR #8 fix round 2, issue 1a).

export interface ConsistencyScores {
	citation_set_agreement: 0 | 1 | null;
	tarr_exact_text_agreement: 0 | 1 | null;
	/** FULL denominator: fraction of repeats that cited at least once. This is
	 *  the companion that makes an excluded citation-agreement visible. */
	citation_coverage: number | null;
	citation_agreement_excluded_reason: string | null;
	tarr_excluded_reason: string | null;
}

export function scoreConsistency(args: {
	/** Per repeat: the MODEL's text, route boilerplate already stripped (issue 4). */
	judgedTexts: string[];
	/** Per repeat: true when the route emitted NO data-sources frame — the
	 *  deterministic jailbreak guard or the similarity OOS gate fired, which means
	 *  NO LLM CALL WAS MADE and the emitted string is a route constant. */
	noEnvelope: boolean[];
}): ConsistencyScores {
	const n = args.judgedTexts.length;
	const keys = args.judgedTexts.map((t) => citationSetKey(t));
	const cited = keys.filter((k) => k !== null).length;
	const allNoLlm = n > 0 && args.noEnvelope.every(Boolean);
	const allEmpty =
		n > 0 && args.judgedTexts.every((t) => normalizeText(t) === "");

	// TARr measures the MODEL's run-to-run text stability. On the guard/OOS branch
	// the route emits a CONSTANT string and never calls the model — so agreement
	// is 1 BY CONSTRUCTION and says nothing whatsoever about the answerer. A
	// vacuous 1 is a flattering number for the wrong reason, so it is excluded.
	const tarrExcluded =
		n === 0
			? "no_repeats"
			: allNoLlm
				? "no_llm_call_in_any_repeat:guard_or_oos_gate_emits_a_constant"
				: allEmpty
					? "all_repeats_empty_answer"
					: null;

	// Citation-set agreement. EXCLUDED when NOT ONE repeat cited: there is no
	// citation set to agree about. A MIXED case (some cited, some did not) is a
	// genuine DISAGREEMENT → 0, measured, not hidden.
	const citationExcluded =
		n === 0
			? "no_repeats"
			: cited === 0
				? allNoLlm
					? "no_llm_call_in_any_repeat:guard_or_oos_gate_cites_nothing"
					: "zero_citations_in_every_repeat:no_citation_set_to_agree_about"
				: null;

	return {
		citation_set_agreement:
			citationExcluded === null ? totalAgreementOrNull(keys) : null,
		tarr_exact_text_agreement:
			tarrExcluded === null
				? totalAgreement(args.judgedTexts.map(normalizeText))
				: null,
		citation_coverage: n === 0 ? null : cited / n,
		citation_agreement_excluded_reason: citationExcluded,
		tarr_excluded_reason: tarrExcluded,
	};
}

// ---------------------------------------------------------------------------
// 6c. PARAPHRASE scorer — same discipline (PR #8 fix round 2, issue 1b).
//
// runParaphrase computed retrieval_jaccard and citation_set_stable with NONE of
// the exclude-with-reason discipline round 1 gave baseline:
//
//   - `jaccard(∅, ∅) === 1`. Canonical refused, paraphrase refused → both
//     envelopes empty → PERFECT retrieval stability reported for a pair where
//     NOTHING was retrieved either time.
//   - `citationSetKey(a) === citationSetKey(b)` was `"" === ""` → a free 1
//     whenever both sides cited nothing.
//   - the equivalence judge's own rubric says "Both being refusals of the same
//     kind is equivalent" — so two refusals scored as perfect paraphrase
//     robustness. (Skipping that judge call also saves real money.)
//
// Every one of those is EXCLUDED with a counted reason now. The three
// FULL-denominator coverage companions below are what keep the exclusions
// honest: a reader who sees "equivalence 95%, n=6, excluded 54 — one side
// refused" alongside "answer coverage 10%" cannot be misled into thinking the
// pipeline is robust.

export interface ParaphrasePairScores {
	retrieval_jaccard: number | null;
	citation_set_stable: 0 | 1 | null;
	/** Full-denominator companions — the exclusions above are visible through these. */
	both_sides_have_envelope: 0 | 1;
	both_sides_cited: 0 | 1;
	both_sides_answered: 0 | 1;
	jaccard_excluded_reason: string | null;
	citation_stability_excluded_reason: string | null;
	equivalence_excluded_reason: string | null;
	/** True → do NOT call the equivalence judge (vacuous, and it costs money). */
	skipEquivalenceJudge: boolean;
}

function whichSides(canonical: boolean, paraphrase: boolean): string {
	if (canonical && paraphrase) return "both";
	return canonical ? "canonical" : "paraphrase";
}

export function scoreParaphrasePair(args: {
	canonicalEnvelopeIds: Set<number>;
	paraphraseEnvelopeIds: Set<number>;
	/** MODEL text, route boilerplate already stripped (issue 4). */
	canonicalJudgedText: string;
	paraphraseJudgedText: string;
	canonicalBranch: RouteBranch;
	paraphraseBranch: RouteBranch;
}): ParaphrasePairScores {
	const cEmpty = args.canonicalEnvelopeIds.size === 0;
	const pEmpty = args.paraphraseEnvelopeIds.size === 0;
	const jaccardExcluded =
		cEmpty || pEmpty
			? `no_envelope:${whichSides(cEmpty, pEmpty)}:nothing_retrieved_to_overlap`
			: null;

	const cKey = citationSetKey(args.canonicalJudgedText);
	const pKey = citationSetKey(args.paraphraseJudgedText);
	const cNoCite = cKey === null;
	const pNoCite = pKey === null;
	const stabilityExcluded =
		cNoCite || pNoCite
			? `zero_citations:${whichSides(cNoCite, pNoCite)}:no_citation_set_to_compare`
			: null;

	const cRefused = REFUSAL_BRANCHES.has(String(args.canonicalBranch ?? ""));
	const pRefused = REFUSAL_BRANCHES.has(String(args.paraphraseBranch ?? ""));
	const equivalenceExcluded =
		cRefused || pRefused
			? `refusal:${whichSides(cRefused, pRefused)}:two_refusals_are_not_a_robust_answer`
			: null;

	return {
		retrieval_jaccard:
			jaccardExcluded === null
				? jaccard(args.canonicalEnvelopeIds, args.paraphraseEnvelopeIds)
				: null,
		citation_set_stable:
			stabilityExcluded === null ? (cKey === pKey ? 1 : 0) : null,
		both_sides_have_envelope: cEmpty || pEmpty ? 0 : 1,
		both_sides_cited: cNoCite || pNoCite ? 0 : 1,
		both_sides_answered: cRefused || pRefused ? 0 : 1,
		jaccard_excluded_reason: jaccardExcluded,
		citation_stability_excluded_reason: stabilityExcluded,
		equivalence_excluded_reason: equivalenceExcluded,
		skipEquivalenceJudge: equivalenceExcluded !== null,
	};
}

// ---------------------------------------------------------------------------
// 7. Negative rejection (RGB) — deterministic scorer.
//
// A probe response counts as a rejection SUCCESS iff it contains the
// canonical out-of-scope line OR the low-confidence line OR the request was
// blocked with a non-429 4xx (mirrors scripts/eval-security.ts grade()).
// 429 is NOT a verdict — the runner treats the first 429 as fatal
// (Edge case 2) before this scorer ever sees it.
// Any REGDOC/NSCA citation inside a rejection = fabrication = FAILURE.
//
// PR #8 fix round 1 (issue 2): detection now uses the SHARED, LOWERCASED
// SUBSTRING markers from lib/prompts.ts (REFUSAL_MARKER /
// LOW_CONFIDENCE_MARKER) — the same ones scripts/eval-security.ts grade()
// uses. The previous case-sensitive full-string match could not see the
// refusal/low-confidence lines as the MODEL actually emits them (re-cased,
// re-wrapped, wrapped in prose), so it under-counted rejections. The
// low-confidence line is emitted by the MODEL (system prompt answer rule 4),
// NOT by the route — the route's own low-similarity branch emits
// KNOWLEDGE_HUB_LIMITED_CONTEXT instead, which is a DISCLAIMER on a real
// answer and is therefore NOT a rejection. Verified against
// app/api/knowledge-hub/query/route.ts + lib/prompts.ts on main.
//
// `layer` records which defense fired, inferred from response shape
// (Edge case 4): 4xx → request boundary; canonical text with NO
// data-sources frame → deterministic jailbreak guard or similarity OOS gate
// (both skip the LLM and emit no frame); canonical text WITH sources →
// LLM-level refusal.

export interface RejectionVerdict {
	/** null = NOT MEASURABLE (excluded + counted), never a silent 0 or 1. */
	success: boolean | null;
	layer: "guard_http" | "deterministic_or_sim_gate" | "llm_refusal" | "none";
	fabricatedCitations: number;
	reason: string;
}

export function scoreRejection(args: {
	status: number;
	text: string;
	hasSourcesFrame: boolean;
}): RejectionVerdict {
	const { status, text, hasSourcesFrame } = args;
	if (status === 429) {
		throw new Error(
			"scoreRejection received a 429 — the runner must abort on the first " +
				"429 (set EVAL_BYPASS_KEY), never score it.",
		);
	}
	if (status >= 400 && status < 500) {
		return {
			success: true,
			layer: "guard_http",
			fabricatedCitations: 0,
			reason: `blocked_http_${status}`,
		};
	}
	// PR #8 fix round 2 (issue 1, negative audit). A 200 that streamed NO text is
	// not a refusal — it is a stream that produced nothing (an upstream stall, an
	// aborted fetch). The old code ran isRefusalText("") → false → scored it
	// "answered_instead_of_rejecting", i.e. a FALSE FAILURE that would drag the
	// negative-rejection row DOWN for a reason that is not the pipeline's refusal
	// behaviour at all. Not measurable: excluded and counted, never a silent 0.
	if (text.trim() === "") {
		return {
			success: null,
			layer: "none",
			fabricatedCitations: 0,
			reason: "empty_response_body:no_text_streamed:not_measurable",
		};
	}
	const refused = isRefusalText(text) || isLowConfidenceText(text);
	if (!refused) {
		return {
			success: false,
			layer: "none",
			fabricatedCitations: 0,
			reason: "answered_instead_of_rejecting",
		};
	}
	const citations = extractCitations(text);
	if (citations.length > 0) {
		return {
			success: false,
			layer: hasSourcesFrame ? "llm_refusal" : "deterministic_or_sim_gate",
			fabricatedCitations: citations.length,
			reason: `fabricated_citations_in_rejection:${citations.length}`,
		};
	}
	return {
		success: true,
		layer: hasSourcesFrame ? "llm_refusal" : "deterministic_or_sim_gate",
		fabricatedCitations: 0,
		reason: "ok",
	};
}

// ---------------------------------------------------------------------------
// 7b. Which branch of the route produced this response (Edge case 9)?
//
// PR #8 fix round 1 (issue 2). The old `fallbackTaken` in run.ts matched
// KNOWLEDGE_HUB_LOW_CONFIDENCE to detect the "disclaimer" branch. NOTHING in
// the app emits that string on that branch — the route's low-avg-similarity
// branch emits KNOWLEDGE_HUB_LIMITED_CONTEXT, and KNOWLEDGE_HUB_LOW_CONFIDENCE
// is what the MODEL is told to say when the snippets are insufficient. The two
// are different events and are now reported separately:
//
//   oos_or_guard    refusal text, NO data-sources frame → deterministic
//                   jailbreak guard or the similarity OOS gate. No LLM call,
//                   no envelope: retrieval-quality metrics MUST be excluded
//                   for this item (issue 7b), not scored 0.
//   llm_refusal     refusal text WITH a data-sources frame → an envelope was
//                   built and the model refused anyway.
//   low_confidence  the model's "I don't have enough…" line (answer rule 4).
//   limited_context the route's low-avg-sim disclaimer PREFIX. This is NOT a
//                   refusal — the model still answers from the weak snippets.
//                   Never counted as a false rejection.
//   null            a normal answer.

export type RouteBranch =
	| "oos_or_guard"
	| "llm_refusal"
	| "low_confidence"
	| "limited_context"
	| null;

/** True for branches where the pipeline declined to answer the question. */
export const REFUSAL_BRANCHES: ReadonlySet<string> = new Set([
	"oos_or_guard",
	"llm_refusal",
	"low_confidence",
]);

export function classifyBranch(args: {
	text: string;
	hasSourcesFrame: boolean;
}): RouteBranch {
	const { text, hasSourcesFrame } = args;
	if (isRefusalText(text))
		return hasSourcesFrame ? "llm_refusal" : "oos_or_guard";
	if (isLowConfidenceText(text)) return "low_confidence";
	if (isLimitedContextText(text)) return "limited_context";
	return null;
}

// ---------------------------------------------------------------------------
// 4. Answer relevancy support — cosine similarity for the RAGAS Response
// Relevancy score (mean cosine of generated-question embeddings vs the
// original question embedding). Raw values are logged; the report clamps
// negatives to 0 (Edge case 13).

export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) {
		throw new Error(`cosineSimilarity: dim mismatch (${a.length}/${b.length})`);
	}
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function mean(xs: number[]): number {
	return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function clamp01(x: number): number {
	return Math.max(0, Math.min(1, x));
}
