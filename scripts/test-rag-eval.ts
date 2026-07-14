#!/usr/bin/env bun
// RAG eval framework — OFFLINE self-test (item-2 slice 2.1).
//
//   bun run test:rag-eval
//
// Pure/offline by design, same contract as scripts/test-artifact.ts: fixtures
// only — no network, no OpenAI, no Supabase, no dev server. `globalThis.fetch`
// is replaced with a throwing stub, so ANY accidental network call fails the
// run loudly. That stub is also what proves DELTA D2 for the RETRIEVAL path:
// driving the real lib/retrieval with a no-op `recordUsage` makes ZERO network
// calls, i.e. eval-path RETRIEVAL never increments the production daily OpenAI
// circuit-breaker (whose recordOpenAICall talks to Upstash over REST).
//
// That claim is about retrieval ONLY, and §11 below pins the honest framing:
// the ANSWER harness deliberately POSTs the real production route and DOES
// consume the shared daily-cap budget by design. "The eval cannot touch the
// breaker" was always an overclaim.
//
// Exit code 0 on pass, 1 on any failure. Never wired into lint/build/CI (I2.1).

import fs from "node:fs";
import path from "node:path";
import type OpenAI from "openai";
import { type RetrievedChunk, buildContextEnvelope } from "../lib/context-envelope";
import {
	LOW_SIM_OOS,
	MIN_CHUNK_SIM,
	type RetrievalDeps,
	type RetrievalTrace,
	RetrievalError,
	deriveEnvelopeAtK,
	embeddingInputsFor,
	envelopeIdsAtK,
	postFilterRankedIdsFromTrace,
	retrieveChunks,
} from "../lib/retrieval";
import {
	KNOWLEDGE_HUB_LIMITED_CONTEXT,
	KNOWLEDGE_HUB_LOW_CONFIDENCE,
	KNOWLEDGE_HUB_OUT_OF_SCOPE,
	isLimitedContextText,
	isLowConfidenceText,
	isRefusalText,
	stripLimitedContextPrefix,
} from "../lib/prompts";
import {
	ANSWERER_MODEL,
	EMBEDDING_MODEL,
	GOLDEN_PATH,
	OOC_PROBES_PATH,
} from "./rag-eval/config";
import {
	SNIPPET_TO_FULL_CHUNK_FACTOR,
	countTokens,
	recordAnswerCost,
	reserveAnswerCost,
	serverEmbeddingInputTokens,
} from "./rag-eval/answer";
import {
	citationSetKey,
	extractCitations,
	isCitationValid,
	scoreCitationValidity,
	sectionMatchesPrefix,
} from "./rag-eval/citations";
import {
	CostAccountant,
	CostCapError,
	asCostCapError,
	priceUsd,
} from "./rag-eval/cost";
import {
	type DbChunkRow,
	type GoldChunkRef,
	type GoldenRecord,
	type OocProbe,
	isPlaceholderDataset,
	readJsonl,
	shortSha256,
	verifyFingerprint,
} from "./rag-eval/datasets";
import {
	DAILY_CAP_CALLS_PER_REQUEST,
	headroomBlocksRun,
	projectDailyCapCalls,
} from "./rag-eval/headroom";
import { type JudgeDeps, judgeFaithfulness, judged } from "./rag-eval/judge";
import {
	REFUSAL_BRANCHES,
	RETRIEVAL_METRIC_STAGE,
	clamp01,
	classifyBranch,
	contextPrecisionAtK,
	contextRecallAtK,
	cosineSimilarity,
	disagreeingPairs,
	hitRateAtK,
	jaccard,
	kSweepExclusion,
	mean,
	normalizeText,
	reciprocalRank,
	scoreConsistency,
	scoreEnvelopeAtK,
	scoreParaphrasePair,
	scoreRejection,
	scoreRetrievalStages,
	similarityRankedIdsFromTrace,
	totalAgreement,
} from "./rag-eval/metrics";
import { meteredOpenAI } from "./rag-eval/openai";
import { type Row, meanDefined, rowsFor } from "./rag-eval/report";
import { parseStream } from "./rag-eval/sse";

// ---------------------------------------------------------------------------
// Offline netting: NOTHING in this harness may touch the network.

globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
	const url = String(input instanceof Request ? input.url : input);
	throw new Error(`test:rag-eval must stay offline; unexpected fetch: ${url}`);
}) as typeof fetch;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failures++;
		console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}
function section(title: string): void {
	console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
section("1. Retrieval metrics (ID-based, IR-book / RAGAS)");

const ranked = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
check("hit rate@3 = 1 when gold is at rank 2", hitRateAtK(ranked, new Set([20]), 3) === 1);
check("hit rate@3 = 0 when gold is at rank 4", hitRateAtK(ranked, new Set([40]), 3) === 0);
check("MRR = 1/2 for gold at rank 2", reciprocalRank(ranked, new Set([20])) === 0.5);
check("MRR = 0 when gold is absent", reciprocalRank(ranked, new Set([999])) === 0);
check(
	"context recall@8 = 0.5 when 1 of 2 gold chunks is in top-8",
	contextRecallAtK(ranked, new Set([20, 999]), 8) === 0.5,
);
// RAGAS CP@K = Σ (Precision@i × v_i) / (# relevant in top K).
// Gold at ranks 1 and 3 → (1/1 + 2/3) / 2 = 0.8333…
const cp = contextPrecisionAtK([1, 2, 3, 4], new Set([1, 3]), 4);
check("CP@4 matches the RAGAS formula for gold at ranks 1,3", Math.abs(cp - (1 + 2 / 3) / 2) < 1e-9, cp);
check("CP@k = 0 when nothing relevant is retrieved", contextPrecisionAtK([1, 2], new Set([9]), 2) === 0);
check("cosine of identical vectors = 1", Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
check("negative cosine clamps to 0 for reporting (Edge case 13)", clamp01(-0.3) === 0);
check("mean of empty list = 0", mean([]) === 0);

// ---------------------------------------------------------------------------
section("2. Citations (deterministic — R7 metric 5a)");

const ANSWER = `Licensees shall conduct a panel walkdown [REGDOC-2.3.4 §3.2.3].
The minimum shift complement is defined in [REGDOC-2.2.5 §3.1]. Offences are
set out in [NSCA §48(1)(b)].`;
const cites = extractCitations(ANSWER);
check("extracts 3 citations incl. NSCA parenthetical sub-clause", cites.length === 3, cites);
check("parses REGDOC + section", cites[0].regdoc === "REGDOC-2.3.4" && cites[0].section === "3.2.3");
check("parses NSCA §48(1)(b)", cites[2].regdoc === "NSCA" && cites[2].section === "48(1)(b)");
check("section prefix: 3.2 ⊃ 3.2.3", sectionMatchesPrefix("3.2.3", "3.2"));
check("section prefix: 48 ⊃ 48(1)(b)", sectionMatchesPrefix("48(1)(b)", "48"));
check("section prefix: 3.2 ⊅ 4.1", !sectionMatchesPrefix("4.1", "3.2"));

const SOURCES = [
	{ regdoc_id: "REGDOC-2.3.4", section_number: "3.2" },
	{ regdoc_id: "REGDOC-2.2.5", section_number: "3.1.4" },
	{ regdoc_id: "NSCA", section_number: "48" },
];
check("citation valid when the chunk's section is a prefix", isCitationValid(cites[0], SOURCES));
check("citation valid when the CITED section is the prefix", isCitationValid(cites[1], SOURCES));
check("NSCA sub-clause citation is valid against §48", isCitationValid(cites[2], SOURCES));
check(
	"citation INVALID when the doc is not in the retrieved set (fabricated pointer)",
	!isCitationValid({ regdoc: "REGDOC-9.9.9", section: "1" }, SOURCES),
);
const validity = scoreCitationValidity(ANSWER, SOURCES);
check("validity = 1.0 when every citation resolves", validity.score === 1 && validity.total === 3, validity);
check("a citing answer has coverage 1", validity.hasCitations === 1);
const fabricated = scoreCitationValidity("See [REGDOC-9.9.9 §1].", SOURCES);
check("validity = 0 for a wholly fabricated citation", fabricated.score === 0 && fabricated.invalid.length === 1);
check(
	"citation-set key is order-insensitive and deduped",
	citationSetKey("[REGDOC-2.3.4 §3.2] and [REGDOC-2.2.5 §3.1]") ===
		citationSetKey("[REGDOC-2.2.5 §3.1] then again [REGDOC-2.3.4 §3.2] and [REGDOC-2.3.4 §3.2]"),
);

// ---------------------------------------------------------------------------
section("3. Consistency primitives (TAR-style, arXiv 2408.04667)");

check("total agreement = 1 when all keys match", totalAgreement(["a", "a", "a"]) === 1);
check("total agreement = 0 on any disagreement", totalAgreement(["a", "a", "b"]) === 0);
check("normalizeText collapses whitespace only", normalizeText("a  b\n c ") === "a b c");
check("disagreeing pairs are the ONLY judged pairs", disagreeingPairs(["a", "a", "b"]).length === 2, disagreeingPairs(["a", "a", "b"]));
check("no judged pairs when every run agrees (zero judge cost)", disagreeingPairs(["a", "a", "a"]).length === 0);
check("Jaccard of identical sets = 1", jaccard(new Set([1, 2]), new Set([1, 2])) === 1);
check("Jaccard of disjoint sets = 0", jaccard(new Set([1]), new Set([2])) === 0);
check("Jaccard of half-overlapping sets = 1/3", Math.abs(jaccard(new Set([1, 2]), new Set([2, 3])) - 1 / 3) < 1e-9);

// ---------------------------------------------------------------------------
section("4. Negative rejection (RGB — I2.9 / Edge case 4)");

const oosText = `Prefix. ${KNOWLEDGE_HUB_OUT_OF_SCOPE}`;
const lowConfText = `${KNOWLEDGE_HUB_LOW_CONFIDENCE} Sorry.`;
const rej = (over: Partial<Parameters<typeof scoreRejection>[0]>) =>
	scoreRejection({
		status: 200,
		text: oosText,
		hasSourcesFrame: false,
		...over,
	});
check("guard/sim-gate refusal (no data-sources frame) = SUCCESS", rej({}).success === true && rej({}).layer === "deterministic_or_sim_gate");
check("LLM-level refusal (with sources frame) = SUCCESS", rej({ hasSourcesFrame: true }).layer === "llm_refusal");
check("low-confidence line also counts as a rejection", rej({ text: lowConfText }).success === true);
check("HTTP 4xx block = SUCCESS at the request boundary", rej({ status: 400 }).success === true && rej({ status: 400 }).layer === "guard_http");
check("answering an OOC probe = FAILURE", rej({ text: "The NRC requires 40 hours." }).success === false);
const fab = rej({ text: `${oosText} But see [REGDOC-2.3.4 §3.2].` });
check("fabricated citation inside a rejection = FAILURE", fab.success === false && fab.fabricatedCitations === 1, fab);
let threw = false;
try {
	rej({ status: 429 });
} catch {
	threw = true;
}
check("429 is never scored — it throws (Edge case 2: first 429 is fatal)", threw);

// ---------------------------------------------------------------------------
section("5. SSE parser (R8 — must tolerate an absent data-sources frame)");

const SSE = [
	'data: {"type":"start"}',
	'data: {"type":"text-delta","delta":"Hello "}',
	'data: {"type":"text-delta","delta":"world"}',
	'data: {"type":"data-sources","data":{"chunks":[{"id":7,"regdoc_id":"REGDOC-2.3.4","section_number":"3.2","similarity":0.61,"snippet":"…"}]}}',
	"data: [DONE]",
	"",
].join("\n");
const parsed = parseStream(SSE);
check("accumulates text-delta frames", parsed.text === "Hello world", parsed.text);
check("captures the data-sources frame", parsed.sources?.length === 1 && parsed.sources[0].id === 7);
const noSources = parseStream('data: {"type":"text-delta","delta":"refused"}\n');
check("sources === null when the frame is absent (guard/OOS refusals)", noSources.sources === null);

// ---------------------------------------------------------------------------
section("6. Fingerprints (Edge case 6 / I2.10 — re-ingest id drift)");

const hash = await shortSha256("chunk text");
const ref: GoldChunkRef = {
	chunk_id: 101,
	regdoc_id: "REGDOC-2.3.4",
	section_number: "3.2",
	chunk_index: 4,
	text_sha256: hash,
};
const rows: DbChunkRow[] = [
	{ id: 101, regdoc_id: "REGDOC-2.3.4", section_number: "3.2", chunk_index: 4, text_sha256: hash },
];
check("fingerprint verifies when the id still matches", verifyFingerprint(ref, rows).status === "ok");
const drifted: DbChunkRow[] = [
	{ id: 555, regdoc_id: "REGDOC-2.3.4", section_number: "3.2", chunk_index: 4, text_sha256: hash },
];
const remap = verifyFingerprint(ref, drifted);
check(
	"drifted BIGSERIAL id is re-mapped by fingerprint, not silently mis-scored",
	remap.status === "remapped" && remap.newChunkId === 555,
	remap,
);
const changed: DbChunkRow[] = [
	{ id: 101, regdoc_id: "REGDOC-2.3.4", section_number: "3.2", chunk_index: 4, text_sha256: "deadbeefdeadbeef" },
];
check("vanished fingerprint (corpus text changed) = missing → run must abort", verifyFingerprint(ref, changed).status === "missing");

// ---------------------------------------------------------------------------
section("7. Committed datasets");

const probes = readJsonl<OocProbe>(OOC_PROBES_PATH);
check("OOC probe set has 15–25 probes (spec R4)", probes.length >= 15 && probes.length <= 25, probes.length);
check("every probe expects rejection", probes.every((p) => p.expected === "reject"));
check("every probe has a unique id", new Set(probes.map((p) => p.probe_id)).size === probes.length);
check(
	"3–5 plausible-but-false-premise probes (spec R4)",
	probes.filter((p) => p.category === "false_premise").length >= 3 &&
		probes.filter((p) => p.category === "false_premise").length <= 5,
);
check("out-of-corpus probes cover ≥ 4 categories", new Set(probes.map((p) => p.category)).size >= 4);
const golden = readJsonl<GoldenRecord>(GOLDEN_PATH);
check("golden set parses as JSONL", golden.length > 0);
// The committed golden set is a PLACEHOLDER (Supabase was paused when the
// framework landed — spec D4 fallback). The runner refuses to score it. When it
// is regenerated for real, this check flips to the schema assertions below it.
if (isPlaceholderDataset(golden)) {
	console.log("  note golden set is the committed PLACEHOLDER — regenerate with `bun run eval:rag:golden`");
	check("placeholder golden set is detectable (the runner refuses to score it)", isPlaceholderDataset(golden));
} else {
	check("real golden set has 70–80 records (spec R3)", golden.length >= 70 && golden.length <= 80, golden.length);
	check("every record carries ≥ 1 gold chunk with a fingerprint", golden.every((g) => g.gold_chunks.length > 0 && g.gold_chunks.every((c) => !!c.text_sha256)));
	check("question ids are unique", new Set(golden.map((g) => g.question_id)).size === golden.length);
}

// ---------------------------------------------------------------------------
section("8. Cost accountant (I2.3 — hard cap, three-way split)");

check("priceUsd: 1M gpt-4o input tokens = $2.50", Math.abs(priceUsd("gpt-4o", 1_000_000, 0) - 2.5) < 1e-9);
check("priceUsd: unpriced model throws (no silent $0)", (() => {
	try {
		priceUsd("some-new-model", 1, 1);
		return false;
	} catch {
		return true;
	}
})());
const acct = new CostAccountant(0.01);
acct.record({ kind: "judge", model: "gpt-4o", inputTokens: 1000, outputTokens: 100, estimated: false });
check("under-cap charges do not throw", acct.totalUsd() > 0 && acct.totalUsd() < 0.01);
let capped: CostCapError | null = null;
try {
	acct.record({ kind: "judge", model: "gpt-4o", inputTokens: 1_000_000, outputTokens: 0, estimated: false });
} catch (err) {
	capped = err as CostCapError;
}
check("cap breach throws CostCapError", capped instanceof CostCapError);
check("the charge that tripped the cap is still recorded (abort report stays honest)", acct.entryCount() === 2);
const split = acct.totalsByKind();
check("three-way split tracks judge / embeddings / answerer separately", split.judge.usd > 0 && split.embeddings.usd === 0 && split.answerer_estimated.usd === 0);

// ---------------------------------------------------------------------------
section("9. Judge module (R6 — rubric, cache, repair retry)");

// Stub OpenAI: no network, counts calls, replays scripted JSON bodies.
let chatCalls = 0;
function stubOpenAI(bodies: string[]): OpenAI {
	let i = 0;
	return {
		chat: {
			completions: {
				create: async () => {
					chatCalls++;
					const content = bodies[Math.min(i++, bodies.length - 1)];
					return {
						choices: [{ message: { content } }],
						usage: { prompt_tokens: 100, completion_tokens: 20 },
					};
				},
			},
		},
	} as unknown as OpenAI;
}

const FAITH_JSON = JSON.stringify({
	reasons: "Claim 1 appears verbatim in chunk 1; claim 2 is not in the context.",
	claims: [
		{ claim: "Licensees shall conduct a panel walkdown.", supported: true, why: "chunk 1" },
		{ claim: "Turnover must take 45 minutes.", supported: false, why: "not in context" },
	],
});
const CTX = [{ id: 1, regdoc_id: "REGDOC-2.3.4", section_number: "3.2", text: "Licensees shall conduct a panel walkdown at turnover." }];
// Unique question per test run so the on-disk cache from a previous run can't
// mask a real miss.
const nonce = crypto.randomUUID();
const Q = `test-${nonce}: what is required at shift turnover?`;

let cost9 = new CostAccountant(1);
let deps9: JudgeDeps = { openai: stubOpenAI([FAITH_JSON]), cost: cost9 };
const f1 = await judgeFaithfulness(deps9, { question: Q, answer: "answer-A", chunks: CTX });
check("faithfulness parses claims and scores supported/total", f1.ok && f1.value?.score === 0.5, f1.value);
check("CoT reasons are captured (G-Eval: reasons BEFORE the verdict)", typeof f1.reasons === "string" && (f1.reasons?.length ?? 0) > 0);
check("first call is a cache MISS (1 API call)", !f1.cached && chatCalls === 1);
check("judge call is charged to the accountant", cost9.totalsByKind().judge.usd > 0);

const callsBefore = chatCalls;
const f2 = await judgeFaithfulness(deps9, { question: Q, answer: "answer-A", chunks: CTX });
check("identical (question, answer, context) is a cache HIT — zero tokens", f2.cached && chatCalls === callsBefore, { cached: f2.cached, chatCalls });
check("cached verdict is identical to the fresh one", f2.value?.score === 0.5);

// PROMPT_VERSION self-invalidation: a new prompt produces a new ANSWER, whose
// hash is in the cache key — so the cached verdict cannot be reused.
const f3 = await judgeFaithfulness(deps9, { question: Q, answer: "answer-B (a different answer)", chunks: CTX });
check("a different answer MISSES the cache (PROMPT_VERSION self-invalidates — Edge case 5)", !f3.cached && chatCalls === callsBefore + 1);

// Repair retry then judge_error (Edge case 3).
chatCalls = 0;
cost9 = new CostAccountant(1);
deps9 = { openai: stubOpenAI(["not json at all", "{\"still\":\"wrong schema\"}"]), cost: cost9 };
const bad = await judged<{ x: number }>(deps9, {
	metricId: "test_metric",
	question: `bad-${nonce}`,
	answerHash: "h",
	contextHash: "c",
	system: "s",
	user: "u",
	validate: (p) => (typeof (p as { x?: unknown }).x === "number" ? { x: (p as { x: number }).x } : null),
});
check("unparseable/off-schema JSON → exactly ONE repair retry, then judge_error", !bad.ok && chatCalls === 2, { ok: bad.ok, chatCalls, error: bad.error });
check("judge_error is not cached (a transient bad generation can't poison future runs)", !bad.cached);

// ---------------------------------------------------------------------------
section("10. DELTA D2 — eval retrieval never increments the production breaker");

// Any network call throws (the fetch stub above). recordOpenAICall talks to
// Upstash over REST, so if the no-op recordUsage were NOT honored, this would
// blow up. Driving the REAL lib/retrieval proves the injection point works.
function makeChunk(id: number, similarity: number, doc = "REGDOC-2.3.4"): RetrievedChunk {
	return {
		id,
		regdoc_id: doc,
		title: "t",
		section_number: "3.2",
		section_title: "s",
		chunk_text: `chunk ${id}`,
		url: null,
		requirement_type: "requirement",
		similarity,
	} as RetrievedChunk;
}
const pool = Array.from({ length: 20 }, (_, i) => makeChunk(i + 1, 0.9 - i * 0.02));
const costD2 = new CostAccountant(1);
let embedCalls = 0;
const fakeOpenAI = {
	embeddings: {
		create: async (body: { input: string | string[] }) => {
			embedCalls++;
			const n = Array.isArray(body.input) ? body.input.length : 1;
			return {
				data: Array.from({ length: n }, () => ({ embedding: [0.1, 0.2, 0.3] })),
				usage: { prompt_tokens: 42 },
			};
		},
	},
} as unknown as OpenAI;
const fakeSupabase = {
	rpc: async () => ({ data: pool, error: null }),
} as unknown as RetrievalDeps["supabase"];

let d2Error: string | null = null;
let result: Awaited<ReturnType<typeof retrieveChunks>> | null = null;
try {
	result = await retrieveChunks(
		"What is required at shift turnover?",
		{
			supabase: fakeSupabase,
			openai: meteredOpenAI(fakeOpenAI, costD2, "d2-test"),
			recordUsage: async () => {}, // the DELTA D2 no-op
		},
		{ envelopeChunks: 8, withTrace: true },
	);
} catch (err) {
	d2Error = (err as Error).message;
}
check("retrieveChunks with a no-op recordUsage makes ZERO network calls", d2Error === null, d2Error);
check("…and still retrieves (envelope filled at k=8)", result?.envelope.length === 8, result?.envelope.length);
check("the metered client charged the embedding to the accountant", costD2.totalsByKind().embeddings.tokens === 42 && embedCalls === 1);
check("trace is emitted only when withTrace is set", !!result?.trace);

const trace = result?.trace as RetrievalTrace;
check("trace pool carries pre/post-boost ranks + similarities", trace.pool.length === 20 && trace.pool[0].rankPostBoost === 1);
check("trace decision is 'normal' for a strong pool", trace.decision === "normal", { topSim: trace.topSim, LOW_SIM_OOS });

// The k-sweep derives every k from ONE retrieval — it must agree exactly with
// what retrieveChunks itself would have selected at that envelopeChunks.
for (const k of [3, 5, 8, 10]) {
	const derived = deriveEnvelopeAtK(trace, k).slice(0, k).map((c) => c.id);
	const direct = (
		await retrieveChunks(
			"What is required at shift turnover?",
			{
				supabase: fakeSupabase,
				openai: meteredOpenAI(fakeOpenAI, new CostAccountant(1), "d2-test"),
				recordUsage: async () => {},
			},
			{ envelopeChunks: k },
		)
	).envelope.map((c) => c.id);
	check(`k-sweep envelope at k=${k} is identical to a direct retrieval at k=${k}`, JSON.stringify(derived) === JSON.stringify(direct), { derived, direct });
}

// OOS branch: below the gate, the full ranked pool is returned (no envelope
// trim), and MIN_CHUNK_SIM is not applied — the eval must score that honestly
// (Edge case 9) rather than throw.
const weakPool = Array.from({ length: 20 }, (_, i) => makeChunk(i + 1, 0.3 - i * 0.001));
const weakSupabase = { rpc: async () => ({ data: weakPool, error: null }) } as unknown as RetrievalDeps["supabase"];
const weak = await retrieveChunks(
	"unrelated question",
	{ supabase: weakSupabase, openai: meteredOpenAI(fakeOpenAI, new CostAccountant(1), "d2"), recordUsage: async () => {} },
	{ envelopeChunks: 8, withTrace: true },
);
check("OOS branch is reachable offline and flagged in the trace", weak.trace?.decision === "oos" && weak.topSim < LOW_SIM_OOS, {
	decision: weak.trace?.decision,
	topSim: weak.topSim,
	MIN_CHUNK_SIM,
});

// ===========================================================================
// PR #8 FIX ROUND 1 — regression tests.
//
// Each block below FAILS if its fix is reverted. These are the proof; a green
// run of the pre-existing checks is not. Every one of these bugs made the final
// report print a FLATTERING number for the wrong reason, or under-charged the
// wallet, or both.
// ===========================================================================

// Source-level assertions. Several of these fixes live in modules that execute
// on import (run.ts, generate-golden.ts call main() at module scope), so they
// cannot be imported into a test harness. Reading their source is the honest
// way to pin the call-site half of a fix — and it fails loudly if reverted.
// cwd is the repo root (same assumption the committed-dataset checks make).
const readSrc = (rel: string) =>
	fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");

// ---------------------------------------------------------------------------
section("11. Issue 2 — branch sentinels match what the APP ACTUALLY EMITS");

// The bug: scoreRejection + run.ts's fallbackTaken detected the "low-confidence
// branch" by matching KNOWLEDGE_HUB_LOW_CONFIDENCE. NOTHING in the app emits
// that string on that branch. The route's low-avg-similarity branch emits a
// different hardcoded literal. Both sentinels were measuring nothing.
const ROUTE_SRC = readSrc("app/api/knowledge-hub/query/route.ts");

// PR #8 fix round 2 (issue 5 — test hygiene): this used to assert
// `ROUTE_SRC.includes('KNOWLEDGE_HUB_LIMITED_CONTEXT,\n} from "@/lib/prompts"'.slice(0, 30))`.
// The .slice(0, 30) truncated the needle to just the identifier, so the
// import-SOURCE half it appeared to check was never checked at all. The two
// substrings are now asserted separately, unsliced.
check(
	"the route emits the SHARED constant on its low-similarity branch",
	ROUTE_SRC.includes("emit(KNOWLEDGE_HUB_LIMITED_CONTEXT)"),
);
check(
	"…and imports that constant from lib/prompts (not a local literal)",
	ROUTE_SRC.includes("\tKNOWLEDGE_HUB_LIMITED_CONTEXT,") &&
		ROUTE_SRC.includes('} from "@/lib/prompts";'),
);
check(
	"the route no longer carries its own copy of the disclaimer literal (single source of truth)",
	!ROUTE_SRC.includes("_Limited matches in the indexed corpus"),
);
check(
	"the shared constant is byte-identical to the delta the route used to inline",
	KNOWLEDGE_HUB_LIMITED_CONTEXT ===
		"_Limited matches in the indexed corpus for this question — answering from the strongest available snippets._\n\n",
);
// The markers must actually match the canonical strings, or the whole scheme is
// theatre. (This is the check that catches a future prompt edit.)
check("REFUSAL marker matches the canonical out-of-scope constant", isRefusalText(KNOWLEDGE_HUB_OUT_OF_SCOPE));
check("LOW-CONFIDENCE marker matches the canonical low-confidence constant", isLowConfidenceText(KNOWLEDGE_HUB_LOW_CONFIDENCE));
check("LIMITED-CONTEXT marker matches the route's disclaimer constant", isLimitedContextText(KNOWLEDGE_HUB_LIMITED_CONTEXT));
// eval-security.ts's grade() matches LOWERCASED SUBSTRINGS. The old scoreRejection
// did a case-sensitive exact match, so a re-cased model refusal scored as
// "answered_instead_of_rejecting" — a FALSE FAILURE that would have made the
// negative-rejection row read LOW for the wrong reason.
const RECASED = "This Assistant ONLY ANSWERS QUESTIONS ABOUT THE INDEXED CNSC regulatory documents.";
check(
	"a re-cased model refusal is still a rejection SUCCESS (lowercased-substring match)",
	rej({ text: RECASED }).success === true,
	rej({ text: RECASED }),
);
const WRAPPED = `I'm sorry — this assistant only answers questions about the indexed CNSC regulatory documents, so I can't help with that.`;
check("a refusal wrapped in prose is still detected", rej({ text: WRAPPED }).success === true);
check(
	"eval-security.ts imports the shared markers instead of re-deriving them",
	readSrc("scripts/eval-security.ts").includes('from "../lib/prompts"'),
);

// classifyBranch: the four branches the app can actually take.
check(
	"branch: refusal text + NO sources frame → oos_or_guard (deterministic guard / sim gate)",
	classifyBranch({ text: KNOWLEDGE_HUB_OUT_OF_SCOPE, hasSourcesFrame: false }) === "oos_or_guard",
);
check(
	"branch: refusal text WITH a sources frame → llm_refusal",
	classifyBranch({ text: KNOWLEDGE_HUB_OUT_OF_SCOPE, hasSourcesFrame: true }) === "llm_refusal",
);
check(
	"branch: the model's low-confidence line → low_confidence",
	classifyBranch({ text: KNOWLEDGE_HUB_LOW_CONFIDENCE, hasSourcesFrame: true }) === "low_confidence",
);
check(
	"branch: the route's disclaimer PREFIX on a real answer → limited_context",
	classifyBranch({
		text: `${KNOWLEDGE_HUB_LIMITED_CONTEXT}Licensees shall do X [REGDOC-2.3.4 §3.2].`,
		hasSourcesFrame: true,
	}) === "limited_context",
);
check("branch: a normal answer → null", classifyBranch({ text: "Licensees shall do X.", hasSourcesFrame: true }) === null);
// The disclaimer is NOT a refusal — the model still answered. Counting it as one
// would inflate the false-rejection rate.
check("limited_context is NOT counted as a refusal", !REFUSAL_BRANCHES.has("limited_context"));
check("oos_or_guard / llm_refusal / low_confidence ARE refusals", ["oos_or_guard", "llm_refusal", "low_confidence"].every((b) => REFUSAL_BRANCHES.has(b)));

// ---------------------------------------------------------------------------
section("12. Issue 1 — zero-citation answers are EXCLUDED, never a free 100%");

const noCites = scoreCitationValidity("I don't have enough from the indexed CNSC documents.", SOURCES);
check(
	"validity is NULL (not 1.0) when an answer cites nothing — a vacuous case is not a pass",
	noCites.score === null && noCites.total === 0,
	noCites,
);
check("…and coverage records the zero", noCites.hasCitations === 0);
// The bug in aggregate: meanDefined only drops null/undefined, so a `score: 1`
// for a zero-citation answer was averaged in as a PERFECT sample. The row read
// ~100% precisely when citations disappeared.
const validityAgg = meanDefined([
	scoreCitationValidity(ANSWER, SOURCES).score, // 1.0, 3 citations
	scoreCitationValidity("See [REGDOC-9.9.9 §1].", SOURCES).score, // 0.0, fabricated
	noCites.score, // null — excluded
	scoreCitationValidity(KNOWLEDGE_HUB_OUT_OF_SCOPE, SOURCES).score, // null — excluded
]);
check(
	"validity mean counts ONLY the answers that cited (n=2), excluding the 2 vacuous ones",
	validityAgg.n === 2 && validityAgg.excluded === 2 && validityAgg.value === 0.5,
	validityAgg,
);
const coverageAgg = meanDefined([1, 0, 0, 1]);
check("citation coverage is its own metric with a full denominator", coverageAgg.n === 4 && coverageAgg.value === 0.5);

// ---------------------------------------------------------------------------
section("13. Issue 7 + report — no row prints a percentage over a padded denominator");

// A synthetic baseline run: one good answer, one OOS refusal (no envelope, no
// citations). Under the old code the refusal scored hit-rate 0 AND citation
// validity 1.0 — dragging retrieval DOWN and citations UP, both silently.
const baselineRun = {
	dir: "fixture",
	manifest: {
		experiment: "baseline",
		aborted: false,
		items: 2,
		prompt_version: "test",
		models: {},
		judge_errors: {},
		cost: { capUsd: 2, totalUsd: 0, byKind: {} },
		golden_set: { sha256: "x", records: 2 },
	},
	items: [
		{
			fallback_taken: null,
			metrics: {
				hit_rate_at_k: 1,
				reciprocal_rank: 1,
				context_recall_at_k: 1,
				context_precision_at_k: 1,
				citation_validity: 1,
				citation_coverage: 1,
			},
		},
		{
			// OOS/guard refusal: route emitted NO data-sources frame, answer cites nothing.
			fallback_taken: "oos_or_guard",
			metrics: {
				hit_rate_at_k: null,
				reciprocal_rank: null,
				context_recall_at_k: null,
				context_precision_at_k: null,
				citation_validity: null,
				citation_coverage: 0,
			},
		},
	],
} as unknown as Parameters<typeof rowsFor>[0];

const reportRows = rowsFor(baselineRun);
const row = (c: string): Row => reportRows.find((r) => r.category === c) as Row;

const HIT_ROW = "Retrieval quality — hit rate@8 [stage: envelope shown to the LLM]";
const MRR_ROW = "Retrieval quality — MRR [stage: post-filter similarity-ranked pool]";
const hitRow = row(HIT_ROW);
check(
	"hit rate@8 = 100% over n=1 — the OOS item is EXCLUDED, not scored 0",
	hitRow.measured === "100.0%" && hitRow.n === "1" && hitRow.excluded.startsWith("1 —"),
	hitRow,
);
check("…and the exclusion states WHY, in the table itself", hitRow.excluded.includes("NO envelope"), hitRow.excluded);
const mrrRow = row(MRR_ROW);
check("MRR excludes the OOS item too (rank-sensitive metrics need a ranking)", mrrRow.n === "1" && mrrRow.excluded.startsWith("1 —"));

const validRow = row("Citation validity (deterministic)");
check(
	"citation validity = 100% over n=1 — the zero-citation refusal is EXCLUDED, not a free pass",
	validRow.measured === "100.0%" && validRow.n === "1" && validRow.excluded.startsWith("1 —"),
	validRow,
);
const covRow = row("Citation coverage (answers carrying ≥ 1 citation)");
check(
	"citation coverage = 50% over the FULL n=2 — zero-citation-ness is visible, never silent",
	covRow.measured === "50.0%" && covRow.n === "2",
	covRow,
);
const frRow = row("False-rejection rate (answerable golden questions refused)");
check("false-rejection rate counts the OOS refusal (50% of 2)", frRow.measured === "50.0%" && frRow.n === "2", frRow);
check("a branch census row reconciles every item to a branch", row("Route branch census (which path produced each answer)").measured.includes("oos_or_guard: 1"));

// A run where NOTHING is measurable must print n/a — never a number.
const allVacuous = rowsFor({
	...baselineRun,
	items: [baselineRun.items[1], baselineRun.items[1]],
} as unknown as Parameters<typeof rowsFor>[0]);
const vacuousValidity = allVacuous.find((r) => r.category === "Citation validity (deterministic)") as Row;
check(
	"a metric with an EMPTY denominator prints n/a, never a number",
	vacuousValidity.measured === "n/a" && vacuousValidity.n === "0" && vacuousValidity.excluded.startsWith("2 —"),
	vacuousValidity,
);

// The limited-context disclaimer is NOT a refusal — it must not inflate the rate.
const disclaimerRun = rowsFor({
	...baselineRun,
	items: [{ fallback_taken: "limited_context", metrics: { hit_rate_at_k: 1, citation_validity: 1, citation_coverage: 1 } }],
} as unknown as Parameters<typeof rowsFor>[0]);
check(
	"the low-similarity DISCLAIMER is not counted as a false rejection (the model still answered)",
	(disclaimerRun.find((r) => r.category === "False-rejection rate (answerable golden questions refused)") as Row).measured === "0.0%",
);

// Why rank-sensitivity matters at all: the same id-set in two different orders
// gives two different MRRs. The data-sources frame is diversity-REORDERED, so
// scoring MRR/CP positionally over it scored a list that was never a ranking.
const similarityRanked = [11, 22, 33, 44];
const diversityReordered = [44, 11, 22, 33];
check(
	"MRR over a diversity-reordered envelope ≠ MRR over the true similarity ranking",
	reciprocalRank(similarityRanked, new Set([44])) !== reciprocalRank(diversityReordered, new Set([44])),
	{
		ranked: reciprocalRank(similarityRanked, new Set([44])),
		reordered: reciprocalRank(diversityReordered, new Set([44])),
	},
);
// The trace pool arrives in POST-BOOST order; the true ranking is by
// rankPreBoost (raw cosine similarity). A named-doc boost can lift chunk 44 to
// the front of the pool while its similarity rank is 4th — score MRR over the
// pool's own order and you credit a rank the retriever never gave it.
const boostedPool = {
	pool: [
		{ chunk: { id: 44 }, rankPreBoost: 4 }, // boosted to the front
		{ chunk: { id: 11 }, rankPreBoost: 1 },
		{ chunk: { id: 22 }, rankPreBoost: 2 },
		{ chunk: { id: 33 }, rankPreBoost: 3 },
	],
};
check(
	"similarityRankedIdsFromTrace restores TRUE similarity order from the post-boost pool",
	JSON.stringify(similarityRankedIdsFromTrace(boostedPool)) === JSON.stringify([11, 22, 33, 44]),
	similarityRankedIdsFromTrace(boostedPool),
);
check(
	"…and that order gives a DIFFERENT MRR than the pool's own (boosted) order",
	reciprocalRank(similarityRankedIdsFromTrace(boostedPool), new Set([44])) === 1 / 4 &&
		reciprocalRank(boostedPool.pool.map((e) => e.chunk.id), new Set([44])) === 1,
);
// NOTE (fix round 2, issue 2): round 1 asserted here that run.ts computed the
// rank-sensitive baseline metrics from `similarityRankedIdsFromTrace(trace)`.
// That was only half right — see §18. The trace WAS the correct seam, but that
// function returns the RAW (pre-filter) pool, which production never surfaces.
// The stage-discipline assertions now live in §18.

// ---------------------------------------------------------------------------
section("14. Issue 3 — the answerer cost estimate reflects the REAL prompt");

// The bug: input tokens were estimated from `sources[].snippet`, the SSE DISPLAY
// projection (chunk_text.slice(0, 260)), while the model's prompt carries the
// FULL ~400-token chunk_text. Real spend systematically exceeded the cap.
const FULL_CHUNK_TEXT = "Licensees shall maintain records of every shift turnover. ".repeat(30); // ~1700 chars
const fullChunks: RetrievedChunk[] = Array.from({ length: 8 }, (_, i) => ({
	id: i + 1,
	regdoc_id: "REGDOC-2.3.4",
	section_number: "3.2",
	section_title: "Turnover",
	chunk_text: FULL_CHUNK_TEXT,
	url: null,
	requirement_type: "requirement",
	similarity: 0.7 - i * 0.01,
}));
const SNIPPET_JOIN = fullChunks.map((c) => c.chunk_text.slice(0, 260)).join("\n"); // the OLD estimate
const REAL_ENVELOPE = buildContextEnvelope(fullChunks, "What is required at turnover?", ["REGDOC-2.3.4"]);

const costOld = new CostAccountant(100);
recordAnswerCost(costOld, {
	systemPrompt: "sys",
	question: "q",
	envelopeText: SNIPPET_JOIN,
	answer: "a",
	label: "old",
});
const costNew = new CostAccountant(100);
recordAnswerCost(costNew, {
	systemPrompt: "sys",
	question: "q",
	envelopeText: REAL_ENVELOPE,
	answer: "a",
	label: "new",
});
const oldTok = costOld.totalsByKind().answerer_estimated.tokens;
const newTok = costNew.totalsByKind().answerer_estimated.tokens;
check(
	"the real-envelope estimate is ≥ 4x the truncated-snippet estimate it replaced",
	newTok >= oldTok * 4,
	{ snippetEstimate: oldTok, realEnvelopeEstimate: newTok, ratio: (newTok / oldTok).toFixed(2) },
);
check(
	"run.ts no longer estimates from the SSE display snippet",
	!readSrc("scripts/rag-eval/run.ts").includes("s.snippet).join") &&
		readSrc("scripts/rag-eval/run.ts").includes("buildContextEnvelope("),
);
// Unresolvable chunks fall back to a factor that ERRS HIGH, never low.
const costFallback = new CostAccountant(100);
recordAnswerCost(costFallback, {
	systemPrompt: "sys",
	question: "q",
	envelopeText: "",
	unresolvedSnippets: [FULL_CHUNK_TEXT.slice(0, 260)],
	answer: "a",
	label: "fallback",
});
const costNoFallback = new CostAccountant(100);
recordAnswerCost(costNoFallback, { systemPrompt: "sys", question: "q", envelopeText: "", answer: "a", label: "none" });
check(
	"an unresolved chunk is charged at the err-high snippet factor, not at snippet face value",
	SNIPPET_TO_FULL_CHUNK_FACTOR >= 6 &&
		costFallback.totalsByKind().answerer_estimated.tokens >
			costNoFallback.totalsByKind().answerer_estimated.tokens * 1.5,
);
// ---------------------------------------------------------------------------
section("14b. Issue 3 (round 2) — the 'err-high' embedding factor erred LOW");

// The bug: the route's embedding call (query + every expansion, made INSIDE the
// dev server where the eval cannot see it) was charged as
// `countTokens(question) * EMBED_INPUT_MULTIPLIER` with the constant 5,
// documented as "above the practical ceiling". It is not a ceiling.
// buildExpansions emits, PER mentioned doc, one narrow expansion per mentioned
// section + one per matched concept seed + one BROAD `${doc} ${query}` carrying
// the WHOLE query — and extractMentionedDocs can return an unbounded number of
// docs (named REGDOCs + up to 4 concept hints). Wallet protection that errs low
// is not wallet protection.
const OLD_EMBED_MULTIPLIER = 5; // the constant this fix deletes

// 7 docs in scope: 4 named (3 REGDOCs + NSCA) + 3 concept hints (graded
// approach → 3.5.3, ALARA → 2.7.1, waste management → 2.11.1).
const MULTI_DOC_Q =
	"Compare REGDOC-2.5.2, REGDOC-2.2.5 and REGDOC-2.3.4 with NSCA section 48 on " +
	"offence reporting requirements, applying the graded approach and ALARA to " +
	"radioactive waste management.";
const multiInputs = embeddingInputsFor(MULTI_DOC_Q);
check(
	"a multi-doc query generates FAR more than the 5 embedding inputs the old constant assumed",
	multiInputs.length > OLD_EMBED_MULTIPLIER,
	{ inputs: multiInputs.length, oldConstant: OLD_EMBED_MULTIPLIER },
);
const exactMultiTokens = serverEmbeddingInputTokens(MULTI_DOC_Q);
const oldMultiEstimate = countTokens(MULTI_DOC_Q) * OLD_EMBED_MULTIPLIER;
check(
	"…and the old constant UNDER-CHARGED it — the 'err-high' factor errs LOW (WALLET)",
	exactMultiTokens > oldMultiEstimate,
	{ exact: exactMultiTokens, oldEstimate: oldMultiEstimate },
);

// Exactness, not a bound: the eval charges the SAME strings production sends.
// Capture the real `embeddings.create` input from a driven retrieveChunks.
let capturedEmbedInputs: string[] = [];
const capturingOpenAI = {
	embeddings: {
		create: async (body: { input: string | string[] }) => {
			capturedEmbedInputs = Array.isArray(body.input) ? body.input : [body.input];
			return {
				data: capturedEmbedInputs.map(() => ({ embedding: [0.1, 0.2, 0.3] })),
				usage: { prompt_tokens: 1 },
			};
		},
	},
} as unknown as OpenAI;
await retrieveChunks(
	MULTI_DOC_Q,
	{
		supabase: fakeSupabase,
		openai: capturingOpenAI,
		recordUsage: async () => {},
	},
	{ envelopeChunks: 8 },
);
check(
	"embeddingInputsFor() is EXACTLY what retrieveChunks sends to embeddings.create — no drift",
	JSON.stringify(capturedEmbedInputs) === JSON.stringify(multiInputs),
	{ sent: capturedEmbedInputs.length, counted: multiInputs.length },
);
check(
	"the charged embedding tokens equal the exact sum of those real inputs",
	exactMultiTokens ===
		capturedEmbedInputs.reduce((acc, s) => acc + countTokens(s), 0),
);
// And it is wired into BOTH the pre-call reservation and the post-call ledger.
const costEmbed = new CostAccountant(100);
recordAnswerCost(costEmbed, {
	systemPrompt: "sys",
	question: MULTI_DOC_Q,
	envelopeText: "",
	answer: "a",
	label: "embed",
});
check(
	"recordAnswerCost charges the exact server-embedding input, not question x 5",
	costEmbed.totalsByKind().embeddings.tokens === exactMultiTokens &&
		costEmbed.totalsByKind().embeddings.tokens > oldMultiEstimate,
	costEmbed.totalsByKind().embeddings,
);
check(
	"answer.ts no longer carries the guessed multiplier at all",
	!readSrc("scripts/rag-eval/answer.ts").includes("EMBED_INPUT_MULTIPLIER"),
);
// A single-doc query is the case the old constant over-charged; the exact count
// must still be exact there (this is a COUNT, not a fudge factor in either
// direction).
const simpleQ = "What is required at shift turnover?";
check(
	"a query naming no doc embeds exactly ONE input (the query itself)",
	embeddingInputsFor(simpleQ).length === 1 &&
		serverEmbeddingInputTokens(simpleQ) === countTokens(simpleQ),
);

// ---------------------------------------------------------------------------
section("15. Issue 4 — the cap aborts BEFORE the spend, and survives wrapping");

// (a) reserve() is a PRE-call check: it must throw WITHOUT recording anything.
// record() alone pushed the entry and THEN threw — i.e. it aborted after the
// money was already gone.
const acctR = new CostAccountant(0.01);
let reserved: CostCapError | null = null;
try {
	acctR.reserve({
		kind: "judge",
		model: "gpt-4o",
		inputTokens: 1_000_000,
		outputTokens: 0,
		estimated: true,
	});
} catch (err) {
	reserved = err as CostCapError;
}
check("reserve() throws CostCapError on a projected breach", reserved instanceof CostCapError);
check("…BEFORE the call: nothing was recorded, no money spent", acctR.entryCount() === 0 && acctR.totalUsd() === 0);
check("…and the error says so (projected, call NOT made)", reserved?.projected === true && reserved.message.includes("NOT made"));
check("reserve() is silent when the projection fits under the cap", (() => {
	const a = new CostAccountant(1);
	a.reserve({ kind: "judge", model: "gpt-4o", inputTokens: 100, outputTokens: 10, estimated: true });
	return a.entryCount() === 0;
})());
check("wouldExceed() is the non-throwing form", (() => {
	const a = new CostAccountant(0.01);
	return (
		a.wouldExceed({ kind: "judge", model: "gpt-4o", inputTokens: 1_000_000, outputTokens: 0, estimated: true }) &&
		!a.wouldExceed({ kind: "judge", model: "gpt-4o", inputTokens: 10, outputTokens: 0, estimated: true })
	);
})());
// The answer harness reserves the WORST CASE before POSTing the real route —
// the spend happens inside the dev server, where a post-hoc record() is useless.
let answerReserved = false;
try {
	reserveAnswerCost(new CostAccountant(0.000001), {
		systemPrompt: "system prompt",
		question: "q",
		envelopeChunks: 8,
		label: "smoke",
	});
} catch (err) {
	answerReserved = err instanceof CostCapError;
}
check("reserveAnswerCost aborts a server request the cap cannot afford", answerReserved);
check(
	"every server request is reserved before it is made",
	(() => {
		const src = readSrc("scripts/rag-eval/run.ts");
		return (
			src.split("reserveAnswer(").length - 1 >= 5 && // one per askServer call site
			src.indexOf("reserveAnswer(cost, rec.question") < src.indexOf("await askServer(rec.question)")
		);
	})(),
);

// (b) lib/retrieval wraps ANY embedding throw into RetrievalError — including
// our own cap abort. A bare `instanceof CostCapError` MISSED it, so the runner
// rethrew, skipped finalize (no manifest, no cost totals), and printed
// "retrieval_failed:embedding" — an outage, inviting a re-run and MORE spend.
const capErr = new CostCapError(9, 2, {
	kind: "embeddings",
	model: EMBEDDING_MODEL,
	inputTokens: 1,
	outputTokens: 0,
	usd: 9,
	estimated: true,
});
const wrapped = new RetrievalError("embedding", capErr);
check("a bare instanceof check MISSES a wrapped cap error (this is the bug)", !(wrapped instanceof CostCapError));
check("asCostCapError UNWRAPS it out of RetrievalError", asCostCapError(wrapped) === capErr);
check("asCostCapError is identity for an unwrapped cap error", asCostCapError(capErr) === capErr);
check("asCostCapError returns null for a genuine outage", asCostCapError(new RetrievalError("match", new Error("db down"))) === null);
check("asCostCapError tolerates a cyclic cause chain without hanging", (() => {
	const a = new Error("a") as Error & { cause?: unknown };
	const b = new Error("b") as Error & { cause?: unknown };
	a.cause = b;
	b.cause = a;
	return asCostCapError(a) === null;
})());
check(
	"both runners unwrap before deciding (run.ts + generate-golden.ts)",
	readSrc("scripts/rag-eval/run.ts").includes("asCostCapError(err)") &&
		readSrc("scripts/rag-eval/generate-golden.ts").includes("asCostCapError(err)"),
);

// ---------------------------------------------------------------------------
section("16. Issue 5 — production daily-cap headroom is checked in PREFLIGHT");

// The answer harness POSTs the REAL route, and a bypassed call still INCREMENTS
// the shared GLOBAL_DAILY_CAP counter. Reading it only in finalize reports the
// damage after doing it — and a battery can circuit-break production.
check("each server request is projected at 2 daily-cap calls (embedding + completion)", DAILY_CAP_CALLS_PER_REQUEST === 2);
check("a 75-question baseline projects 150 calls", projectDailyCapCalls(75) === 150);
check(
	"a run is REFUSED when the remaining headroom cannot absorb the projection",
	headroomBlocksRun({ available: true, callsToday: 1900, cap: 2000, remaining: 100 }, 150),
);
check(
	"a run proceeds when headroom is sufficient",
	!headroomBlocksRun({ available: true, callsToday: 100, cap: 2000, remaining: 1900 }, 150),
);
check(
	"an UNREADABLE counter warns but does not block (a Redis outage is not a breach)",
	!headroomBlocksRun({ available: false, callsToday: 0, cap: 2000, remaining: 2000, reason: "no creds" }, 150),
);
check(
	"run.ts reads the headroom in PREFLIGHT, before the first server request — not only at finalize",
	(() => {
		const src = readSrc("scripts/rag-eval/run.ts");
		// Must be the PREFLIGHT read specifically: the finalize block also calls
		// readHeadroom(), and matching that one would pass even with the preflight
		// check deleted.
		const preflight = src.indexOf("headroomAtStart = await readHeadroom()");
		const firstAsk = src.indexOf("await askServer(");
		return preflight > 0 && firstAsk > 0 && preflight < firstAsk;
	})(),
);
check(
	"…and aborts the run rather than silently eating the users' budget",
	readSrc("scripts/rag-eval/run.ts").includes("headroomBlocksRun(headroomAtStart, projectedServerCalls)"),
);

// ---------------------------------------------------------------------------
section("17. Issue 6 — the judge cache's cost claim is HONEST");

// Chosen option: KEEP the cache, DELETE the false claim. A faithfulness verdict
// is about a SPECIFIC answer; keying it on anything coarser (question +
// chunk-id set) would score answer B with answer A's verdict — a
// flattering-for-the-wrong-reason metric of exactly the kind this item exists
// to stamp out. So no stable key is sound for the scoring metrics, and the
// honest move is to state the real re-run cost.
const nonce6 = crypto.randomUUID();
chatCalls = 0;
const cost17 = new CostAccountant(1);
const deps17: JudgeDeps = { openai: stubOpenAI([FAITH_JSON]), cost: cost17 };

// SCORING metric: the answer hash is in the key, and answers are regenerated
// every run (mandatory `trigger: regenerate-assistant-message` + a
// non-deterministic answerer) → a re-run MISSES. This is the "cache cannot hit"
// property, asserted so nobody re-adds the "re-runs cost cents" claim.
const s1 = await judgeFaithfulness(deps17, { question: `q17-${nonce6}`, answer: "run-1 answer text", chunks: CTX });
const s2 = await judgeFaithfulness(deps17, { question: `q17-${nonce6}`, answer: "run-2 answer text (regenerated, differs)", chunks: CTX });
check(
	"a REGENERATED answer misses the judge cache — re-runs pay FULL judge price",
	!s1.cached && !s2.cached && chatCalls === 2,
	{ chatCalls },
);
check("…so the cost model must not claim otherwise", !readSrc("scripts/rag-eval/judge.ts").includes("makes re-runs cents"));
check(
	"the false claim is struck from the spec too",
	(() => {
		const spec = readSrc("docs/orchestration/specs/item-2-rag-eval.md");
		return spec.includes("~~this is what makes re-runs cents~~") && spec.includes("zero cache hits");
	})(),
);

// GENERATION metrics key on STABLE inputs (chunk text / question text — no model
// output), so they DO hit across runs. That is the cache's real value, and why
// it stays.
chatCalls = 0;
const GOLDEN_JSON = JSON.stringify({ reasons: "r", question: "What must a licensee do?", ground_truth_answer: "It must do X." });
const cost17b = new CostAccountant(1);
const deps17b: JudgeDeps = { openai: stubOpenAI([GOLDEN_JSON]), cost: cost17b };
const stableArgs = {
	metricId: "golden_gen",
	question: "",
	answerHash: "",
	contextHash: `stable-context-${nonce6}`,
	system: "s",
	user: "u",
	validate: (p: unknown) =>
		typeof (p as { question?: unknown }).question === "string" ? { ok: true } : null,
};
const g1 = await judged(deps17b, stableArgs);
const g2 = await judged(deps17b, stableArgs);
check(
	"a GENERATOR verdict (stable inputs, no model output in the key) DOES hit on re-run — the cache's real value",
	!g1.cached && g2.cached && chatCalls === 1,
	{ chatCalls, g2cached: g2.cached },
);

// ===========================================================================
// PR #8 FIX ROUND 2 — regression tests.
// ===========================================================================

// ---------------------------------------------------------------------------
section("18. Issue 2 — each retrieval metric scores the STAGE its definition requires");

// The bug: round 1 moved the rank-sensitive metrics onto the RetrievalTrace seam
// (right), then scored them over `trace.pool` — the UNFILTERED merged candidate
// list out of match_regdoc_chunks (wrong). That pool is a SUPERSET production
// never surfaces: it still contains chunks below MIN_CHUNK_SIM, which the route
// filters out and the model never sees. A hit rate / MRR / CP number over it does
// not describe the shipped pipeline.
//
// Build a pool where the gold chunk sits BELOW MIN_CHUNK_SIM — production can
// never show it, so every honest metric must say "we did not retrieve it".
const belowFilterPool = [
	makeChunk(1, 0.72),
	makeChunk(2, 0.55),
	// gold, but at 0.30 < MIN_CHUNK_SIM (0.35) → filtered out by production.
	makeChunk(999, 0.3),
	makeChunk(3, 0.28),
];
const belowFilterSupabase = {
	rpc: async () => ({ data: belowFilterPool, error: null }),
} as unknown as RetrievalDeps["supabase"];
const bf = await retrieveChunks(
	"a question whose gold chunk embeds weakly",
	{
		supabase: belowFilterSupabase,
		openai: meteredOpenAI(fakeOpenAI, new CostAccountant(1), "stage-test"),
		recordUsage: async () => {},
	},
	{ envelopeChunks: 8, withTrace: true },
);
const bfTrace = bf.trace as RetrievalTrace;
const GOLD_BELOW = new Set([999]);

check(
	"the trace exposes the three stages distinctly (raw / post-filter / envelope)",
	Array.isArray(bfTrace.stages.rawRankedIds) &&
		Array.isArray(bfTrace.stages.postFilterRankedIds) &&
		Array.isArray(bfTrace.stages.envelopeIds),
);
check(
	"raw pool CONTAINS the sub-MIN_CHUNK_SIM gold chunk (production never shows it)",
	bfTrace.stages.rawRankedIds.includes(999),
	bfTrace.stages.rawRankedIds,
);
check(
	"post-filter pool DROPS it — MIN_CHUNK_SIM makes it ineligible",
	!bfTrace.stages.postFilterRankedIds.includes(999),
	bfTrace.stages.postFilterRankedIds,
);
check(
	"the envelope (what the LLM sees) drops it too",
	!bfTrace.stages.envelopeIds.includes(999) &&
		JSON.stringify(bfTrace.stages.envelopeIds) ===
			JSON.stringify(bf.envelope.map((c) => c.id)),
);
// THE BUG, made executable: the raw pool credits a rank production discards.
check(
	"scoring MRR over the RAW pool CREDITS a chunk production filtered out (the bug)",
	reciprocalRank(similarityRankedIdsFromTrace(bfTrace), GOLD_BELOW) === 1 / 3,
	reciprocalRank(similarityRankedIdsFromTrace(bfTrace), GOLD_BELOW),
);
check(
	"…while MRR over the POST-FILTER pool honestly says 0 — it was never retrievable",
	reciprocalRank(postFilterRankedIdsFromTrace(bfTrace), GOLD_BELOW) === 0,
);
check(
	"…and hit rate over the ENVELOPE honestly says 0 (the LLM was never shown it)",
	hitRateAtK(envelopeIdsAtK(bfTrace, 8), GOLD_BELOW, 8) === 0 &&
		hitRateAtK(similarityRankedIdsFromTrace(bfTrace), GOLD_BELOW, 8) === 1,
);
// The raw stage really is cosine order (pins the stage's definition).
check(
	"trace.stages.rawRankedIds IS the raw cosine ranking",
	JSON.stringify(bfTrace.stages.rawRankedIds) ===
		JSON.stringify(similarityRankedIdsFromTrace(bfTrace)),
);

// OOS branch: the route refuses and builds NO envelope, but deriveEnvelopeAtK
// (which mirrors retrieveChunks' RETURN value) still hands back the full ranked
// pool. Slicing that to k and scoring it prints a hit rate for chunks the
// pipeline explicitly declined to show anyone.
const oosTrace = weak.trace as RetrievalTrace;
const OOS_GOLD = new Set([oosTrace.pool[0].chunk.id]);
check(
	"OOS: deriveEnvelopeAtK still returns the pool (it mirrors retrieveChunks' return value)",
	deriveEnvelopeAtK(oosTrace, 8).length > 0,
);
check(
	"OOS: scoring THAT would report hit@8 = 1 for a question production REFUSED (the bug)",
	hitRateAtK(
		deriveEnvelopeAtK(oosTrace, 8).slice(0, 8).map((c) => c.id),
		OOS_GOLD,
		8,
	) === 1,
);
check(
	"OOS: envelopeIdsAtK is EMPTY — the route feeds the LLM nothing at any k",
	envelopeIdsAtK(oosTrace, 3).length === 0 &&
		envelopeIdsAtK(oosTrace, 8).length === 0 &&
		oosTrace.stages.envelopeIds.length === 0,
);
check(
	"OOS: the eligible pool is EMPTY too, so MRR has nothing to rank (excluded, not 0)",
	postFilterRankedIdsFromTrace(oosTrace).length === 0 &&
		oosTrace.stages.postFilterRankedIds.length === 0,
);

// THE SCORERS THEMSELVES. The stage choice is made INSIDE scoreRetrievalStages /
// scoreEnvelopeAtK — pure functions run.ts delegates to — so a call site cannot
// wire a metric to the wrong pool. That is deliberate: round 1's fix was pinned
// only by a source-level string match, and a mutation that swapped the pool while
// keeping the call shape sailed straight through it. These drive the real
// functions, so any mutation of the stage choice fails behaviourally.
const bfServedEnvelope = bfTrace.stages.envelopeIds; // what the route served
const bfScores = scoreRetrievalStages({
	goldIds: GOLD_BELOW,
	k: 8,
	servedEnvelopeIds: bfServedEnvelope,
	trace: bfTrace,
});
check(
	"scoreRetrievalStages: MRR = 0 for a gold chunk below MIN_CHUNK_SIM (raw pool would say 1/3)",
	bfScores.reciprocal_rank === 0 &&
		reciprocalRank(similarityRankedIdsFromTrace(bfTrace), GOLD_BELOW) === 1 / 3,
	bfScores,
);
check(
	"scoreRetrievalStages: hit rate / recall / CP = 0 — the LLM was shown no gold chunk",
	bfScores.hit_rate_at_k === 0 &&
		bfScores.context_recall_at_k === 0 &&
		bfScores.context_precision_at_k === 0,
);
check(
	"scoreRetrievalStages: a measurable item carries NO exclusion reason",
	bfScores.envelopeExcludedReason === null && bfScores.mrrExcludedReason === null,
);
// A gold chunk that IS eligible ranks honestly at its post-filter position.
const eligibleScores = scoreRetrievalStages({
	goldIds: new Set([2]), // similarity 0.55, post-filter rank 2
	k: 8,
	servedEnvelopeIds: bfServedEnvelope,
	trace: bfTrace,
});
check(
	"scoreRetrievalStages: MRR = 1/2 for a gold chunk at post-filter rank 2",
	eligibleScores.reciprocal_rank === 0.5 && eligibleScores.hit_rate_at_k === 1,
	eligibleScores,
);
// OOS: both stages vanish, so BOTH exclusions fire — never a 0, never a 1.
const oosScores = scoreRetrievalStages({
	goldIds: OOS_GOLD,
	k: 8,
	servedEnvelopeIds: null, // the route emitted no data-sources frame
	trace: oosTrace,
});
check(
	"scoreRetrievalStages: an OOS item EXCLUDES every retrieval metric (never scores 0)",
	oosScores.hit_rate_at_k === null &&
		oosScores.context_recall_at_k === null &&
		oosScores.context_precision_at_k === null &&
		oosScores.reciprocal_rank === null,
	oosScores,
);
check(
	"…with a DISTINCT reason per stage (the envelope and the pool vanish for different causes)",
	oosScores.envelopeExcludedReason === "no_envelope_emitted:oos_or_guard_branch" &&
		oosScores.mrrExcludedReason === "oos_gate:no_eligible_pool",
	oosScores,
);
// An empty gold set is an empty denominator, not a score.
const noGoldScores = scoreRetrievalStages({
	goldIds: new Set<number>(),
	k: 8,
	servedEnvelopeIds: bfServedEnvelope,
	trace: bfTrace,
});
check(
	"scoreRetrievalStages: no gold chunk → EXCLUDED (an empty denominator is not a 0)",
	noGoldScores.hit_rate_at_k === null &&
		noGoldScores.context_recall_at_k === null &&
		noGoldScores.envelopeExcludedReason === "no_gold_chunks:denominator_is_empty",
);

// K-SWEEP. The OOS gate fires on the raw pool's top-1 and is k-INDEPENDENT, so
// the route builds no envelope at ANY k. Scoring the pool it refused would print
// a hit rate for chunks nobody was shown — and would vary the denominator across
// k, which alone makes the across-k comparison the sweep exists for ill-formed.
check(
	"kSweepExclusion flags an OOS item at every k",
	kSweepExclusion(oosTrace, OOS_GOLD) === "oos_gate:no_envelope_at_any_k",
);
check("kSweepExclusion passes a normal item", kSweepExclusion(bfTrace, GOLD_BELOW) === null);
for (const k of [3, 5, 8, 10]) {
	const s = scoreEnvelopeAtK({
		trace: oosTrace,
		goldIds: OOS_GOLD,
		k,
		excludedReason: kSweepExclusion(oosTrace, OOS_GOLD),
	});
	check(
		`ksweep k=${k}: an OOS item is EXCLUDED, not scored 1 against the refused pool`,
		s.hit_rate === null && s.context_recall === null && s.context_precision === null && s.retrieved_ids.length === 0,
		s,
	);
}
const sweepOk = scoreEnvelopeAtK({ trace: bfTrace, goldIds: new Set([2]), k: 8, excludedReason: null });
check(
	"ksweep: a normal item scores the ENVELOPE at k, and names that stage",
	sweepOk.stage === "envelope" && sweepOk.hit_rate === 1,
	sweepOk,
);
// And the report names the stage in the row label, so no reader has to guess.
const stageRows = rowsFor(baselineRun).map((r) => r.category);
check(
	"every reported retrieval row NAMES its stage",
	stageRows.some((c) => c.includes("[stage: envelope shown to the LLM]")) &&
		stageRows.some((c) => c.includes("[stage: post-filter similarity-ranked pool]")),
	stageRows,
);
check(
	"no reported row scores the RAW pool (it is diagnostic only)",
	!stageRows.some((c) => c.toLowerCase().includes("raw")),
);
check(
	"metric→stage map is exported so the item log records which pool each number came from",
	RETRIEVAL_METRIC_STAGE.reciprocal_rank === "post_filter_pool" &&
		RETRIEVAL_METRIC_STAGE.hit_rate_at_k === "envelope" &&
		RETRIEVAL_METRIC_STAGE.context_precision_at_k === "envelope",
);

// ---------------------------------------------------------------------------
section("19. Issue 4 — our own boilerplate must not be judged as model output");

// The bug, in the OTHER direction from the one this PR is named for. The
// low-similarity branch PREPENDS KNOWLEDGE_HUB_LIMITED_CONTEXT to an otherwise
// normal answer. run.ts fed that raw text to judgeFaithfulness,
// judgeCitationSupport, judgeRelevancyQuestions, scoreCitationValidity and
// normalizeText. A claim-decomposition judge extracts the disclaimer as one more
// claim — unsupported by any chunk, carrying no citation — so faithfulness and
// citation support were systematically DEFLATED, and only on the weak-retrieval
// questions, i.e. the hardest ones. A metric deflated by our own plumbing is
// exactly as dishonest as one inflated by a vacuous pass.
const MODEL_ANSWER = "Licensees shall conduct a panel walkdown [REGDOC-2.3.4 §3.2.3].";
const WITH_DISCLAIMER = `${KNOWLEDGE_HUB_LIMITED_CONTEXT}${MODEL_ANSWER}`;

check(
	"stripLimitedContextPrefix removes the route's prefix, leaving the model's own text",
	stripLimitedContextPrefix(WITH_DISCLAIMER) === MODEL_ANSWER,
	stripLimitedContextPrefix(WITH_DISCLAIMER),
);
check(
	"…and is a no-op on an answer that never carried it",
	stripLimitedContextPrefix(MODEL_ANSWER) === MODEL_ANSWER,
);
check(
	"…and does NOT strip the disclaimer's words from the MIDDLE of a real answer",
	stripLimitedContextPrefix(`The corpus has limited matches in the indexed corpus. ${MODEL_ANSWER}`).startsWith(
		"The corpus has limited",
	),
);
check(
	"…and does not touch the model's own low-confidence line (that IS model output)",
	stripLimitedContextPrefix(KNOWLEDGE_HUB_LOW_CONFIDENCE) === KNOWLEDGE_HUB_LOW_CONFIDENCE,
);

// The judged text is what a claim decomposer sees. Pin the property that matters:
// the disclaimer sentence is NOT in it, so it cannot become an unsupported claim.
check(
	"the judged text carries NO disclaimer sentence for a claim decomposer to score",
	!isLimitedContextText(stripLimitedContextPrefix(WITH_DISCLAIMER)) &&
		isLimitedContextText(WITH_DISCLAIMER),
);
// Branch detection is the ONE consumer that must still see the raw text.
check(
	"branch detection still sees the RAW text (it exists to find this very prefix)",
	classifyBranch({ text: WITH_DISCLAIMER, hasSourcesFrame: true }) === "limited_context",
);
check(
	"…and the disclaimer is still NOT a refusal — the model answered",
	!REFUSAL_BRANCHES.has("limited_context"),
);

// Citation extraction over the raw vs judged text: the disclaimer carries no
// citation, so a validity score computed over the raw text silently mixes route
// boilerplate into the answer under judgement.
check(
	"citation extraction over the judged text finds the model's citation",
	extractCitations(stripLimitedContextPrefix(WITH_DISCLAIMER)).length === 1,
);

// The call sites. run.ts must judge `judged`, never `answer.text`.
const RUN_SRC4 = readSrc("scripts/rag-eval/run.ts");
check(
	"run.ts derives a judged text by stripping the route's boilerplate",
	RUN_SRC4.includes("stripLimitedContextPrefix(a.text)") &&
		RUN_SRC4.includes("const judged = judgedText(answer)"),
);
check(
	"run.ts feeds the JUDGED text to faithfulness / citation-support / relevancy",
	RUN_SRC4.split("answer: judged,").length - 1 >= 3,
);
check(
	"run.ts no longer feeds RAW answer text to any judge",
	!RUN_SRC4.includes("answer: answer.text,\n\t\t\t\tchunks: ctx") &&
		!RUN_SRC4.includes("answerA: runs[a].text") &&
		!RUN_SRC4.includes("answerA: canonical.text"),
);
check(
	"citation validity scores the judged text, not the boilerplate-prefixed one",
	RUN_SRC4.includes("scoreCitationValidity(judged, sources)"),
);
check(
	"consistency + paraphrase compare MODEL output (the judged text feeds the scorers and the judge)",
	RUN_SRC4.includes("const judgedRuns = runs.map((a) => judgedText(a))") &&
		RUN_SRC4.includes("judgedTexts: judgedRuns") &&
		RUN_SRC4.includes("const canonicalJudged = judgedText(canonical)") &&
		RUN_SRC4.includes("const pJudged = judgedText(a)"),
);
check(
	"…and branch classification is the ONE consumer still given the raw text",
	RUN_SRC4.includes("classifyBranch({ text: a.text, hasSourcesFrame: a.sources !== null })"),
);
check(
	"negative rejection still scores the RAW text (it must see the route's own lines)",
	RUN_SRC4.includes("const verdict = scoreRejection({\n\t\t\t\tstatus: a.status,\n\t\t\t\ttext: a.text,"),
);

// ---------------------------------------------------------------------------
section("20. Issue 1 — the vacuous pass, hunted out of EVERY experiment");

// Round 1 fixed this for baseline's citation validity and stopped there. The
// IDENTICAL failure mode was still live in consistency and paraphrase.

// (a) CONSISTENCY. citationSetKey returned "" for a zero-citation answer, and
// totalAgreement(["","","","",""]) === 1 — so the headline citation-stability KPI
// reported PERFECT consistency precisely when the model cited nothing at all,
// five times over.
const REFUSAL = KNOWLEDGE_HUB_OUT_OF_SCOPE;
const CITING_A = "Licensees shall X [REGDOC-2.3.4 §3.2].";
const CITING_B = "Licensees must X [REGDOC-2.2.5 §3.1].";

check(
	"citationSetKey is NULL for a zero-citation answer (it used to be the empty string)",
	citationSetKey(REFUSAL) === null && citationSetKey("no citations here") === null,
);
check(
	"…and still a real, order-insensitive key when the answer DOES cite",
	citationSetKey(CITING_A) !== null,
);
// THE BUG, made executable.
check(
	"the OLD key would have scored 5 uncitable repeats as PERFECT agreement (the bug)",
	totalAgreement(["", "", "", "", ""]) === 1,
);
const allVacuousConsistency = scoreConsistency({
	judgedTexts: [REFUSAL, REFUSAL, REFUSAL, REFUSAL, REFUSAL],
	noEnvelope: [true, true, true, true, true],
});
check(
	"scoreConsistency: 5 zero-citation repeats are EXCLUDED, not scored 1",
	allVacuousConsistency.citation_set_agreement === null &&
		allVacuousConsistency.citation_agreement_excluded_reason !== null,
	allVacuousConsistency,
);
check(
	"…and TARr is EXCLUDED too — the guard/OOS branch emits a CONSTANT and never calls the model",
	allVacuousConsistency.tarr_exact_text_agreement === null &&
		allVacuousConsistency.tarr_excluded_reason?.includes("no_llm_call") === true,
	allVacuousConsistency,
);
check(
	"…and the citation-coverage companion records the zero over the FULL denominator",
	allVacuousConsistency.citation_coverage === 0,
);
// A MIXED case is a genuine disagreement — measured, not hidden.
const mixedConsistency = scoreConsistency({
	judgedTexts: [CITING_A, REFUSAL, CITING_A, CITING_A, CITING_A],
	noEnvelope: [false, false, false, false, false],
});
check(
	"one repeat citing nothing while others cite IS a disagreement (0), not an exclusion",
	mixedConsistency.citation_set_agreement === 0 &&
		mixedConsistency.citation_agreement_excluded_reason === null,
	mixedConsistency,
);
check(
	"…and coverage shows 4 of 5 repeats cited",
	Math.abs((mixedConsistency.citation_coverage ?? 0) - 0.8) < 1e-9,
);
const stableConsistency = scoreConsistency({
	judgedTexts: [CITING_A, CITING_A, CITING_A, CITING_A, CITING_A],
	noEnvelope: [false, false, false, false, false],
});
check(
	"5 repeats that genuinely agree still score 1 (the fix does not deflate the real case)",
	stableConsistency.citation_set_agreement === 1 &&
		stableConsistency.tarr_exact_text_agreement === 1 &&
		stableConsistency.citation_coverage === 1,
);
const disagreeConsistency = scoreConsistency({
	judgedTexts: [CITING_A, CITING_B, CITING_A, CITING_A, CITING_A],
	noEnvelope: [false, false, false, false, false],
});
check(
	"…and a real citation disagreement still scores 0",
	disagreeConsistency.citation_set_agreement === 0,
);
// An LLM-level refusal (the model DID run) is still measurable for TARr.
const llmRefusedConsistency = scoreConsistency({
	judgedTexts: [REFUSAL, REFUSAL, REFUSAL],
	noEnvelope: [false, false, false], // envelope WAS built; the model refused
});
check(
	"an LLM-level refusal x3 keeps TARr measurable (the model ran) but EXCLUDES citation agreement",
	llmRefusedConsistency.tarr_exact_text_agreement === 1 &&
		llmRefusedConsistency.citation_set_agreement === null,
	llmRefusedConsistency,
);

// (b) PARAPHRASE. Three vacuous passes at once.
const ENV_A = new Set([1, 2, 3]);
const ENV_B = new Set([2, 3, 4]);
const EMPTY = new Set<number>();

check(
	"jaccard(∅, ∅) === 1 — two empty envelopes scored PERFECT retrieval stability (the bug)",
	jaccard(EMPTY, EMPTY) === 1,
);
const bothRefused = scoreParaphrasePair({
	canonicalEnvelopeIds: EMPTY,
	paraphraseEnvelopeIds: EMPTY,
	canonicalJudgedText: REFUSAL,
	paraphraseJudgedText: REFUSAL,
	canonicalBranch: "oos_or_guard",
	paraphraseBranch: "oos_or_guard",
});
check(
	"scoreParaphrasePair: two refusals EXCLUDE retrieval Jaccard, not score it 1.0",
	bothRefused.retrieval_jaccard === null &&
		bothRefused.jaccard_excluded_reason?.startsWith("no_envelope:both") === true,
	bothRefused,
);
check(
	"…EXCLUDE citation stability, not score it 1.0 (two uncitable answers share no set)",
	bothRefused.citation_set_stable === null &&
		bothRefused.citation_stability_excluded_reason?.startsWith("zero_citations:both") === true,
);
check(
	"…and EXCLUDE answer-equivalence — the judge's own rubric calls two refusals 'equivalent'",
	bothRefused.skipEquivalenceJudge &&
		bothRefused.equivalence_excluded_reason?.startsWith("refusal:both") === true,
);
check(
	"…with all three FULL-denominator coverage companions recording the zero",
	bothRefused.both_sides_have_envelope === 0 &&
		bothRefused.both_sides_cited === 0 &&
		bothRefused.both_sides_answered === 0,
);
// One-sided failures are excluded too — but the coverage rows make them visible,
// so nothing is swept under the rug in either direction.
const oneSided = scoreParaphrasePair({
	canonicalEnvelopeIds: ENV_A,
	paraphraseEnvelopeIds: EMPTY,
	canonicalJudgedText: CITING_A,
	paraphraseJudgedText: REFUSAL,
	canonicalBranch: null,
	paraphraseBranch: "oos_or_guard",
});
check(
	"a paraphrase that broke retrieval is EXCLUDED but NAMED (canonical vs paraphrase)",
	oneSided.retrieval_jaccard === null &&
		oneSided.jaccard_excluded_reason?.includes("paraphrase") === true &&
		oneSided.both_sides_have_envelope === 0,
	oneSided,
);
check(
	"…and its coverage companions are what surface it (0 of 1 answered / cited)",
	oneSided.both_sides_answered === 0 && oneSided.both_sides_cited === 0,
);
// The real case still measures.
const realPair = scoreParaphrasePair({
	canonicalEnvelopeIds: ENV_A,
	paraphraseEnvelopeIds: ENV_B,
	canonicalJudgedText: CITING_A,
	paraphraseJudgedText: CITING_A,
	canonicalBranch: null,
	paraphraseBranch: null,
});
check(
	"a genuine paraphrase pair still scores Jaccard = 1/2 and stability = 1",
	Math.abs((realPair.retrieval_jaccard ?? 0) - 0.5) < 1e-9 &&
		realPair.citation_set_stable === 1 &&
		!realPair.skipEquivalenceJudge,
	realPair,
);
const unstablePair = scoreParaphrasePair({
	canonicalEnvelopeIds: ENV_A,
	paraphraseEnvelopeIds: ENV_B,
	canonicalJudgedText: CITING_A,
	paraphraseJudgedText: CITING_B,
	canonicalBranch: null,
	paraphraseBranch: null,
});
check(
	"…and a genuinely unstable citation set still scores 0",
	unstablePair.citation_set_stable === 0,
);

// (c) NEGATIVE. A 200 that streamed no text is neither a refusal nor an answer.
// The old code ran isRefusalText("") → false → "answered_instead_of_rejecting",
// a FALSE FAILURE dragging the row down for a reason that is not the pipeline's
// refusal behaviour.
const emptyBody = rej({ text: "" });
check(
	"an empty 200 response is NOT MEASURABLE (excluded), not a false rejection FAILURE",
	emptyBody.success === null && emptyBody.reason.includes("empty_response_body"),
	emptyBody,
);
check(
	"…while a real answer to an OOC probe is still an honest FAILURE",
	rej({ text: "The NRC requires 40 hours of training." }).success === false,
);

// (d) THE REPORT. No aggregated row may print a percentage whose denominator
// silently swallowed the vacuous cases — in EITHER direction.
const consistencyRun = {
	dir: "fixture",
	manifest: {
		experiment: "consistency",
		aborted: false,
		items: 2,
		prompt_version: "test",
		models: {},
		judge_errors: {},
		cost: { capUsd: 2, totalUsd: 0, byKind: {} },
		golden_set: { sha256: "x", records: 2 },
	},
	items: [
		{ metrics: { citation_set_agreement: 1, tarr_exact_text_agreement: 1, citation_coverage_across_repeats: 1 } },
		// all 5 repeats refused, citing nothing: EXCLUDED from both agreements.
		{ metrics: { citation_set_agreement: null, tarr_exact_text_agreement: null, citation_coverage_across_repeats: 0 } },
	],
} as unknown as Parameters<typeof rowsFor>[0];
const cRows = rowsFor(consistencyRun);
const cRow = (c: string): Row => cRows.find((r) => r.category.startsWith(c)) as Row;
const citeAgree = cRow("Consistency (citation-set agreement");
check(
	"consistency: citation-set agreement = 100% over n=1 — the uncitable item is EXCLUDED, not a free 1",
	citeAgree.measured === "100.0%" && citeAgree.n === "1" && citeAgree.excluded.startsWith("1 —"),
	citeAgree,
);
check(
	"…and the exclusion says WHY, in the table itself",
	citeAgree.excluded.toLowerCase().includes("cited nothing") ||
		citeAgree.excluded.toLowerCase().includes("uncitable"),
	citeAgree.excluded,
);
const covRepeats = cRow("Citation coverage across repeats");
check(
	"…and a FULL-denominator coverage row (n=2) makes the zero-citation item visible",
	covRepeats.measured === "50.0%" && covRepeats.n === "2",
	covRepeats,
);

const paraphraseRun = {
	...consistencyRun,
	manifest: { ...consistencyRun.manifest, experiment: "paraphrase" },
	items: [
		{
			paraphrases: [
				{ metrics: { retrieval_jaccard: 0.5, citation_set_stable: 1, answer_equivalent: true, both_sides_have_envelope: 1, both_sides_cited: 1, both_sides_answered: 1 } },
				// both sides refused: every metric EXCLUDED, all three coverages 0.
				{ metrics: { retrieval_jaccard: null, citation_set_stable: null, answer_equivalent: null, both_sides_have_envelope: 0, both_sides_cited: 0, both_sides_answered: 0 } },
			],
		},
	],
} as unknown as Parameters<typeof rowsFor>[0];
const pRows = rowsFor(paraphraseRun);
const pRow = (c: string): Row => pRows.find((r) => r.category.startsWith(c)) as Row;
const jacRow = pRow("Paraphrase retrieval Jaccard");
check(
	"paraphrase: Jaccard = 50% over n=1 — the both-refused pair is EXCLUDED, not scored 1.0",
	jacRow.measured === "50.0%" && jacRow.n === "1" && jacRow.excluded.startsWith("1 —"),
	jacRow,
);
const stabRow = pRow("Paraphrase citation-set stability");
check(
	"paraphrase: citation stability excludes the uncitable pair rather than passing it",
	stabRow.n === "1" && stabRow.excluded.startsWith("1 —"),
	stabRow,
);
const eqRow = pRow("Paraphrase answer-equivalence rate");
check(
	"paraphrase: equivalence excludes the refusal pair (the rubric would have called it 'equivalent')",
	eqRow.n === "1" && eqRow.excluded.startsWith("1 —"),
	eqRow,
);
check(
	"paraphrase: three FULL-denominator coverage rows keep the exclusions honest",
	["Paraphrase envelope coverage", "Paraphrase citation coverage", "Paraphrase answer coverage"].every(
		(c) => pRow(c) !== undefined && pRow(c).n === "2" && pRow(c).measured === "50.0%",
	),
	pRows.map((r) => `${r.category}=${r.measured}/n=${r.n}`),
);

// A run in which NOTHING is measurable must print n/a — never a flattering number.
const allVacuousParaphrase = rowsFor({
	...paraphraseRun,
	items: [
		{
			paraphrases: [
				{ metrics: { retrieval_jaccard: null, citation_set_stable: null, answer_equivalent: null, both_sides_have_envelope: 0, both_sides_cited: 0, both_sides_answered: 0 } },
			],
		},
	],
} as unknown as Parameters<typeof rowsFor>[0]);
check(
	"a paraphrase run where everything refused prints n/a over n=0 — NOT 100% stability",
	(allVacuousParaphrase.find((r) => r.category.startsWith("Paraphrase retrieval Jaccard")) as Row).measured === "n/a" &&
		(allVacuousParaphrase.find((r) => r.category.startsWith("Paraphrase citation-set stability")) as Row).measured === "n/a",
	allVacuousParaphrase.map((r) => `${r.category}=${r.measured}`),
);
const allVacuousConsistencyRows = rowsFor({
	...consistencyRun,
	items: [consistencyRun.items[1], consistencyRun.items[1]],
} as unknown as Parameters<typeof rowsFor>[0]);
check(
	"a consistency run where every repeat cited nothing prints n/a — NOT 100% agreement",
	(allVacuousConsistencyRows.find((r) => r.category.startsWith("Consistency (citation-set agreement")) as Row).measured === "n/a" &&
		(allVacuousConsistencyRows.find((r) => r.category.startsWith("Consistency (TARr")) as Row).measured === "n/a",
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
