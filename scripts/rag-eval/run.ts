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
import { type RetrievedChunk, buildContextEnvelope } from "../../lib/context-envelope";
import {
	ENVELOPE_CHUNKS,
	LOW_SIM_DISCLAIMER,
	LOW_SIM_OOS,
	MATCH_COUNT,
	MIN_CHUNK_SIM,
	type RetrievalTrace,
	envelopeIdsAtK,
	postFilterRankedIdsFromTrace,
	retrieveChunks,
} from "../../lib/retrieval";
import {
	KNOWLEDGE_HUB_SYSTEM,
	PROMPT_VERSION,
	stripLimitedContextPrefix,
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
import {
	type AnswerResult,
	askServer,
	freeEncoder,
	recordAnswerCost,
	reserveAnswerCost,
	serverReachable,
} from "./answer";
import { citationSetKey, extractCitations, scoreCitationValidity } from "./citations";
import { CostAccountant, asCostCapError } from "./cost";
import {
	type GoldenRecord,
	type OocProbe,
	type ParaphraseRecord,
	fileSha256,
	isPlaceholderDataset,
	readJsonl,
} from "./datasets";
import {
	DAILY_CAP_CALLS_PER_REQUEST,
	type Headroom,
	headroomBlocksRun,
	headroomLine,
	projectDailyCapCalls,
	readHeadroom,
} from "./headroom";
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
	RETRIEVAL_METRIC_STAGE,
	type RouteBranch,
	clamp01,
	classifyBranch,
	cosineSimilarity,
	kSweepExclusion,
	mean,
	reciprocalRank,
	scoreConsistency,
	scoreEnvelopeAtK,
	scoreParaphrasePair,
	scoreRejection,
	scoreRetrievalStages,
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

type EvalSupabase = ReturnType<typeof getEvalSupabase>;

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

/**
 * Which branch of the route produced this response (Edge case 9)?
 *
 * PR #8 fix round 1 (issue 2): was matching KNOWLEDGE_HUB_LOW_CONFIDENCE to
 * detect the route's disclaimer branch — a string the app never emits there.
 * classifyBranch() matches what the app ACTUALLY emits, via the shared
 * lowercased-substring markers in lib/prompts.ts.
 */
function fallbackTaken(a: AnswerResult): RouteBranch {
	// RAW text on purpose — branch detection exists to find the route's own
	// disclaimer/refusal lines, so it is the ONE consumer that must not strip them
	// (issue 4).
	return classifyBranch({ text: a.text, hasSourcesFrame: a.sources !== null });
}

/**
 * The MODEL's output, with the route's boilerplate removed (PR #8 fix round 2,
 * issue 4). This — not `answer.text` — is what any judge, claim decomposer, or
 * citation extractor must see.
 *
 * The low-avg-similarity branch PREPENDS KNOWLEDGE_HUB_LIMITED_CONTEXT ("Limited
 * matches in the indexed corpus…") to an otherwise normal answer. The eval used
 * to feed that raw text straight to judgeFaithfulness, judgeCitationSupport,
 * judgeRelevancyQuestions, scoreCitationValidity and normalizeText. A
 * claim-decomposition judge reads the disclaimer as one more claim — unsupported
 * by any chunk, carrying no citation — so faithfulness and citation support were
 * systematically DEFLATED, and only on the weak-retrieval questions, i.e. the
 * hardest ones. Our own boilerplate was being scored as if the model had written
 * it. A metric deflated by our own plumbing is exactly as dishonest as one
 * inflated by a vacuous pass; this PR exists to stamp out both directions.
 */
function judgedText(a: AnswerResult): string {
	return stripLimitedContextPrefix(a.text);
}

function sourcesOf(a: AnswerResult): Array<{
	id: number;
	regdoc_id: string;
	section_number: string | null;
	similarity: number;
	rank: number;
}> {
	// `rank` here is POSITION IN THE data-sources FRAME — i.e. the
	// diversity-reordered envelope (selectDiverseEnvelope), NOT similarity rank.
	// It is logged for traceability only. Rank-sensitive metrics (MRR, CP@K)
	// must NEVER be computed from it — see runBaseline's trace-derived
	// similarity ranking (issue 7a).
	return (a.sources ?? []).map((s, i) => ({
		id: s.id,
		regdoc_id: s.regdoc_id,
		section_number: s.section_number,
		similarity: s.similarity,
		envelope_position: i + 1,
		rank: i + 1,
	}));
}

/** Worst-case pre-spend reservation for ONE server answer (issue 4a). */
function reserveAnswer(cost: CostAccountant, question: string, label: string): void {
	reserveAnswerCost(cost, {
		systemPrompt: KNOWLEDGE_HUB_SYSTEM,
		question,
		envelopeChunks: ENVELOPE_CHUNKS,
		label,
	});
}

/**
 * Charge the accountant for one server answer.
 *
 * PR #8 fix round 1 (issue 3): the answerer's input used to be estimated from
 * `sources[].snippet` — the SSE DISPLAY projection, `chunk_text.slice(0, 260)`
 * (route.ts). The model's real prompt carries the FULL ~400-token `chunk_text`
 * through buildContextEnvelope, so the estimate ran 4-6x LOW and real spend
 * systematically exceeded what EVAL_COST_CAP_USD bounded. We now fetch the full
 * chunk text by id and rebuild the REAL envelope with the production builder.
 * Any chunk we cannot resolve is charged at the err-high snippet correction
 * factor (answer.ts) — the estimate may over-charge, never under-charge.
 */
async function chargeAnswer(
	supabase: EvalSupabase,
	cost: CostAccountant,
	a: AnswerResult,
	question: string,
	label: string,
): Promise<void> {
	const src = a.sources ?? [];
	const corpus = await fetchChunksByIds(
		supabase,
		src.map((s) => s.id),
	);
	const chunks: RetrievedChunk[] = [];
	const unresolvedSnippets: string[] = [];
	for (const s of src) {
		const full = corpus.get(s.id);
		if (!full) {
			unresolvedSnippets.push(s.snippet);
			continue;
		}
		chunks.push({
			id: full.id,
			regdoc_id: full.regdoc_id,
			section_number: full.section_number,
			section_title: full.section_title,
			chunk_text: full.chunk_text,
			url: s.url,
			requirement_type: full.requirement_type,
			similarity: s.similarity,
		});
	}
	// buildContextEnvelope's third argument is the route's `mentionedDocs`, which
	// the SSE frame does not carry. Passing the envelope's distinct regdoc_ids
	// reproduces the MULTI-DOC SCOPE cue whenever the real prompt could have had
	// one (and adds it in a few cases where the real prompt did not) — err high.
	const distinctDocs = Array.from(new Set(chunks.map((c) => c.regdoc_id)));
	recordAnswerCost(cost, {
		systemPrompt: KNOWLEDGE_HUB_SYSTEM,
		question,
		envelopeText: buildContextEnvelope(chunks, question, distinctDocs),
		unresolvedSnippets,
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

	// Datasets the server-backed experiments consume are read HERE, in preflight,
	// so the daily-cap projection below knows exactly how many requests the run
	// will make — before a cent is spent (issue 5).
	let probes: OocProbe[] = [];
	if (args.experiment === "negative") {
		probes = readJsonl<OocProbe>(OOC_PROBES_PATH);
		if (args.only) probes = probes.filter((p) => args.only?.includes(p.probe_id));
		if (args.limit) probes = probes.slice(0, args.limit);
		console.log(`preflight: ${probes.length} OOC probes selected`);
	}

	let paraphrasesByParent = new Map<string, ParaphraseRecord[]>();
	let paraphraseParents: GoldenRecord[] = [];
	if (args.experiment === "paraphrase") {
		const paraphrases = readJsonl<ParaphraseRecord>(PARAPHRASES_PATH);
		if (paraphrases.some((p) => p.placeholder === true)) {
			throw new Error(
				`${PARAPHRASES_PATH} is a PLACEHOLDER dataset — regenerate with \`bun run eval:rag:golden\`.`,
			);
		}
		paraphrasesByParent = new Map<string, ParaphraseRecord[]>();
		for (const p of paraphrases) {
			const list = paraphrasesByParent.get(p.parent_question_id) ?? [];
			list.push(p);
			paraphrasesByParent.set(p.parent_question_id, list);
		}
		paraphraseParents = golden.filter((g) => paraphrasesByParent.has(g.question_id));
		console.log(
			`preflight: ${paraphraseParents.length} paraphrase parents selected ` +
				`(${paraphrases.length} paraphrases)`,
		);
	}

	// --- Preflight: PRODUCTION daily-cap headroom (Edge case 2 / issue 5) ------
	//
	// The answer harness deliberately POSTs the REAL production route — that is
	// the only honest way to score generation. `x-eval-bypass` skips the CHECK,
	// but a bypassed request still INCREMENTS the shared counter
	// (recordOpenAICall), so this battery DOES consume the GLOBAL_DAILY_CAP=2000
	// budget real users share. Reading the counter only in FINALIZE (as this
	// framework used to) tells you what you burned AFTER you burned it. Project
	// the spend and ABORT here if the headroom cannot absorb it.
	let headroomAtStart: Headroom | null = null;
	let projectedServerCalls = 0;
	if (needsServer) {
		const requests =
			args.experiment === "baseline"
				? golden.length
				: args.experiment === "consistency"
					? golden.length * CONSISTENCY_REPEATS
					: args.experiment === "negative"
						? probes.length
						: paraphraseParents.reduce(
								(acc, p) =>
									acc + 1 + (paraphrasesByParent.get(p.question_id)?.length ?? 0),
								0,
							);
		projectedServerCalls = projectDailyCapCalls(requests);
		headroomAtStart = await readHeadroom();
		console.log(
			`preflight: ${headroomLine(headroomAtStart)}\n` +
				`preflight: this run projects ${requests} server requests → ` +
				`~${projectedServerCalls} daily-cap calls ` +
				`(${DAILY_CAP_CALLS_PER_REQUEST} per request: embedding + completion)`,
		);
		if (headroomBlocksRun(headroomAtStart, projectedServerCalls)) {
			throw new Error(
				`Production daily-cap headroom is too low for this run: ${headroomAtStart.remaining} ` +
					`calls left of ${headroomAtStart.cap}, but this experiment projects ~${projectedServerCalls}. ` +
					"Real users share that counter (lib/guard.ts GLOBAL_DAILY_CAP) — running anyway could " +
					"circuit-break production. Aborted BEFORE any spend. Wait for the UTC-midnight reset, " +
					"or shrink the run with --limit / --only.",
			);
		}
		if (!headroomAtStart.available) {
			console.warn(
				`preflight: WARNING — daily-cap headroom is UNREADABLE (${headroomAtStart.reason}). ` +
					`Cannot verify this run's ~${projectedServerCalls} calls fit the budget real users share.`,
			);
		}
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
		// asCostCapError, not `instanceof` (PR #8 fix round 1, issue 4b): a cap
		// trip raised inside an eval retrieval embedding is re-thrown by
		// lib/retrieval.ts as RetrievalError("embedding", err). The old bare
		// instanceof check MISSED it, rethrew, and skipped this finalize block —
		// no manifest.json, no cost totals, and the operator saw
		// "retrieval_failed:embedding", which reads like an outage and invites a
		// re-run (i.e. MORE spend). A cap trip must ALWAYS land here.
		const capped = asCostCapError(err);
		if (capped) {
			aborted = true;
			abortReason = capped.message;
			console.error(`\nABORTED — ${capped.message}`);
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
		// Issue 5: what we projected before the run vs what the counter said at
		// the start. The answer harness runs the REAL production route, so this
		// budget is genuinely shared with real users — it is not an eval-only
		// number and the report must say so.
		daily_cap_headroom_at_start: headroomAtStart,
		projected_daily_cap_calls: projectedServerCalls,
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
	 * REAL route. Generation metrics are judged against the FULL chunk text
	 * pulled from the DB (the frame's snippet is truncated at 260 chars).
	 *
	 * PR #8 fix round 1 (issue 7b) + fix round 2 (issue 2): every retrieval metric
	 * reads the STAGE its definition requires, and says which one.
	 *
	 *   hit rate@8 / context recall@8 / context precision CP@8  →  ENVELOPE.
	 *     RAGAS scores these over `retrieved_contexts` — the window handed to the
	 *     generator. Ours is the envelope, and the `data-sources` frame IS that
	 *     envelope in prompt order (route.ts builds the frame from the same array
	 *     it passes to buildContextEnvelope). Round 1 moved them onto the trace's
	 *     candidate POOL, which is the unfiltered match_regdoc_chunks output — a
	 *     superset production never shows the model. Scoring "did the model get
	 *     the gold chunk?" against chunks the model never saw answers a different
	 *     question than the one the row claims to answer.
	 *
	 *   MRR  →  POST-FILTER SIMILARITY-RANKED POOL.
	 *     A rank metric needs a genuine ranking (round 1 was right: the envelope
	 *     is diversity-reordered and named-doc-boosted, so it is not one). But the
	 *     honest denominator is the pool production could actually surface: chunks
	 *     below MIN_CHUNK_SIM are ineligible, so ranking them credits the
	 *     retriever with a rank the pipeline discards.
	 *
	 * Exclusions, always counted and never a silent 0 or 1: on the OOS/guard
	 * branch the route emits NO envelope and NO eligible pool — retrieval quality
	 * is NOT MEASURABLE there, so it is null (not 0). An item with no gold chunks
	 * is excluded too (empty denominator). Silent zeros are as dishonest as
	 * silent ones.
	 */
	async function runBaseline(): Promise<void> {
		for (const [i, rec] of golden.entries()) {
			reserveAnswer(cost, rec.question, `baseline:${rec.question_id}`);
			const answer = await askServer(rec.question);
			await chargeAnswer(supabase, cost, answer, rec.question, `baseline:${rec.question_id}`);

			const sources = sourcesOf(answer);
			// STAGE: envelope. The `data-sources` frame is built from the very array
			// the route hands to buildContextEnvelope (route.ts), so its ORDER is the
			// prompt order the model reads. It is production truth for this stage —
			// no re-derivation, no drift.
			const envelopeIds = sources.map((s) => s.id);
			const goldIds = new Set(rec.gold_chunks.map((g) => g.chunk_id));
			const fallback = fallbackTaken(answer);

			// The trace supplies the stages the SSE frame cannot: the raw candidate
			// pool and the MIN_CHUNK_SIM-eligible ranked pool (fix round 2, issue 2).
			let trace: RetrievalTrace | null = null;
			let traceError: string | null = null;
			try {
				const res = await retrieveChunks(
					rec.question,
					{ supabase, openai, recordUsage: noopRecordUsage },
					{ envelopeChunks: PRODUCTION_K, withTrace: true },
				);
				trace = res.trace ?? null;
			} catch (err) {
				const capped = asCostCapError(err);
				if (capped) throw capped;
				traceError = (err as Error).message;
			}
			// The stage each metric scores is decided INSIDE scoreRetrievalStages —
			// a pure, unit-tested function — so this call site cannot wire a metric to
			// the wrong pool (issue 2). It hands over the SERVED envelope (production
			// truth) and the trace (the only source of the pool stages) and gets back
			// stage-correct scores plus a reason for every exclusion.
			const retrievalMetrics = scoreRetrievalStages({
				goldIds,
				k: PRODUCTION_K,
				servedEnvelopeIds: answer.sources === null ? null : envelopeIds,
				trace,
				traceError,
			});
			const { envelopeExcludedReason, mrrExcludedReason } = retrievalMetrics;
			const envelopeMeasurable = envelopeExcludedReason === null;
			const mrrMeasurable = mrrExcludedReason === null;

			// Logged for diagnosis; no reported metric scores the raw pool.
			const postFilterRankedIds = trace
				? postFilterRankedIdsFromTrace(trace)
				: [];
			const rawRankedIds = trace ? trace.stages.rawRankedIds : [];

			// Integrity canary: the offline trace must reproduce the envelope the
			// SERVER actually served, or the pool-stage metric above is describing a
			// different retrieval than the one that produced this answer.
			const traceEnvelopeAgrees =
				trace === null || answer.sources === null
					? null
					: JSON.stringify(envelopeIdsAtK(trace, PRODUCTION_K)) ===
							JSON.stringify(envelopeIds)
						? 1
						: 0;

			// Judged metrics need the full text of the chunks the LLM actually saw.
			const corpus = await fetchChunksByIds(supabase, envelopeIds);
			const ctx = toContextChunks(envelopeIds, corpus);

			// ISSUE 4: judges see the MODEL's output, never the route's boilerplate.
			// The low-similarity branch prepends KNOWLEDGE_HUB_LIMITED_CONTEXT, and a
			// claim-decomposition judge scores that sentence as an unsupported, uncited
			// claim — deflating faithfulness and citation support on exactly the
			// weak-retrieval questions where the disclaimer fires.
			const judged = judgedText(answer);
			const boilerplateStripped = judged !== answer.text;

			const faith = await judgeFaithfulness(deps, {
				question: rec.question,
				answer: judged,
				chunks: ctx,
			});
			if (!faith.ok) judgeErrors.faithfulness++;

			const support = await judgeCitationSupport(deps, {
				question: rec.question,
				answer: judged,
				chunks: ctx,
			});
			if (!support.ok) judgeErrors.citation_support++;

			// RAGAS Response Relevancy: judge writes 3 questions from the answer,
			// we embed them and score mean cosine vs the original question. Fed the
			// raw text, the judge reverse-engineers a question ABOUT THE DISCLAIMER —
			// which is orthogonal to the user's question, so the cosine (and the score)
			// drops for a reason that has nothing to do with the model.
			let relevancyRaw: number | null = null;
			const rq = await judgeRelevancyQuestions(deps, {
				question: rec.question,
				answer: judged,
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

			const validity = scoreCitationValidity(judged, sources);

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
				// The THREE stages, logged distinctly (issue 2). Each reported metric
				// names the one it scores; nothing is scored against a list the
				// pipeline never surfaced.
				stages: {
					envelope_ids: envelopeIds,
					post_filter_ranked_ids: postFilterRankedIds,
					raw_ranked_ids: rawRankedIds,
				},
				retrieval_metric_stage: RETRIEVAL_METRIC_STAGE,
				retrieval_excluded_reason: envelopeExcludedReason,
				mrr_excluded_reason: mrrExcludedReason,
				// Does the offline trace reproduce the envelope the SERVER served? If
				// not, the pool-stage metric is describing a different retrieval than
				// the one that produced this answer — and the report must say so.
				trace_envelope_agrees: traceEnvelopeAgrees,
				// RAW answer (what the user would see) is logged verbatim; every judged
				// metric above scored `judged_answer` — the same text with the route's
				// disclaimer boilerplate removed (issue 4).
				answer: answer.text,
				judged_answer: judged,
				boilerplate_stripped: boilerplateStripped,
				citations: extractCitations(judged),
				metrics: {
					// null (EXCLUDED, not 0) when the stage this metric scores does not
					// exist for the item — round 1 issue 7b, round 2 issue 2.
					hit_rate_at_k: retrievalMetrics.hit_rate_at_k,
					context_recall_at_k: retrievalMetrics.context_recall_at_k,
					context_precision_at_k: retrievalMetrics.context_precision_at_k,
					reciprocal_rank: retrievalMetrics.reciprocal_rank,
					retrieval_measurable: envelopeMeasurable ? 1 : 0,
					mrr_measurable: mrrMeasurable ? 1 : 0,
					trace_envelope_agrees: traceEnvelopeAgrees,
					faithfulness: faith.value?.score ?? null,
					faithfulness_no_claims: faith.value?.noClaims ?? null,
					// FULL-denominator companion (fix round 2, final audit — the same
					// vacuous-pass shape as citation coverage). Faithfulness is EXCLUDED
					// for an answer that makes no verifiable claim (a refusal makes none),
					// so without this row the faithfulness % could read 100% over a
					// handful of items while every refusal silently left the denominator.
					faithfulness_claim_coverage: faith.value
						? faith.value.noClaims
							? 0
							: 1
						: null,
					// null (EXCLUDED, not 1.0) when the answer cites NOTHING — issue 1.
					// A vacuous case is not a perfect score. `citation_coverage` is the
					// companion that makes zero-citation-ness visible in the report.
					citation_validity: validity.score,
					citation_coverage: validity.hasCitations,
					citation_count: validity.total,
					citation_validity_total: validity.total,
					citation_validity_invalid: validity.invalid,
					citation_support: support.value?.score ?? null,
					citation_support_no_claims: support.value?.noClaims ?? null,
					citation_support_claim_coverage: support.value
						? support.value.noClaims
							? 0
							: 1
						: null,
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
				`[${i + 1}/${golden.length}] ${rec.question_id} ` +
					`hit@8=${retrievalMetrics.hit_rate_at_k ?? `excluded(${envelopeExcludedReason})`} ` +
					`mrr=${retrievalMetrics.reciprocal_rank?.toFixed(2) ?? `excluded(${mrrExcludedReason})`} ` +
					`cite=${validity.total === 0 ? "NONE" : `${validity.valid}/${validity.total}`} ` +
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

			// Fix round 2 (issue 2), ksweep semantics re-verified. The sweep scores
			// the ENVELOPE the route would select at each k — that selection IS what
			// the sweep is about. Two exclusions, both counted:
			//
			//  - OOS items. The gate fires on the RAW pool's top-1 and is therefore
			//    k-INDEPENDENT: at every k the route refuses and builds NO envelope.
			//    deriveEnvelopeAtK still hands back the full ranked pool there
			//    (it mirrors retrieveChunks' return value, which the route discards),
			//    so the old code sliced that pool to k and could score hit@k = 1 for
			//    a question production actually REFUSED. That is a flattering number
			//    for a pool nobody was shown. Excluded, with a reason — and excluding
			//    them keeps the denominator CONSTANT across k, without which the
			//    across-k comparison the sweep exists for is not even well-formed.
			//  - Items with no gold chunk: the |gold| denominator is empty.
			const excludedReason = kSweepExclusion(trace, goldIds);
			const measurable = excludedReason === null;

			const perK: Record<string, unknown> = {};
			for (const k of K_SWEEP) {
				// STAGE: envelope@k — decided inside scoreEnvelopeAtK, which reads
				// envelopeIdsAtK ([] on the OOS branch), never deriveEnvelopeAtK.
				perK[`k${k}`] = scoreEnvelopeAtK({
					trace,
					goldIds,
					k,
					excludedReason,
				});
			}

			// MRR is k-INDEPENDENT: it ranks the post-filter candidate pool, which the
			// envelope size does not change. Reporting it inside the per-k block (as
			// the old code did, over the k-truncated envelope) implied a k-sensitivity
			// the metric does not have. It gets one item-level value, stage-named.
			const postFilterRankedIds = postFilterRankedIdsFromTrace(trace);
			const mrrMeasurable = measurable && postFilterRankedIds.length > 0;

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
				stages: {
					post_filter_ranked_ids: postFilterRankedIds,
					raw_ranked_ids: trace.stages.rawRankedIds,
				},
				retrieval_metric_stage: RETRIEVAL_METRIC_STAGE,
				ksweep_excluded_reason: excludedReason,
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
				metrics: {
					// STAGE: post_filter_pool. k-independent by construction.
					reciprocal_rank: mrrMeasurable
						? reciprocalRank(postFilterRankedIds, goldIds)
						: null,
					ksweep_measurable: measurable ? 1 : 0,
				},
				timestamp: new Date().toISOString(),
				cost_so_far_usd: cost.totalUsd(),
			});
			console.log(
				`[${i + 1}/${golden.length}] ${rec.question_id} ` +
					(measurable
						? K_SWEEP.map(
								(k) =>
									`hit@${k}=${(perK[`k${k}`] as { hit_rate: number }).hit_rate}`,
							).join(" ")
						: `EXCLUDED(${excludedReason})`) +
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
				const label = `consistency:${rec.question_id}:r${r}`;
				reserveAnswer(cost, rec.question, label);
				const a = await askServer(rec.question);
				await chargeAnswer(supabase, cost, a, rec.question, label);
				runs.push(a);
			}
			// ISSUE 4: compare the MODEL's output, not the route's boilerplate. The
			// low-similarity disclaimer is deterministic route text; letting it into
			// TARr means a repeat that flipped across the LOW_SIM_DISCLAIMER threshold
			// scores as model disagreement when the model may have said the same thing.
			const judgedRuns = runs.map((a) => judgedText(a));
			const citationKeys = judgedRuns.map((t) => citationSetKey(t));

			// ISSUE 1a: the vacuous-pass bug, still alive here after round 1.
			// citationSetKey used to return "" for a zero-citation answer, and
			// totalAgreement(["","","","",""]) = 1 — so the headline citation-stability
			// KPI reported PERFECT consistency precisely when the model cited nothing
			// at all, five times over. Two answers that both cited nothing are not
			// consistent; they are both uncitable. scoreConsistency EXCLUDES those
			// (with a counted reason) and surfaces them through a full-denominator
			// citation-coverage companion. It also excludes TARr when every repeat took
			// the guard/OOS branch, where the route emits a CONSTANT string and never
			// calls the model — agreement 1 by construction, measuring nothing.
			const consistency = scoreConsistency({
				judgedTexts: judgedRuns,
				noEnvelope: runs.map((a) => a.sources === null),
			});

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
						answerA: judgedRuns[a],
						answerB: judgedRuns[b],
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
			const judgedPairs = equivalences.filter((e) => e.equivalent !== null);
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
					judged_answer: judgedRuns[idx],
					citation_set: citationKeys[idx],
					retrieved: sourcesOf(a),
					fallback_taken: fallbackTaken(a),
				})),
				metrics: {
					// null = EXCLUDED (with a reason below), never a vacuous 1.
					citation_set_agreement: consistency.citation_set_agreement,
					tarr_exact_text_agreement: consistency.tarr_exact_text_agreement,
					// FULL denominator — this is what makes an exclusion visible.
					citation_coverage_across_repeats: consistency.citation_coverage,
					citation_agreement_excluded_reason:
						consistency.citation_agreement_excluded_reason,
					tarr_excluded_reason: consistency.tarr_excluded_reason,
					// Of the pairs that DID disagree on citations, how many are still
					// substantively the same answer?
					disagreeing_pairs: equivalences.length,
					equivalent_pairs: judgedPairs.filter((e) => e.equivalent).length,
					equivalence_rate:
						judgedPairs.length === 0
							? null
							: judgedPairs.filter((e) => e.equivalent).length /
								judgedPairs.length,
				},
				judge: { answer_equivalence: equivalences },
				timestamp: new Date().toISOString(),
				cost_so_far_usd: cost.totalUsd(),
			});
			console.log(
				`[${i + 1}/${golden.length}] ${rec.question_id} ` +
					`citation-agree=${
						consistency.citation_set_agreement ??
						`excluded(${consistency.citation_agreement_excluded_reason})`
					} ` +
					`TARr=${
						consistency.tarr_exact_text_agreement ??
						`excluded(${consistency.tarr_excluded_reason})`
					} ` +
					`cite-coverage=${consistency.citation_coverage?.toFixed(2) ?? "n/a"} ` +
					`disagreeing-pairs=${equivalences.length} $${cost.totalUsd().toFixed(4)}`,
			);
		}
	}

	/**
	 * PARAPHRASE — 3 paraphrases per stratified golden question vs the canonical
	 * phrasing: retrieval Jaccard over the top-k chunk-id sets (production truth,
	 * from `data-sources`) + judged answer-equivalence.
	 */
	async function runParaphrase(): Promise<void> {
		// Datasets are read + validated in preflight (issue 5) so the daily-cap
		// projection can size the run before any spend.
		const byParent = paraphrasesByParent;
		const parents = paraphraseParents;
		for (const [i, rec] of parents.entries()) {
			const canonLabel = `paraphrase:${rec.question_id}:canonical`;
			reserveAnswer(cost, rec.question, canonLabel);
			const canonical = await askServer(rec.question);
			await chargeAnswer(supabase, cost, canonical, rec.question, canonLabel);
			const canonicalIds = new Set(sourcesOf(canonical).map((s) => s.id));
			// ISSUE 4: the route's disclaimer is boilerplate, not model output — strip
			// it before any comparison or judgement.
			const canonicalJudged = judgedText(canonical);
			const canonicalCitations = citationSetKey(canonicalJudged);

			const canonicalBranch = fallbackTaken(canonical);
			const results: unknown[] = [];
			for (const p of byParent.get(rec.question_id) ?? []) {
				reserveAnswer(cost, p.question, `paraphrase:${p.paraphrase_id}`);
				const a = await askServer(p.question);
				await chargeAnswer(supabase, cost, a, p.question, `paraphrase:${p.paraphrase_id}`);
				const ids = new Set(sourcesOf(a).map((s) => s.id));
				const pJudged = judgedText(a);

				// ISSUE 1b: this experiment had NONE of round 1's exclude-with-reason
				// discipline. jaccard(∅, ∅) === 1, so a canonical AND paraphrase that
				// both refused scored PERFECT retrieval stability for a pair where
				// nothing was retrieved either time; citationSetKey's "" === "" gave a
				// free citation-stability 1 whenever both cited nothing; and the
				// equivalence rubric literally says "Both being refusals of the same
				// kind is equivalent", so two refusals scored as perfect paraphrase
				// robustness. scoreParaphrasePair excludes all three with counted
				// reasons and surfaces them through full-denominator coverage rows.
				const pair = scoreParaphrasePair({
					canonicalEnvelopeIds: canonicalIds,
					paraphraseEnvelopeIds: ids,
					canonicalJudgedText: canonicalJudged,
					paraphraseJudgedText: pJudged,
					canonicalBranch,
					paraphraseBranch: fallbackTaken(a),
				});

				// Skipping the judge on a refusal pair is not just honesty — it is the
				// cheaper path too: no judge call is made for a verdict that could only
				// ever have been vacuous.
				let equivalent: boolean | null = null;
				let eqJudge: Record<string, unknown> = {
					skipped: pair.equivalence_excluded_reason,
				};
				if (!pair.skipEquivalenceJudge) {
					const eq = await judgeAnswerEquivalence(deps, {
						question: rec.question,
						answerA: canonicalJudged,
						answerB: pJudged,
					});
					if (!eq.ok) judgeErrors.answer_equivalence++;
					equivalent = eq.value?.equivalent ?? null;
					eqJudge = {
						ok: eq.ok,
						cached: eq.cached,
						reasons: eq.reasons,
						error: eq.error,
					};
				}

				results.push({
					paraphrase_id: p.paraphrase_id,
					question: p.question,
					http_status: a.status,
					answer: a.text,
					judged_answer: pJudged,
					retrieved: sourcesOf(a),
					fallback_taken: fallbackTaken(a),
					metrics: {
						// null = EXCLUDED (reason alongside), never a vacuous 1.
						retrieval_jaccard: pair.retrieval_jaccard,
						citation_set_stable: pair.citation_set_stable,
						answer_equivalent: equivalent,
						// FULL-denominator companions — the exclusions are visible here.
						both_sides_have_envelope: pair.both_sides_have_envelope,
						both_sides_cited: pair.both_sides_cited,
						both_sides_answered: pair.both_sides_answered,
						jaccard_excluded_reason: pair.jaccard_excluded_reason,
						citation_stability_excluded_reason:
							pair.citation_stability_excluded_reason,
						equivalence_excluded_reason: pair.equivalence_excluded_reason,
					},
					judge: { answer_equivalence: eqJudge },
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
					judged_answer: canonicalJudged,
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
		// `probes` is read + filtered in preflight (issue 5).
		for (const [i, probe] of probes.entries()) {
			reserveAnswer(cost, probe.question, `negative:${probe.probe_id}`);
			const a = await askServer(probe.question);
			await chargeAnswer(supabase, cost, a, probe.question, `negative:${probe.probe_id}`);
			// Markers come from lib/prompts.ts now — no re-derived sentinels (issue 2).
			const verdict = scoreRejection({
				status: a.status,
				text: a.text,
				hasSourcesFrame: a.sources !== null,
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
					// null = EXCLUDED (a 200 that streamed no text is not a refusal and
					// not an answer — scoring it 0 would be a false FAILURE that drags the
					// row down for a reason that is not the pipeline's refusal behaviour).
					rejection_success:
						verdict.success === null ? null : verdict.success ? 1 : 0,
					layer: verdict.layer,
					fabricated_citations: verdict.fabricatedCitations,
					reason: verdict.reason,
				},
				timestamp: new Date().toISOString(),
				cost_so_far_usd: cost.totalUsd(),
			});
			console.log(
				`[${i + 1}/${probes.length}] ${probe.probe_id} reject=${
					verdict.success === null
						? `EXCLUDED(${verdict.reason})`
						: verdict.success
							? "PASS"
							: "FAIL"
				} layer=${verdict.layer} $${cost.totalUsd().toFixed(4)}`,
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
