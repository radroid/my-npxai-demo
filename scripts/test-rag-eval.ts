#!/usr/bin/env bun
// RAG eval framework — OFFLINE self-test (item-2 slice 2.1).
//
//   bun run test:rag-eval
//
// Pure/offline by design, same contract as scripts/test-artifact.ts: fixtures
// only — no network, no OpenAI, no Supabase, no dev server. `globalThis.fetch`
// is replaced with a throwing stub, so ANY accidental network call fails the
// run loudly. That stub is also what proves DELTA D2: driving the real
// lib/retrieval with a no-op `recordUsage` must make ZERO network calls, i.e.
// the eval path never increments the production daily OpenAI circuit-breaker
// (whose recordOpenAICall talks to Upstash over REST).
//
// Exit code 0 on pass, 1 on any failure. Never wired into lint/build/CI (I2.1).

import type OpenAI from "openai";
import type { RetrievedChunk } from "../lib/context-envelope";
import {
	LOW_SIM_OOS,
	MIN_CHUNK_SIM,
	type RetrievalDeps,
	type RetrievalTrace,
	deriveEnvelopeAtK,
	retrieveChunks,
} from "../lib/retrieval";
import {
	KNOWLEDGE_HUB_LOW_CONFIDENCE,
	KNOWLEDGE_HUB_OUT_OF_SCOPE,
} from "../lib/prompts";
import { GOLDEN_PATH, OOC_PROBES_PATH } from "./rag-eval/config";
import {
	citationSetKey,
	extractCitations,
	isCitationValid,
	scoreCitationValidity,
	sectionMatchesPrefix,
} from "./rag-eval/citations";
import { CostAccountant, CostCapError, priceUsd } from "./rag-eval/cost";
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
import { type JudgeDeps, judgeFaithfulness, judged } from "./rag-eval/judge";
import {
	clamp01,
	contextPrecisionAtK,
	contextRecallAtK,
	cosineSimilarity,
	disagreeingPairs,
	hitRateAtK,
	jaccard,
	mean,
	normalizeText,
	reciprocalRank,
	scoreRejection,
	totalAgreement,
} from "./rag-eval/metrics";
import { meteredOpenAI } from "./rag-eval/openai";
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
const fabricated = scoreCitationValidity("See [REGDOC-9.9.9 §1].", SOURCES);
check("validity = 0 for a wholly fabricated citation", fabricated.score === 0 && fabricated.invalid.length === 1);
check("validity = 1.0 (with total 0) when an answer cites nothing", scoreCitationValidity("No citations here.", SOURCES).score === 1);
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
		oosLine: KNOWLEDGE_HUB_OUT_OF_SCOPE,
		lowConfidenceLine: KNOWLEDGE_HUB_LOW_CONFIDENCE,
		...over,
	});
check("guard/sim-gate refusal (no data-sources frame) = SUCCESS", rej({}).success && rej({}).layer === "deterministic_or_sim_gate");
check("LLM-level refusal (with sources frame) = SUCCESS", rej({ hasSourcesFrame: true }).layer === "llm_refusal");
check("low-confidence line also counts as a rejection", rej({ text: lowConfText }).success);
check("HTTP 4xx block = SUCCESS at the request boundary", rej({ status: 400 }).success && rej({ status: 400 }).layer === "guard_http");
check("answering an OOC probe = FAILURE", !rej({ text: "The NRC requires 40 hours." }).success);
const fab = rej({ text: `${oosText} But see [REGDOC-2.3.4 §3.2].` });
check("fabricated citation inside a rejection = FAILURE", !fab.success && fab.fabricatedCitations === 1, fab);
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

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
