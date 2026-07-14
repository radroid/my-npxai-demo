#!/usr/bin/env bun
// RAG eval framework — experiment runner (item-2 slice 2.1, R10).
//
//   bun run eval:rag --experiment baseline|ksweep|consistency|paraphrase|negative
//                    [--only id1,id2] [--limit N]
//
// I2.1: manual only — never wired into lint, build, or CI.
// I2.2: every run writes evals/results/<UTC-timestamp>-<experiment>/
//       {items.jsonl, manifest.json}. items.jsonl is APPEND-ONLY so a
//       cost-cap abort still leaves a valid, scoreable log (Edge case 8).
// I2.3: every OpenAI call is metered; the run aborts at EVAL_COST_CAP_USD.
//
// Preflight runs BEFORE any OpenAI spend: Supabase reachable, golden-set
// fingerprints verified against the live DB (Edge case 6), dev server
// reachable + EVAL_BYPASS_KEY present for server-backed experiments.
//
// DELTA D2: offline retrieval (the k-sweep) passes a no-op `recordUsage` into
// lib/retrieval, so it never increments the PRODUCTION daily OpenAI
// circuit-breaker that real users share. Server-backed experiments go through
// the real route and therefore DO increment it — the post-run summary prints
// the headroom impact (Edge case 2).

import fs from "node:fs";
import path from "node:path";
import {
	ENVELOPE_CHUNKS,
	LOW_SIM_DISCLAIMER,
	LOW_SIM_OOS,
	MATCH_COUNT,
	MIN_CHUNK_SIM,
	type RetrievalTrace,
	deriveEnvelopeAtK,
	retrieveChunks,
} from "../../lib/retrieval";
import {
	KNOWLEDGE_HUB_LOW_CONFIDENCE,
	KNOWLEDGE_HUB_OUT_OF_SCOPE,
	KNOWLEDGE_HUB_SYSTEM,
	PROMPT_VERSION,
} from "../../lib/prompts";
import {
	ANSWERER_MODEL,
	CONSISTENCY_REPEATS,
	EMBEDDING_MODEL,
	GOLDEN_PATH,
	K_SWEEP,
	OOC_PROBES_PATH,
	PARAPHRASES_PATH,
	PRODUCTION_K,
	RESULTS_DIR,
	baseUrl,
	costCapUsd,
	judgeModel,
} from "./config";
import { type AnswerResult, askServer, freeEncoder, recordAnswerCost, serverReachable } from "./answer";
import { citationSetKey, extractCitations, scoreCitationValidity } from "./citations";
import { CostAccountant, CostCapError } from "./cost";
import {
	type GoldenRecord,
	type OocProbe,
	type ParaphraseRecord,
	fileSha256,
	isPlaceholderDataset,
	readJsonl,
} from "./datasets";
import { headroomLine, readHeadroom } from "./headroom";
import {
	type ContextChunk,
	type JudgeDeps,
	RUBRIC_VERSION,
	judgeAnswerEquivalence,
	judgeCitationSupport,
	judgeFaithfulness,
	judgeRelevancyQuestions,
} from "./judge";
import {
	clamp01,
	contextPrecisionAtK,
	contextRecallAtK,
	cosineSimilarity,
	hitRateAtK,
	jaccard,
	mean,
	normalizeText,
	reciprocalRank,
	scoreRejection,
	totalAgreement,
} from "./metrics";
import { embedTexts, getEvalOpenAI, meteredOpenAI } from "./openai";
import {
	type CorpusChunk,
	countChunks,
	fetchAllChunks,
	fetchChunksByIds,
	getEvalSupabase,
	verifyGoldenAgainstDb,
} from "./supabase";

const EXPERIMENTS = [
	"baseline",
	"ksweep",
	"consistency",
	"paraphrase",
	"negative",
] as const;
type Experiment = (typeof EXPERIMENTS)[number];

/** Experiments that POST to the dev server (and thus need the bypass key). */
const SERVER_BACKED: Experiment[] = [
	"baseline",
	"consistency",
	"paraphrase",
	"negative",
];

interface Args {
	experiment: Experiment;
	only: string[] | null;
	limit: number | null;
}

function parseArgs(): Args {
	const argv = process.argv.slice(2);
	let experiment: string | undefined;
	let only: string[] | null = null;
	let limit: number | null = null;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--experiment") experiment = argv[++i];
		else if (a.startsWith("--experiment=")) experiment = a.split("=")[1];
		else if (a === "--only") only = (argv[++i] ?? "").split(",").filter(Boolean);
		else if (a.startsWith("--only=")) only = a.split("=")[1].split(",").filter(Boolean);
		else if (a === "--limit") limit = Number(argv[++i]);
		else if (a.startsWith("--limit=")) limit = Number(a.split("=")[1]);
	}
	if (!experiment || !EXPERIMENTS.includes(experiment as Experiment)) {
		throw new Error(
			`--experiment must be one of: ${EXPERIMENTS.join(" | ")} (got ${experiment ?? "nothing"})`,
		);
	}
	if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
		throw new Error("--limit must be a positive integer");
	}
	return { experiment: experiment as Experiment, only, limit };
}

// ---------------------------------------------------------------------------
// Run directory (I2.2)

class RunLog {
	readonly dir: string;
	private itemsPath: string;
	private count = 0;

	constructor(experiment: Experiment) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		this.dir = path.join(RESULTS_DIR, `${stamp}-${experiment}`);
		fs.mkdirSync(this.dir, { recursive: true });
		this.itemsPath = path.join(this.dir, "items.jsonl");
		fs.writeFileSync(this.itemsPath, "");
	}

	/** Append-only: a mid-run abort still leaves a valid log (Edge case 8). */
	append(item: unknown): void {
		fs.appendFileSync(this.itemsPath, `${JSON.stringify(item)}\n`);
		this.count++;
	}

	items(): number {
		return this.count;
	}

	writeManifest(manifest: unknown): void {
		fs.writeFileSync(
			path.join(this.dir, "manifest.json"),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
	}
}

// ---------------------------------------------------------------------------
// Shared scoring helpers

interface JudgeErrorCounts {
	faithfulness: number;
	citation_support: number;
	relevancy: number;
	answer_equivalence: number;
}

function newJudgeErrors(): JudgeErrorCounts {
	return {
		faithfulness: 0,
		citation_support: 0,
		relevancy: 0,
		answer_equivalence: 0,
	};
}

function toContextChunks(
	ids: number[],
	corpus: Map<number, CorpusChunk>,
): ContextChunk[] {
	const out: ContextChunk[] = [];
	for (const id of ids) {
		const c = corpus.get(id);
		if (!c) continue;
		out.push({
			id: c.id,
			regdoc_id: c.regdoc_id,
			section_number: c.section_number,
			text: c.chunk_text,
		});
	}
	return out;
}

/** Did the pipeline take a fallback branch (Edge case 9)? */
function fallbackTaken(a: AnswerResult): "oos_or_guard" | "disclaimer" | null {
	if (a.text.includes(KNOWLEDGE_HUB_OUT_OF_SCOPE)) return "oos_or_guard";
	if (a.text.includes(KNOWLEDGE_HUB_LOW_CONFIDENCE)) return "disclaimer";
	return null;
}

function sourcesOf(a: AnswerResult): Array<{
	id: number;
	regdoc_id: string;
	section_number: string | null;
	similarity: number;
	rank: number;
}> {
	return (a.sources ?? []).map((s, i) => ({
		id: s.id,
		regdoc_id: s.regdoc_id,
		section_number: s.section_number,
		similarity: s.similarity,
		rank: i + 1,
	}));
}

function chargeAnswer(cost: CostAccountant, a: AnswerResult, question: string, label: string): void {
	recordAnswerCost(cost, {
		systemPrompt: KNOWLEDGE_HUB_SYSTEM,
		question,
		envelopeText: (a.sources ?? []).map((s) => s.snippet).join("\n"),
		answer: a.text,
		label,
	});
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs();
	const cap = costCapUsd();
	const cost = new CostAccountant(cap);
	const judgeErrors = newJudgeErrors();
	const startedAt = new Date().toISOString();

	console.log(
		`\n=== rag-eval: ${args.experiment} ===\n` +
			`judge=${judgeModel()} rubric=${RUBRIC_VERSION} answerer=${ANSWERER_MODEL} ` +
			`embed=${EMBEDDING_MODEL}\nPROMPT_VERSION=${PROMPT_VERSION} cap=$${cap.toFixed(2)}`,
	);

	// --- Preflight: NO OpenAI spend before every check below passes ----------
	const supabase = getEvalSupabase();
	const chunkCount = await countChunks(supabase); // throws with the RECOVERY pointer
	console.log(`preflight: supabase ok (${chunkCount} chunks)`);

	const needsServer = SERVER_BACKED.includes(args.experiment);
	if (needsServer) {
		if (!process.env.EVAL_BYPASS_KEY) {
			throw new Error(
				"EVAL_BYPASS_KEY is not set. Without it the anon tier caps this run at " +
					"3 requests/min and 5/day (lib/guard.ts) and the first 429 aborts the " +
					"run (Edge case 2). Set it in .env.local to match the server's value.",
			);
		}
		if (!(await serverReachable())) {
			throw new Error(
				`Dev server not reachable at ${baseUrl()}. Start it yourself with ` +
					"`bun dev` — eval code never starts, restarts, or kills it (I2.11). " +
					"Override the origin with EVAL_BASE_URL.",
			);
		}
		console.log(`preflight: dev server ok at ${baseUrl()}`);
	}

	// Golden set + fingerprint verification (Edge case 6 / I2.10)
	let golden: GoldenRecord[] = [];
	let goldenHash = "";
	if (args.experiment !== "negative") {
		golden = readJsonl<GoldenRecord>(GOLDEN_PATH);
		goldenHash = await fileSha256(GOLDEN_PATH);
		if (isPlaceholderDataset(golden)) {
			throw new Error(
				`${GOLDEN_PATH} is a PLACEHOLDER dataset (records carry placeholder:true). ` +
					"It was committed because Supabase was paused when the framework landed. " +
					"Regenerate it with `bun run eval:rag:golden` — the runner refuses to " +
					"produce scores from placeholder data.",
			);
		}
		const corpusAll = await fetchAllChunks(supabase);
		const fp = await verifyGoldenAgainstDb(golden, corpusAll);
		console.log(
			`preflight: gold chunks — ${fp.ok} ok, ${fp.remapped} re-mapped (id drift), ${fp.missing} missing`,
		);
		if (fp.missing > 0) {
			throw new Error(
				`${fp.missing} gold chunk fingerprints no longer exist in the corpus ` +
					`(questions: ${fp.missingQuestionIds.slice(0, 5).join(", ")}…). The corpus ` +
					"content changed — regenerate the golden set with `bun run eval:rag:golden`. " +
					"Never score against stale ids (I2.10).",
			);
		}
		golden = fp.verified;
		if (args.only) golden = golden.filter((g) => args.only?.includes(g.question_id));
		if (args.limit) golden = golden.slice(0, args.limit);
		console.log(`preflight: ${golden.length} golden records selected`);
	}

	const rawOpenai = getEvalOpenAI();
	const openai = meteredOpenAI(rawOpenai, cost, "eval-retrieval");
	const deps: JudgeDeps = { openai: rawOpenai, cost };
	// DELTA D2: eval-path retrieval must not touch the production circuit breaker.
	const noopRecordUsage = async () => {};

	const runLog = new RunLog(args.experiment);
	console.log(`logging → ${runLog.dir}\n`);

	let aborted = false;
	let abortReason: string | null = null;

	try {
		switch (args.experiment) {
			case "baseline":
				await runBaseline();
				break;
			case "ksweep":
				await runKSweep();
				break;
			case "consistency":
				await runConsistency();
				break;
			case "paraphrase":
				await runParaphrase();
				break;
			case "negative":
				await runNegative();
				break;
		}
	} catch (err) {
		if (err instanceof CostCapError) {
			aborted = true;
			abortReason = err.message;
			console.error(`\nABORTED — ${err.message}`);
		} else {
			throw err;
		}
	}

	// --- Finalize (always, even on abort — Edge case 8) ----------------------
	const headroom = await readHeadroom();
	runLog.writeManifest({
		experiment: args.experiment,
		started_at: startedAt,
		finished_at: new Date().toISOString(),
		aborted,
		abort_reason: abortReason,
		items: runLog.items(),
		prompt_version: PROMPT_VERSION,
		models: {
			answerer: ANSWERER_MODEL,
			judge: judgeModel(),
			embedding: EMBEDDING_MODEL,
			rubric_version: RUBRIC_VERSION,
		},
		config: {
			k: PRODUCTION_K,
			k_sweep: K_SWEEP,
			envelope_chunks: ENVELOPE_CHUNKS,
			match_count: MATCH_COUNT,
			thresholds: {
				LOW_SIM_OOS,
				LOW_SIM_DISCLAIMER,
				MIN_CHUNK_SIM,
			},
			consistency_repeats: CONSISTENCY_REPEATS,
			base_url: needsServer ? baseUrl() : null,
			cost_cap_usd: cap,
		},
		golden_set: { path: GOLDEN_PATH, sha256: goldenHash, records: golden.length },
		judge_errors: judgeErrors,
		cost: cost.snapshot(),
		daily_cap_headroom: headroom,
	});

	console.log("\n--- cost ---");
	for (const line of cost.summaryLines()) console.log(`  ${line}`);
	console.log(`\n--- production budget ---\n  ${headroomLine(headroom)}`);
	console.log(
		`\n--- judge errors ---\n  ${JSON.stringify(judgeErrors)}` +
			"\n  (>5% of judged items in a category invalidates that category — Edge case 3)",
	);
	console.log(`\n${aborted ? "ABORTED" : "DONE"} — ${runLog.items()} items → ${runLog.dir}`);
	freeEncoder();
	if (aborted) process.exit(1);

	// -------------------------------------------------------------------------
	// Experiments
	// -------------------------------------------------------------------------

	/**
	 * BASELINE — full golden set once at production settings (k=8), through the
	 * REAL route. Retrieval metrics come from the `data-sources` frame (that IS
	 * the envelope the LLM saw); generation metrics are judged against the FULL
	 * chunk text pulled from the DB (the frame's snippet is truncated at 260
	 * chars).
	 */
	async function runBaseline(): Promise<void> {
		for (const [i, rec] of golden.entries()) {
			const answer = await askServer(rec.question);
			chargeAnswer(cost, answer, rec.question, `baseline:${rec.question_id}`);

			const sources = sourcesOf(answer);
			const rankedIds = sources.map((s) => s.id);
			const goldIds = new Set(rec.gold_chunks.map((g) => g.chunk_id));
			const fallback = fallbackTaken(answer);

			// Judged metrics need the full text of the chunks the LLM actually saw.
			const corpus = await fetchChunksByIds(supabase, rankedIds);
			const ctx = toContextChunks(rankedIds, corpus);

			const faith = await judgeFaithfulness(deps, {
				question: rec.question,
				answer: answer.text,
				chunks: ctx,
			});
			if (!faith.ok) judgeErrors.faithfulness++;

			const support = await judgeCitationSupport(deps, {
				question: rec.question,
				answer: answer.text,
				chunks: ctx,
			});
			if (!support.ok) judgeErrors.citation_support++;

			// RAGAS Response Relevancy: judge writes 3 questions from the answer,
			// we embed them and score mean cosine vs the original question.
			let relevancyRaw: number | null = null;
			const rq = await judgeRelevancyQuestions(deps, {
				question: rec.question,
				answer: answer.text,
			});
			if (!rq.ok || !rq.value) {
				judgeErrors.relevancy++;
			} else {
				const embs = await embedTexts(
					rawOpenai,
					cost,
					[rec.question, ...rq.value],
					`relevancy:${rec.question_id}`,
				);
				relevancyRaw = mean(
					embs.slice(1).map((e) => cosineSimilarity(embs[0], e)),
				);
			}

			const validity = scoreCitationValidity(answer.text, sources);

			runLog.append({
				experiment: "baseline",
				question_id: rec.question_id,
				question: rec.question,
				origin: rec.origin,
				difficulty: rec.difficulty,
				ground_truth_answer: rec.ground_truth_answer,
				prompt_version: PROMPT_VERSION,
				k: PRODUCTION_K,
				thresholds: { LOW_SIM_OOS, LOW_SIM_DISCLAIMER, MIN_CHUNK_SIM },
				models: {
					answerer: ANSWERER_MODEL,
					judge: judgeModel(),
					embedding: EMBEDDING_MODEL,
				},
				http_status: answer.status,
				latency_ms: answer.latencyMs,
				fallback_taken: fallback,
				gold_chunk_ids: Array.from(goldIds),
				retrieved: sources,
				answer: answer.text,
				citations: extractCitations(answer.text),
				metrics: {
					hit_rate_at_k: hitRateAtK(rankedIds, goldIds, PRODUCTION_K),
					reciprocal_rank: reciprocalRank(rankedIds, goldIds),
					context_recall_at_k: contextRecallAtK(rankedIds, goldIds, PRODUCTION_K),
					context_precision_at_k: contextPrecisionAtK(rankedIds, goldIds, PRODUCTION_K),
					faithfulness: faith.value?.score ?? null,
					faithfulness_no_claims: faith.value?.noClaims ?? null,
					citation_validity: validity.score,
					citation_validity_total: validity.total,
					citation_validity_invalid: validity.invalid,
					citation_support: support.value?.score ?? null,
					citation_support_no_claims: support.value?.noClaims ?? null,
					answer_relevancy_raw: relevancyRaw,
					answer_relevancy: relevancyRaw === null ? null : clamp01(relevancyRaw),
				},
				judge: {
					faithfulness: { ok: faith.ok, cached: faith.cached, reasons: faith.reasons, error: faith.error, claims: faith.value?.claims },
					citation_support: { ok: support.ok, cached: support.cached, reasons: support.reasons, error: support.error, claims: support.value?.claims },
					relevancy: { ok: rq.ok, cached: rq.cached, reasons: rq.reasons, error: rq.error, questions: rq.value },
				},
				timestamp: new Date().toISOString(),
				cost_so_far_usd: cost.totalUsd(),
			});
			console.log(
				`[${i + 1}/${golden.length}] ${rec.question_id} hit@8=${hitRateAtK(rankedIds, goldIds, PRODUCTION_K)} ` +
					`faith=${faith.value?.score?.toFixed(2) ?? "n/a"} $${cost.totalUsd().toFixed(4)}`,
			);
		}
	}

	/**
	 * KSWEEP — retrieval only, entirely OFFLINE (no dev server, no answerer, no
	 * judge). One retrieval per question yields a trace; deriveEnvelopeAtK
	 * replays the route's own envelope selection at each k, so the sweep is
	 * guaranteed identical to what the route would have selected — one embedding
	 * spend for four k values. Embeddings are the ONLY cost.
	 */
	async function runKSweep(): Promise<void> {
		for (const [i, rec] of golden.entries()) {
			const res = await retrieveChunks(
				rec.question,
				{ supabase, openai, recordUsage: noopRecordUsage },
				{ envelopeChunks: PRODUCTION_K, withTrace: true },
			);
			const trace = res.trace as RetrievalTrace;
			const goldIds = new Set(rec.gold_chunks.map((g) => g.chunk_id));
			const perK: Record<string, unknown> = {};
			for (const k of K_SWEEP) {
				const env = deriveEnvelopeAtK(trace, k);
				const ids = env.map((c) => c.id).slice(0, k);
				perK[`k${k}`] = {
					retrieved_ids: ids,
					hit_rate: hitRateAtK(ids, goldIds, k),
					reciprocal_rank: reciprocalRank(ids, goldIds),
					context_recall: contextRecallAtK(ids, goldIds, k),
					context_precision: contextPrecisionAtK(ids, goldIds, k),
				};
			}
			runLog.append({
				experiment: "ksweep",
				question_id: rec.question_id,
				question: rec.question,
				origin: rec.origin,
				difficulty: rec.difficulty,
				prompt_version: PROMPT_VERSION,
				models: { embedding: EMBEDDING_MODEL },
				thresholds: { LOW_SIM_OOS, LOW_SIM_DISCLAIMER, MIN_CHUNK_SIM },
				gold_chunk_ids: Array.from(goldIds),
				decision: trace.decision,
				top_sim: trace.topSim,
				expansions: trace.expansions,
				pool: trace.pool.map((e) => ({
					id: e.chunk.id,
					regdoc_id: e.chunk.regdoc_id,
					section_number: e.chunk.section_number,
					similarity: e.similarity,
					score: e.score,
					boosted: e.boosted,
					rank_pre_boost: e.rankPreBoost,
					rank_post_boost: e.rankPostBoost,
				})),
				k_sweep: perK,
				timestamp: new Date().toISOString(),
				cost_so_far_usd: cost.totalUsd(),
			});
			console.log(
				`[${i + 1}/${golden.length}] ${rec.question_id} ` +
					K_SWEEP.map((k) => `hit@${k}=${(perK[`k${k}`] as { hit_rate: number }).hit_rate}`).join(" ") +
					` $${cost.totalUsd().toFixed(4)}`,
			);
		}
	}

	/**
	 * CONSISTENCY — every golden question x5 at fixed settings, through the real
	 * route with the regenerate trigger (so the Redis answer cache cannot fake
	 * agreement — Edge case 7). Deterministic-first (cost control): the primary
	 * KPI is citation-set agreement; the answer-equivalence judge is invoked ONLY
	 * for repeat pairs whose citation sets differ.
	 */
	async function runConsistency(): Promise<void> {
		for (const [i, rec] of golden.entries()) {
			const runs: AnswerResult[] = [];
			for (let r = 0; r < CONSISTENCY_REPEATS; r++) {
				const a = await askServer(rec.question);
				chargeAnswer(cost, a, rec.question, `consistency:${rec.question_id}:r${r}`);
				runs.push(a);
			}
			const citationKeys = runs.map((a) => citationSetKey(a.text));
			const textKeys = runs.map((a) => normalizeText(a.text));
			const citationAgreement = totalAgreement(citationKeys);
			const tarr = totalAgreement(textKeys);

			// Judge ONLY the citation-disagreeing pairs.
			const equivalences: Array<{
				i: number;
				j: number;
				equivalent: boolean | null;
				reasons?: string;
				cached: boolean;
			}> = [];
			for (let a = 0; a < runs.length; a++) {
				for (let b = a + 1; b < runs.length; b++) {
					if (citationKeys[a] === citationKeys[b]) continue;
					const eq = await judgeAnswerEquivalence(deps, {
						question: rec.question,
						answerA: runs[a].text,
						answerB: runs[b].text,
					});
					if (!eq.ok) judgeErrors.answer_equivalence++;
					equivalences.push({
						i: a,
						j: b,
						equivalent: eq.value?.equivalent ?? null,
						reasons: eq.reasons,
						cached: eq.cached,
					});
				}
			}
			const judged = equivalences.filter((e) => e.equivalent !== null);
			runLog.append({
				experiment: "consistency",
				question_id: rec.question_id,
				question: rec.question,
				prompt_version: PROMPT_VERSION,
				repeats: CONSISTENCY_REPEATS,
				k: PRODUCTION_K,
				models: { answerer: ANSWERER_MODEL, judge: judgeModel() },
				runs: runs.map((a, idx) => ({
					repeat: idx,
					http_status: a.status,
					latency_ms: a.latencyMs,
					answer: a.text,
					citation_set: citationKeys[idx],
					retrieved: sourcesOf(a),
					fallback_taken: fallbackTaken(a),
				})),
				metrics: {
					citation_set_agreement: citationAgreement,
					tarr_exact_text_agreement: tarr,
					// Of the pairs that DID disagree on citations, how many are still
					// substantively the same answer?
					disagreeing_pairs: equivalences.length,
					equivalent_pairs: judged.filter((e) => e.equivalent).length,
					equivalence_rate:
						judged.length === 0 ? null : judged.filter((e) => e.equivalent).length / judged.length,
				},
				judge: { answer_equivalence: equivalences },
				timestamp: new Date().toISOString(),
				cost_so_far_usd: cost.totalUsd(),
			});
			console.log(
				`[${i + 1}/${golden.length}] ${rec.question_id} citation-agree=${citationAgreement} ` +
					`TARr=${tarr} disagreeing-pairs=${equivalences.length} $${cost.totalUsd().toFixed(4)}`,
			);
		}
	}

	/**
	 * PARAPHRASE — 3 paraphrases per stratified golden question vs the canonical
	 * phrasing: retrieval Jaccard over the top-k chunk-id sets (production truth,
	 * from `data-sources`) + judged answer-equivalence.
	 */
	async function runParaphrase(): Promise<void> {
		const paraphrases = readJsonl<ParaphraseRecord>(PARAPHRASES_PATH);
		if (paraphrases.some((p) => p.placeholder === true)) {
			throw new Error(
				`${PARAPHRASES_PATH} is a PLACEHOLDER dataset — regenerate with \`bun run eval:rag:golden\`.`,
			);
		}
		const byParent = new Map<string, ParaphraseRecord[]>();
		for (const p of paraphrases) {
			const list = byParent.get(p.parent_question_id) ?? [];
			list.push(p);
			byParent.set(p.parent_question_id, list);
		}
		const parents = golden.filter((g) => byParent.has(g.question_id));
		for (const [i, rec] of parents.entries()) {
			const canonical = await askServer(rec.question);
			chargeAnswer(cost, canonical, rec.question, `paraphrase:${rec.question_id}:canonical`);
			const canonicalIds = new Set(sourcesOf(canonical).map((s) => s.id));
			const canonicalCitations = citationSetKey(canonical.text);

			const results: unknown[] = [];
			for (const p of byParent.get(rec.question_id) ?? []) {
				const a = await askServer(p.question);
				chargeAnswer(cost, a, p.question, `paraphrase:${p.paraphrase_id}`);
				const ids = new Set(sourcesOf(a).map((s) => s.id));
				const eq = await judgeAnswerEquivalence(deps, {
					question: rec.question,
					answerA: canonical.text,
					answerB: a.text,
				});
				if (!eq.ok) judgeErrors.answer_equivalence++;
				results.push({
					paraphrase_id: p.paraphrase_id,
					question: p.question,
					http_status: a.status,
					answer: a.text,
					retrieved: sourcesOf(a),
					fallback_taken: fallbackTaken(a),
					metrics: {
						retrieval_jaccard: jaccard(canonicalIds, ids),
						citation_set_stable: citationSetKey(a.text) === canonicalCitations ? 1 : 0,
						answer_equivalent: eq.value?.equivalent ?? null,
					},
					judge: { answer_equivalence: { ok: eq.ok, cached: eq.cached, reasons: eq.reasons, error: eq.error } },
				});
			}
			runLog.append({
				experiment: "paraphrase",
				question_id: rec.question_id,
				question: rec.question,
				prompt_version: PROMPT_VERSION,
				k: PRODUCTION_K,
				models: { answerer: ANSWERER_MODEL, judge: judgeModel() },
				canonical: {
					answer: canonical.text,
					retrieved: sourcesOf(canonical),
					citation_set: canonicalCitations,
					fallback_taken: fallbackTaken(canonical),
				},
				paraphrases: results,
				timestamp: new Date().toISOString(),
				cost_so_far_usd: cost.totalUsd(),
			});
			console.log(
				`[${i + 1}/${parents.length}] ${rec.question_id} paraphrases=${results.length} $${cost.totalUsd().toFixed(4)}`,
			);
		}
	}

	/**
	 * NEGATIVE — the out-of-corpus probe set (RGB-style rejection rate). Almost
	 * entirely deterministic: a probe intercepted by the jailbreak guard or the
	 * similarity OOS gate is a rejection SUCCESS, not an error (I2.9 / Edge case
	 * 4); a REGDOC/NSCA citation inside a rejection is a fabrication FAILURE.
	 * The false-rejection rate comes from the baseline run, not from here.
	 */
	async function runNegative(): Promise<void> {
		let probes = readJsonl<OocProbe>(OOC_PROBES_PATH);
		if (args.only) probes = probes.filter((p) => args.only?.includes(p.probe_id));
		if (args.limit) probes = probes.slice(0, args.limit);
		console.log(`preflight: ${probes.length} OOC probes selected\n`);
		for (const [i, probe] of probes.entries()) {
			const a = await askServer(probe.question);
			chargeAnswer(cost, a, probe.question, `negative:${probe.probe_id}`);
			const verdict = scoreRejection({
				status: a.status,
				text: a.text,
				hasSourcesFrame: a.sources !== null,
				oosLine: KNOWLEDGE_HUB_OUT_OF_SCOPE,
				lowConfidenceLine: KNOWLEDGE_HUB_LOW_CONFIDENCE,
			});
			runLog.append({
				experiment: "negative",
				probe_id: probe.probe_id,
				question: probe.question,
				category: probe.category,
				prompt_version: PROMPT_VERSION,
				models: { answerer: ANSWERER_MODEL },
				http_status: a.status,
				latency_ms: a.latencyMs,
				answer: a.text,
				retrieved: sourcesOf(a),
				citations: extractCitations(a.text),
				metrics: {
					rejection_success: verdict.success ? 1 : 0,
					layer: verdict.layer,
					fabricated_citations: verdict.fabricatedCitations,
					reason: verdict.reason,
				},
				timestamp: new Date().toISOString(),
				cost_so_far_usd: cost.totalUsd(),
			});
			console.log(
				`[${i + 1}/${probes.length}] ${probe.probe_id} reject=${verdict.success ? "PASS" : "FAIL"} ` +
					`layer=${verdict.layer} $${cost.totalUsd().toFixed(4)}`,
			);
		}
	}
}

try {
	await main();
} catch (err) {
	console.error(`\nFAILED — ${(err as Error).message}`);
	freeEncoder();
	process.exit(1);
}
