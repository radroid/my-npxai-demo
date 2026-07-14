// Knowledge Hub retrieval pipeline (Appendix D.3) — extracted verbatim from
// app/api/knowledge-hub/query/route.ts so the artifact route can reuse the
// exact same machinery. Pure move (invariant I1.10): zero logic, constant,
// or threshold changes; every calibration comment travels with its constant.
// Next.js route files cannot export non-handler symbols, which is why the
// shared pipeline lives here in lib/.

import type OpenAI from "openai";
import type { RetrievedChunk } from "./context-envelope";
import { type GuardedHandlerArgs, recordOpenAICall } from "./guard";
import { OPENAI_MODELS } from "./openai";

// D.3 fallback thresholds. Calibrated 2026-04-17 against scripts/probe-sims.ts:
// LOW_SIM_OOS=0.40 lets single-word corpus-relevant queries (Q20 "turnover" at
// 0.426) through while still catching OOS/adversarial (<0.33 on current corpus).
// MIN_CHUNK_SIM=0.35 drops low-relevance glossary chunks (Q19 regression: a
// REGDOC-3.6 chunk at 0.32 was being cited instead of the on-topic top-1).
export const LOW_SIM_OOS = 0.4;
export const LOW_SIM_DISCLAIMER = 0.35;
// Retrieve a wider pool (RPC caps at 20) so that when the user names a
// specific REGDOC the doc-mention reranker below can surface chunks from
// that doc even if they don't win on pure cosine sim against a crowded
// corpus. Final envelope is trimmed to ENVELOPE_CHUNKS chunks.
export const MATCH_COUNT = 20;
// Envelope stays at 8 to keep the LLM focused on the strongest chunks —
// larger envelopes (tested at 12) caused the model to paraphrase more
// aggressively and miss verbatim phrases the eval cares about.
export const ENVELOPE_CHUNKS = 8;
export const MIN_CHUNK_SIM = 0.35;
// Score boost applied to a chunk when its regdoc_id appears explicitly
// in the user query. Calibrated so that a named-doc chunk at sim 0.55
// ranks above an unrelated-doc chunk at sim 0.70.
export const NAMED_DOC_BOOST = 0.2;

// Recognizes "REGDOC-X.X", "REGDOC-X.X.X", "REGDOC 2.5.2", "NSCA" in user
// query text. Returns the canonical regdoc_id form.
const QUERY_DOC_RE = /\b(?:REGDOC[\s-]?(\d+(?:\.\d+){1,3})|(NSCA))\b/gi;

// Concept → REGDOC map for queries that don't name the doc explicitly but
// lean on a CNSC term of art. Used only as a hint for the query-expansion
// retrieval (NOT for the OOS gate) so we can still pull graded-approach
// chunks from REGDOC-3.5.3 when the question's vocabulary is dominated by
// another domain (e.g. waste management → REGDOC-2.11.1).
const CONCEPT_DOC_HINTS: Array<[RegExp, string]> = [
	[/\bgraded approach\b/i, "REGDOC-3.5.3"],
	[/\baction level\b/i, "REGDOC-3.6"],
	[/\bALARA\b/i, "REGDOC-2.7.1"],
	[
		/\b(?:radioactive waste|waste management|waste stream|waste acceptance)\b/i,
		"REGDOC-2.11.1",
	],
];

// "section 48", "§26", "s. 12" style references. Lets us build a tighter
// expansion query ("NSCA §48 offences") that pulls statutory text which
// embeds very weakly against verbose natural-language questions.
const QUERY_SECTION_RE = /(?:§|\bsection\s+|\bs\.\s*)(\d+(?:\.\d+){0,3})\b/gi;

function extractMentionedDocs(query: string): Set<string> {
	const out = new Set<string>();
	for (const m of query.matchAll(QUERY_DOC_RE)) {
		if (m[1]) out.add(`REGDOC-${m[1]}`);
		else if (m[2]) out.add("NSCA");
	}
	for (const [re, doc] of CONCEPT_DOC_HINTS) {
		if (re.test(query)) out.add(doc);
	}
	return out;
}

function extractMentionedSections(query: string): string[] {
	const out = new Set<string>();
	for (const m of query.matchAll(QUERY_SECTION_RE)) {
		if (m[1]) out.add(m[1]);
	}
	return Array.from(out);
}

// Key regulatory nouns that, when present in the user query, sharpen a
// section-focused expansion enough to pull the right chunk into top-20 —
// "NSCA section 48" alone returns zero NSCA hits, but "NSCA section 48
// offence" puts NSCA §48 at rank 5.
const SECTION_CONTEXT_NOUNS = [
	"offence",
	"offences",
	"requirement",
	"requirements",
	"guidance",
	"plan",
	"report",
	"authority",
];

function pickContextNoun(query: string): string | null {
	const lower = query.toLowerCase();
	for (const n of SECTION_CONTEXT_NOUNS) {
		if (new RegExp(`\\b${n}\\b`).test(lower)) return n;
	}
	return null;
}

// Concept phrases that, when present in the query, should seed an
// extra tight expansion. These cover cases where a multi-part question
// asks about a specific sub-concept buried under a dominant one — e.g.
// "single-failure criterion" living in REGDOC-2.5.2 §7.6.2 even though
// the question headline is about design extension conditions in §7.3.4.
const CONCEPT_EXPANSIONS: Array<{ re: RegExp; seed: string }> = [
	{
		re: /\bsingle[-\s]failure criterion\b/i,
		seed: "single-failure criterion safety groups",
	},
	{
		re: /\bCanada Labour Code\b/i,
		seed: "Canada Labour Code federal acts regulations",
	},
	{
		re: /\bwaste acceptance criteria\b/i,
		seed: "waste acceptance criteria chemical physical radiological",
	},
	{
		// Splits like #25 that ask about federal vs provincial/territorial reach
		// of legislation — the key chunk (REGDOC-2.8.1 §2) talks about
		// "legislative authority over CHS".
		re: /\bfederal[^.]{0,40}provincial|\bfederal acts and regulations\b/i,
		seed: "legislative authority federal provincial territorial applicable legislation",
	},
];

// Build targeted expansion queries for each mentioned doc. Shapes:
//   1. NARROW "<doc> section <N> <context-noun>" per mentioned section —
//      the minimal form plus one concept noun from the user query pulls
//      statutory text (NSCA §48: "Every person commits an offence who…")
//      to rank ~5 whereas the verbose forms push it below 20.
//   2. CONCEPT "<doc> <concept-seed>" — one per matched CONCEPT_EXPANSIONS
//      rule; surfaces deep sections like REGDOC-2.5.2 §7.6.2 that a
//      doc+question expansion alone can't reach.
//   3. BROAD "<doc> <query>" — catches chunks that discuss the topic
//      without matching the section-focused form.
function buildExpansions(
	query: string,
	docs: Set<string>,
	sections: string[],
): string[] {
	if (docs.size === 0) return [];
	const noun = pickContextNoun(query);
	const conceptSeeds = CONCEPT_EXPANSIONS.filter((c) => c.re.test(query)).map(
		(c) => c.seed,
	);
	const out: string[] = [];
	for (const doc of docs) {
		if (sections.length > 0) {
			for (const s of sections) {
				out.push(noun ? `${doc} section ${s} ${noun}` : `${doc} section ${s}`);
			}
		}
		for (const seed of conceptSeeds) out.push(`${doc} ${seed}`);
		out.push(`${doc} ${query}`);
	}
	return out;
}

// ADDITIVE (item-2 PR #8 fix round 2, issue 3 — WALLET): the EXACT list of
// strings retrieveChunks will send to `embeddings.create` for a query — the
// primary query plus every expansion. Pure, offline, network-free, free.
//
// Why this exists. The eval cost accountant cannot observe the dev server's
// internal embedding call, so it used to charge `countTokens(question) *
// EMBED_INPUT_MULTIPLIER` with EMBED_INPUT_MULTIPLIER = 5, documented as
// "1 primary + 4 expansions, above the practical ceiling". It is NOT a ceiling.
// buildExpansions() emits, PER mentioned doc, one NARROW expansion per mentioned
// section + one CONCEPT expansion per matched seed + one BROAD `${doc} ${query}`.
// extractMentionedDocs() can return an unbounded number of docs (every REGDOC the
// query names, plus up to 4 CONCEPT_DOC_HINTS), and each BROAD expansion carries
// the WHOLE query — so a multi-doc question sends far more than 5x the query's
// tokens and the "err-high" factor silently erred LOW on the one spending path
// the eval cannot see. Counting exactly is free, so we count exactly.
//
// retrieveChunks builds its own inputs through this same function, so the eval's
// count and production's call can never drift.
export function embeddingInputsFor(query: string): string[] {
	const docs = extractMentionedDocs(query);
	const sections = extractMentionedSections(query);
	return [query, ...buildExpansions(query, docs, sections)];
}

// Doc-diversity pass: when multiple docs are mentioned, seed the envelope
// with the TOP chunk from each mentioned doc before filling by overall
// score. Without this, a single doc's chunks can sweep the top 8 and the
// LLM ends up citing only that one doc (happens for queries like "apply
// the graded approach to radioactive waste management" where 2.11.1's
// chunks dominate and crowd out REGDOC-3.5.3).
function selectDiverseEnvelope(
	sorted: RetrievedChunk[],
	mustInclude: Set<string>,
	k: number,
): RetrievedChunk[] {
	if (mustInclude.size < 2) return sorted.slice(0, k);
	const out: RetrievedChunk[] = [];
	const seen = new Set<number>();
	for (const doc of mustInclude) {
		const top = sorted.find((c) => c.regdoc_id === doc && !seen.has(c.id));
		if (top) {
			out.push(top);
			seen.add(top.id);
			if (out.length >= k) return out;
		}
	}
	for (const c of sorted) {
		if (seen.has(c.id)) continue;
		out.push(c);
		seen.add(c.id);
		if (out.length >= k) break;
	}
	return out;
}

// Thrown when the embedding call or the primary match RPC fails. Callers
// map `stage` back to their route-specific HTTP error responses so the
// chat route's 500 bodies stay byte-identical to the pre-extraction code.
export class RetrievalError extends Error {
	readonly stage: "embedding" | "match";

	constructor(stage: "embedding" | "match", cause?: unknown) {
		super(`retrieval_failed:${stage}`);
		this.name = "RetrievalError";
		this.stage = stage;
		this.cause = cause;
	}
}

export interface RetrievalDeps {
	supabase: GuardedHandlerArgs["supabase"];
	openai: OpenAI;
	// ADDITIVE (item-2 DELTA D2): OpenAI-call accounting hook. Defaults to
	// recordOpenAICall — the global daily circuit-breaker increment — so both
	// production routes keep byte-identical behavior without passing anything.
	// The RAG eval harness passes an explicit no-op so direct (non-HTTP)
	// retrieval calls never consume the production GLOBAL_DAILY_CAP budget.
	recordUsage?: (costUsd?: number) => Promise<void>;
}

export interface RetrievalOptions {
	// Envelope size is the ONLY caller-tunable knob: chat keeps its
	// calibrated 8 (ENVELOPE_CHUNKS above); the artifact route passes 12
	// because explainers span more sections than chat answers.
	envelopeChunks: number;
	// ADDITIVE (item-2 DELTA D1): when true, the result carries a
	// RetrievalTrace for eval instrumentation. Neither production route sets
	// this, so their behavior and result shape are unchanged.
	withTrace?: boolean;
}

// ADDITIVE (item-2 DELTA D1): one entry per candidate chunk in the merged
// pool, in POST-boost rank order. `similarity` is the raw cosine sim the
// pool was merged on; `score` is what the reranker actually sorted by.
export interface TracePoolEntry {
	chunk: RetrievedChunk;
	similarity: number;
	boosted: boolean;
	score: number;
	rankPreBoost: number;
	rankPostBoost: number;
}

// ADDITIVE (item-2 DELTA D1): everything the eval framework needs to score
// retrieval offline — expansion queries used, the full ranked pool with
// pre/post-boost ranks, and the fallback decision the chat route would take.
// `decision` mirrors the CHAT route's branch order: OOS gate on raw-pool
// top-1, then the disclaimer check on the post-filter envelope average
// (which is structurally >= MIN_CHUNK_SIM in the non-OOS branch — kept for
// fidelity, see poolAvgSim above for the live limited-coverage signal).
export interface RetrievalTrace {
	query: string;
	expansions: string[];
	mentionedDocs: string[];
	mentionedSections: string[];
	topSim: number;
	decision: "oos" | "disclaimer" | "normal";
	pool: TracePoolEntry[];
}

// ADDITIVE (item-2 DELTA D1): replay the route's envelope selection at any k
// from a captured trace — same MIN_CHUNK_SIM filter, same doc-diversity pass,
// same OOS branch (full ranked pool). Lets the eval k-sweep derive envelopes
// for k ∈ {3,5,8,10} from ONE retrieval (one embedding spend), guaranteed
// identical to what retrieveChunks would select at that envelopeChunks.
export function deriveEnvelopeAtK(
	trace: RetrievalTrace,
	k: number,
): RetrievedChunk[] {
	const ranked = trace.pool.map((e) => e.chunk);
	if (trace.topSim < LOW_SIM_OOS) return ranked;
	return selectDiverseEnvelope(
		ranked.filter((c) => c.similarity >= MIN_CHUNK_SIM),
		new Set(trace.mentionedDocs),
		k,
	);
}

export interface RetrievalResult {
	envelope: RetrievedChunk[];
	topSim: number;
	avgSim: number;
	// ADDITIVE (item-2 DELTA D1): present ONLY when opts.withTrace is true.
	trace?: RetrievalTrace;
	// ADDITIVE (PR #6 fix round 1): mean similarity over the FULL ranked
	// candidate pool BEFORE the MIN_CHUNK_SIM filter. In the non-OOS branch
	// the envelope only contains chunks >= MIN_CHUNK_SIM (0.35), so the
	// post-filter `avgSim` can never dip below LOW_SIM_DISCLAIMER (0.35) —
	// a limited-coverage signal must read the raw pool instead. Semantics
	// match the pool the OOS branch already averages (chat's logged
	// full-pool `retrieval_avg_sim` quirk). `avgSim` is untouched: the chat
	// route's disclaimer logic and logging consume it byte-identically.
	poolAvgSim: number;
	mentionedDocs: string[];
}

export async function retrieveChunks(
	query: string,
	deps: RetrievalDeps,
	opts: RetrievalOptions,
): Promise<RetrievalResult> {
	const { supabase, openai } = deps;

	const mentionedDocs = extractMentionedDocs(query);
	const mentionedSections = extractMentionedSections(query);

	// Build the list of embedding inputs. The primary input is always the
	// original user query; additional "doc-focused" inputs are emitted for
	// each mentioned doc so that chunks in heavy-legal or glossary docs
	// (NSCA §48, REGDOC-3.5.3 §5.4) can surface even when they embed
	// weakly against the verbose natural-language question.
	//
	// Routed through embeddingInputsFor() (fix round 2, issue 3) so the eval
	// cost accountant charges the SAME list this call actually sends — one
	// source of truth, no drift, no guessed multiplier.
	const embedInputs = embeddingInputsFor(query);
	const expansions = embedInputs.slice(1);

	let embeddings: number[][];
	try {
		const embResp = await openai.embeddings.create({
			model: OPENAI_MODELS.embedding,
			input: embedInputs,
		});
		embeddings = embResp.data.map((d) => d.embedding);
		if (embeddings.length !== embedInputs.length) {
			throw new Error("embedding count mismatch");
		}
		await (deps.recordUsage ?? recordOpenAICall)(0);
	} catch (err) {
		console.error("embedding_error", err);
		throw new RetrievalError("embedding", err);
	}

	// Primary retrieval: 20 chunks by open cosine sim.
	const { data: primaryMatches, error: rpcErr } = await supabase.rpc(
		"match_regdoc_chunks",
		{
			query_embedding: embeddings[0],
			match_count: MATCH_COUNT,
			min_similarity: 0, // D.3 thresholds applied handler-side; keep RPC permissive
		},
	);
	if (rpcErr) {
		console.error("match_regdoc_chunks_error", rpcErr);
		throw new RetrievalError("match", rpcErr);
	}
	const primaryPool = (primaryMatches ?? []) as RetrievedChunk[];

	// Secondary retrieval: one RPC per mentioned doc, using the expansion
	// embedding. Merged into the pool below. We pull the max allowed (20)
	// because some doc-specific chunks rank at position 12-14 under these
	// narrower queries — NSCA §48 is a known example.
	const expansionPools: RetrievedChunk[][] = [];
	for (let i = 0; i < expansions.length; i++) {
		const { data: expMatches, error: expErr } = await supabase.rpc(
			"match_regdoc_chunks",
			{
				query_embedding: embeddings[i + 1],
				match_count: 20,
				min_similarity: 0,
			},
		);
		if (expErr) {
			console.error("match_regdoc_chunks_expansion_error", expErr);
			continue;
		}
		expansionPools.push((expMatches ?? []) as RetrievedChunk[]);
	}

	// Merge + dedupe by chunk.id, keeping the highest observed similarity.
	const merged = new Map<number, RetrievedChunk>();
	for (const c of [...primaryPool, ...expansionPools.flat()]) {
		const existing = merged.get(c.id);
		if (!existing || c.similarity > existing.similarity) merged.set(c.id, c);
	}
	const rawPool = Array.from(merged.values()).sort(
		(a, b) => b.similarity - a.similarity,
	);

	// Use top-1 from the RAW pool for the D.3 OOS gate so the boost can't
	// paper over a truly unrelated question.
	const topSim = rawPool[0]?.similarity ?? 0;

	// Doc-mention reranker: when the query names specific REGDOCs (or NSCA),
	// promote chunks from those docs by NAMED_DOC_BOOST so they win spots in
	// the envelope even if a generic chunk scores higher on cosine sim. This
	// is the intent signal the user is sending us — treat it as ground truth.
	const ranked = rawPool
		.map((c) => ({
			chunk: c,
			score:
				c.similarity + (mentionedDocs.has(c.regdoc_id) ? NAMED_DOC_BOOST : 0),
		}))
		.sort((a, b) => b.score - a.score)
		.map((r) => r.chunk);

	const chunks =
		topSim < LOW_SIM_OOS
			? ranked
			: selectDiverseEnvelope(
					ranked.filter((c) => c.similarity >= MIN_CHUNK_SIM),
					mentionedDocs,
					opts.envelopeChunks,
				);
	const avgSim =
		chunks.length > 0
			? chunks.reduce((acc, c) => acc + c.similarity, 0) / chunks.length
			: 0;
	// Raw-pool mean (see RetrievalResult.poolAvgSim). `ranked` is the full
	// merged candidate pool — the NAMED_DOC_BOOST only reorders it, so the
	// mean is identical to the pre-boost pool's. In the OOS branch this
	// equals `avgSim` exactly (there `chunks` IS the full pool).
	const poolAvgSim =
		ranked.length > 0
			? ranked.reduce((acc, c) => acc + c.similarity, 0) / ranked.length
			: 0;

	// ADDITIVE (item-2 DELTA D1): trace is built AFTER every production value
	// above so it can never influence them; gated on withTrace so the routes
	// (which never set it) pay nothing.
	let trace: RetrievalTrace | undefined;
	if (opts.withTrace) {
		const preBoostRank = new Map<number, number>(
			rawPool.map((c, i) => [c.id, i + 1]),
		);
		trace = {
			query,
			expansions,
			mentionedDocs: Array.from(mentionedDocs),
			mentionedSections,
			topSim,
			decision:
				topSim < LOW_SIM_OOS
					? "oos"
					: avgSim < LOW_SIM_DISCLAIMER
						? "disclaimer"
						: "normal",
			pool: ranked.map((c, i) => ({
				chunk: c,
				similarity: c.similarity,
				boosted: mentionedDocs.has(c.regdoc_id),
				score:
					c.similarity + (mentionedDocs.has(c.regdoc_id) ? NAMED_DOC_BOOST : 0),
				rankPreBoost: preBoostRank.get(c.id) ?? 0,
				rankPostBoost: i + 1,
			})),
		};
	}

	return {
		envelope: chunks,
		topSim,
		avgSim,
		trace,
		poolAvgSim,
		mentionedDocs: Array.from(mentionedDocs),
	};
}
