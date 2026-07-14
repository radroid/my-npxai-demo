#!/usr/bin/env bun
// RAG eval framework — golden dataset + paraphrase generator
// (item-2 slice 2.1, R3 + R5).  `bun run eval:rag:golden`
//
// Corpus of record: the Supabase `regdoc_chunks` table (NOT scraped_regdocs/,
// which is gitignored and is not what retrieval searches). Gold chunk ids are
// the ids the RPC returns, and every record also carries the re-ingest-stable
// fingerprint (regdoc_id, chunk_index, sha256(chunk_text)) — I2.10.
//
// Mix (research doc §Golden dataset construction): ~60% single-chunk specific,
// ~20% multi-chunk, ~20% hand-written (reused from evals/knowledge-hub.jsonl,
// whose must_cite doc+section are resolved to gold chunk ids by DB lookup).
// Questions are written by the JUDGE-tier model (gpt-4o by default) — never the
// gpt-4o-mini answerer, which would grade questions written in its own style.
//
// Two hard filters before a synthetic record is kept:
//   1. detectJailbreakMarkers (lib/validators.ts) — a question that trips the
//      route's deterministic guard gets refused and poisons generation metrics.
//   2. Retrieval sanity probe — the gold chunk must place in the pipeline's own
//      top-20 pool. Un-retrievable gold is a mislabeled item, not a finding.
//
// I2.8: read-only DB access. I2.12: every OpenAI call goes through the cost
// accountant, and the run aborts at EVAL_COST_CAP_USD.
//
// If Supabase is unreachable (paused free-tier project — supabase/RECOVERY.md),
// preflight aborts BEFORE any OpenAI spend (Edge case 1).

import { retrieveChunks } from "../../lib/retrieval";
import { detectJailbreakMarkers } from "../../lib/validators";
import {
	GOLDEN_PATH,
	PARAPHRASES_PATH,
	PRODUCTION_K,
	costCapUsd,
	judgeModel,
} from "./config";
import { CostAccountant, asCostCapError } from "./cost";
import {
	type GoldChunkRef,
	type GoldenRecord,
	type ParaphraseRecord,
	readJsonl,
	writeJsonl,
} from "./datasets";
import {
	type JudgeDeps,
	judgeGenerateGolden,
	judgeGenerateParaphrases,
	judgeMeaningEquivalence,
} from "./judge";
import { getEvalOpenAI, meteredOpenAI } from "./openai";
import {
	type CorpusChunk,
	countChunks,
	fetchAllChunks,
	getEvalSupabase,
	toGoldChunkRef,
} from "./supabase";

// Target mix — 4 records per doc across 19 docs ≈ 76 (spec R3: 70–80).
const TARGET_SINGLE = 44;
const TARGET_MULTI = 14;
const HAND_SUITE_PATH = "evals/knowledge-hub.jsonl";
const PARAPHRASE_SUBSET = 20;
const MIN_CHUNK_CHARS = 300;

interface HandRecord {
	id: number;
	category: string;
	question: string;
	expected_behavior: string;
	must_cite?: string[];
	must_cite_section?: string[];
}

function log(msg: string): void {
	console.log(msg);
}

/** Chunks worth asking about: substantive text, with a section label. */
function isUsable(c: CorpusChunk): boolean {
	return c.chunk_text.trim().length >= MIN_CHUNK_CHARS && !!c.section_number;
}

/** Round-robin across docs so no doc dominates the sample. */
function stratify(chunks: CorpusChunk[], want: number): CorpusChunk[] {
	const byDoc = new Map<string, CorpusChunk[]>();
	for (const c of chunks) {
		const list = byDoc.get(c.regdoc_id) ?? [];
		list.push(c);
		byDoc.set(c.regdoc_id, list);
	}
	// Deterministic: prefer requirement chunks, then longest text, then id.
	for (const list of byDoc.values()) {
		list.sort((a, b) => {
			const ra = a.requirement_type === "requirement" ? 0 : 1;
			const rb = b.requirement_type === "requirement" ? 0 : 1;
			if (ra !== rb) return ra - rb;
			if (a.chunk_text.length !== b.chunk_text.length) {
				return b.chunk_text.length - a.chunk_text.length;
			}
			return a.id - b.id;
		});
	}
	const docs = Array.from(byDoc.keys()).sort();
	const out: CorpusChunk[] = [];
	for (let round = 0; out.length < want; round++) {
		let progressed = false;
		for (const doc of docs) {
			const list = byDoc.get(doc);
			if (!list || round >= list.length) continue;
			out.push(list[round]);
			progressed = true;
			if (out.length >= want) break;
		}
		if (!progressed) break;
	}
	return out;
}

/** Adjacent chunk pairs inside one section — the multi-chunk difficulty. */
function adjacentPairs(chunks: CorpusChunk[], want: number): CorpusChunk[][] {
	const byId = new Map<number, CorpusChunk>(chunks.map((c) => [c.id, c]));
	const byDocIndex = new Map<string, CorpusChunk>();
	for (const c of chunks) byDocIndex.set(`${c.regdoc_id}#${c.chunk_index}`, c);
	const pairs: CorpusChunk[][] = [];
	const seenDocs = new Map<string, number>();
	for (const c of stratify(chunks, chunks.length)) {
		if (pairs.length >= want) break;
		const next = byDocIndex.get(`${c.regdoc_id}#${c.chunk_index + 1}`);
		if (!next || !byId.has(next.id)) continue;
		if (next.section_number !== c.section_number) continue;
		// At most 2 multi-chunk items per doc, so the mix stays spread out.
		const used = seenDocs.get(c.regdoc_id) ?? 0;
		if (used >= 2) continue;
		seenDocs.set(c.regdoc_id, used + 1);
		pairs.push([c, next]);
	}
	return pairs;
}

/** Section-prefix match, same semantics as the ship battery's grader. */
function sectionMatches(chunkSection: string | null, want: string): boolean {
	if (!chunkSection) return false;
	return (
		chunkSection === want ||
		chunkSection.startsWith(`${want}.`) ||
		chunkSection.startsWith(`${want}(`) ||
		want.startsWith(`${chunkSection}.`)
	);
}

async function main(): Promise<void> {
	const cap = costCapUsd();
	const cost = new CostAccountant(cap);
	log(`golden generator — judge model ${judgeModel()}, cap $${cap.toFixed(2)}`);

	// --- Preflight (no OpenAI spend before this passes) ---------------------
	const supabase = getEvalSupabase();
	const total = await countChunks(supabase); // throws SupabaseUnreachableError
	log(`supabase ok — ${total} chunks in regdoc_chunks`);
	if (total === 0) throw new Error("regdoc_chunks is empty — run `bun run ingest`.");

	const corpus = await fetchAllChunks(supabase);
	const usable = corpus.filter(isUsable);
	const docs = new Set(corpus.map((c) => c.regdoc_id));
	log(`corpus: ${corpus.length} chunks, ${usable.length} usable, ${docs.size} docs`);

	const rawOpenai = getEvalOpenAI();
	const openai = meteredOpenAI(rawOpenai, cost, "golden-gen-retrieval-probe");
	const deps: JudgeDeps = { openai: rawOpenai, cost };

	const records: GoldenRecord[] = [];
	let rejectedJailbreak = 0;
	let rejectedUnretrievable = 0;
	let judgeErrors = 0;

	// DELTA D2: the eval path must NOT increment the production daily OpenAI
	// circuit-breaker counter — pass a no-op recordUsage. Production routes omit
	// it and keep the recordOpenAICall default (byte-identical behavior).
	const noopRecordUsage = async () => {};

	/** Gold must place in the pipeline's own top-20 pool, else it's mislabeled. */
	async function retrievable(
		question: string,
		goldIds: number[],
	): Promise<boolean> {
		const res = await retrieveChunks(
			question,
			{ supabase, openai, recordUsage: noopRecordUsage },
			{ envelopeChunks: PRODUCTION_K, withTrace: true },
		);
		const pool = new Set((res.trace?.pool ?? []).slice(0, 20).map((e) => e.chunk.id));
		return goldIds.some((id) => pool.has(id));
	}

	async function emit(
		chunks: CorpusChunk[],
		difficulty: "single" | "multi",
		idx: number,
	): Promise<void> {
		const ctx = chunks.map((c) => ({
			id: c.id,
			regdoc_id: c.regdoc_id,
			section_number: c.section_number,
			text: c.chunk_text,
		}));
		const drafted = await judgeGenerateGolden(deps, { chunks: ctx, difficulty });
		if (!drafted.ok || !drafted.value) {
			judgeErrors++;
			return;
		}
		const { question, ground_truth_answer } = drafted.value;
		const markers = detectJailbreakMarkers(question);
		if (markers.length > 0) {
			rejectedJailbreak++;
			log(`  reject (jailbreak markers ${markers.join(",")}): ${question.slice(0, 60)}`);
			return;
		}
		const goldIds = chunks.map((c) => c.id);
		if (!(await retrievable(question, goldIds))) {
			rejectedUnretrievable++;
			log(`  reject (gold not in top-20): ${question.slice(0, 60)}`);
			return;
		}
		const gold_chunks: GoldChunkRef[] = await Promise.all(
			chunks.map((c) => toGoldChunkRef(c)),
		);
		records.push({
			question_id: `${difficulty === "single" ? "s" : "m"}${String(idx).padStart(3, "0")}`,
			question,
			ground_truth_answer,
			origin: "synthetic",
			difficulty,
			gold_chunks,
		});
	}

	// --- Synthetic: single-chunk --------------------------------------------
	const singles = stratify(usable, TARGET_SINGLE);
	log(`\ngenerating ${singles.length} single-chunk records…`);
	for (let i = 0; i < singles.length; i++) await emit([singles[i]], "single", i + 1);

	// --- Synthetic: multi-chunk ---------------------------------------------
	const pairs = adjacentPairs(usable, TARGET_MULTI);
	log(`\ngenerating ${pairs.length} multi-chunk records…`);
	for (let i = 0; i < pairs.length; i++) await emit(pairs[i], "multi", i + 1);

	// --- Hand-written: reuse the curated ship battery ------------------------
	// Its must_cite doc + must_cite_section resolve to gold chunk ids by DB
	// lookup, which is what makes the free ID-based retrieval metrics work.
	log("\nresolving hand-written records from evals/knowledge-hub.jsonl…");
	const hand = readJsonl<HandRecord>(HAND_SUITE_PATH).filter(
		(r) => r.category === "core" && r.expected_behavior === "answer",
	);
	for (const h of hand) {
		const wantDocs = h.must_cite ?? [];
		const wantSections = h.must_cite_section ?? [];
		const matched = corpus.filter(
			(c) =>
				wantDocs.includes(c.regdoc_id) &&
				(wantSections.length === 0 ||
					wantSections.some((s) => sectionMatches(c.section_number, s))),
		);
		if (matched.length === 0) {
			log(`  skip hand #${h.id} — no chunk matches ${wantDocs.join(",")} §${wantSections.join("/")}`);
			continue;
		}
		const gold_chunks = await Promise.all(matched.map((c) => toGoldChunkRef(c)));
		records.push({
			question_id: `h${String(h.id).padStart(3, "0")}`,
			question: h.question,
			// The ship battery asserts behavior, not a reference answer; the gold
			// chunks ARE the reference for ID-based retrieval metrics, and the
			// reference-free generation metrics (faithfulness, relevancy) need no
			// ground-truth answer. Left empty rather than fabricated.
			ground_truth_answer: "",
			origin: "hand",
			difficulty: matched.length > 1 ? "multi" : "single",
			gold_chunks,
		});
	}

	writeJsonl(GOLDEN_PATH, records);
	log(`\nwrote ${records.length} records → ${GOLDEN_PATH}`);
	log(
		`  synthetic ${records.filter((r) => r.origin === "synthetic").length} / ` +
			`hand ${records.filter((r) => r.origin === "hand").length} · ` +
			`single ${records.filter((r) => r.difficulty === "single").length} / ` +
			`multi ${records.filter((r) => r.difficulty === "multi").length}`,
	);
	log(
		`  rejected: ${rejectedJailbreak} jailbreak-marker, ${rejectedUnretrievable} un-retrievable; ${judgeErrors} judge errors`,
	);

	// --- Paraphrases (R5): stratified 20-question subset, 3 each -------------
	const subset = stratifyGolden(records, PARAPHRASE_SUBSET);
	log(`\ngenerating paraphrases for ${subset.length} questions…`);
	const paraphrases: ParaphraseRecord[] = [];
	let rejectedNonEquivalent = 0;
	for (const rec of subset) {
		const gen = await judgeGenerateParaphrases(deps, { question: rec.question });
		if (!gen.ok || !gen.value) {
			judgeErrors++;
			continue;
		}
		let n = 0;
		for (const p of gen.value) {
			// Every paraphrase is validated for meaning-equivalence BEFORE inclusion
			// (R5) — an unvalidated paraphrase set measures the generator, not the
			// pipeline's robustness.
			const eq = await judgeMeaningEquivalence(deps, {
				original: rec.question,
				candidate: p,
			});
			if (!eq.ok || !eq.value?.equivalent) {
				rejectedNonEquivalent++;
				continue;
			}
			n++;
			paraphrases.push({
				parent_question_id: rec.question_id,
				paraphrase_id: `${rec.question_id}-p${n}`,
				question: p,
			});
		}
	}
	writeJsonl(PARAPHRASES_PATH, paraphrases);
	log(
		`wrote ${paraphrases.length} paraphrases → ${PARAPHRASES_PATH} ` +
			`(${rejectedNonEquivalent} rejected as non-equivalent)`,
	);

	log("\n--- cost ---");
	for (const line of cost.summaryLines()) log(`  ${line}`);
	log(
		"\nNOTE: this set is AGENT-CURATED. Add the human-review row to " +
			"docs/orchestration/manual-verification.md and disclose the review status " +
			"in the slice-2.2 report.",
	);
}

/** Stratified subset: cover both difficulties and >= 10 distinct docs (R5). */
function stratifyGolden(records: GoldenRecord[], want: number): GoldenRecord[] {
	const byDoc = new Map<string, GoldenRecord[]>();
	for (const r of records) {
		const doc = r.gold_chunks[0]?.regdoc_id ?? "unknown";
		const list = byDoc.get(doc) ?? [];
		list.push(r);
		byDoc.set(doc, list);
	}
	for (const list of byDoc.values()) {
		// Multi first so both difficulties survive the round-robin.
		list.sort((a, b) => (a.difficulty === b.difficulty ? 0 : a.difficulty === "multi" ? -1 : 1));
	}
	const docs = Array.from(byDoc.keys()).sort();
	const out: GoldenRecord[] = [];
	for (let round = 0; out.length < want; round++) {
		let progressed = false;
		for (const doc of docs) {
			const list = byDoc.get(doc);
			if (!list || round >= list.length) continue;
			out.push(list[round]);
			progressed = true;
			if (out.length >= want) break;
		}
		if (!progressed) break;
	}
	return out;
}

try {
	await main();
} catch (err) {
	// asCostCapError, not `instanceof` (PR #8 fix round 1, issue 4b): a cap trip
	// inside a retrieval embedding comes back wrapped in RetrievalError, and a
	// bare instanceof check would report it as "retrieval_failed:embedding" —
	// an outage the operator would re-run, spending MORE.
	const capped = asCostCapError(err);
	if (capped) {
		console.error(`\nABORTED — ${capped.message}`);
		console.error("Raise EVAL_COST_CAP_USD only if you mean to spend more.");
		process.exit(1);
	}
	console.error(`\nFAILED — ${(err as Error).message}`);
	process.exit(1);
}
