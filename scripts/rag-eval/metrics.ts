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
import { extractCitations } from "./citations";

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

/**
 * The TRUE cosine-similarity ranking of the retrieval candidate pool.
 *
 * PR #8 fix round 1 (issue 7a). MRR and context precision are POSITIONAL — they
 * are only meaningful over a genuinely RANKED list. The `data-sources` frame the
 * eval used to read is the DIVERSITY-REORDERED envelope (selectDiverseEnvelope
 * seeds it with the top chunk of each mentioned doc), and the named-doc boost
 * reorders it again — so scoring rank-sensitive metrics over it scored a list
 * that was never a ranking. `rankPreBoost` is each chunk's position in the raw
 * pool sorted by cosine similarity: the only true ranking in the pipeline. Takes
 * the trace's pool (post-boost order) and restores similarity order.
 */
export function similarityRankedIdsFromTrace(trace: {
	pool: Array<{ chunk: { id: number }; rankPreBoost: number }>;
}): number[] {
	return trace.pool
		.slice()
		.sort((a, b) => a.rankPreBoost - b.rankPreBoost)
		.map((e) => e.chunk.id);
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
export function disagreeingPairs(keys: string[]): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (let i = 0; i < keys.length; i++) {
		for (let j = i + 1; j < keys.length; j++) {
			if (keys[i] !== keys[j]) out.push([i, j]);
		}
	}
	return out;
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
	success: boolean;
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
