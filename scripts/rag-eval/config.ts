// RAG eval framework — shared config (item-2 slice 2.1, R9/R11).
//
// All env vars reuse the repo's existing loading pattern: Bun auto-loads
// `.env.local` from the repo root, no dotenv plumbing (I2.5).
//
//   EVAL_JUDGE_MODEL   judge model id (default gpt-4o — one tier above the
//                      gpt-4o-mini answerer, per research doc §Judge design)
//   EVAL_COST_CAP_USD  hard per-run budget guard (default 2 — I2.3/DELTA D3;
//                      the orchestrator authorized 4 for the slice-2.2
//                      gpt-4o-judge baseline run only)
//   EVAL_BASE_URL      dev-server origin (default http://localhost:3001,
//                      matching scripts/eval-kb.ts)
//   EVAL_BYPASS_KEY    rate-limit/circuit-breaker bypass header value
//                      (lib/guard.ts) — required for server experiments

import { EMBEDDING_DIMENSIONS, OPENAI_MODELS } from "../../lib/openai";

export const ANSWERER_MODEL = "gpt-4o-mini"; // lib/openai.ts OPENAI_MODELS.chat
// Mirror lib/openai.ts so the eval framework embeds in the SAME space as
// production retrieval — model AND dimensions (text-embedding-3-large @ 3072).
export const EMBEDDING_MODEL = OPENAI_MODELS.embedding;
export { EMBEDDING_DIMENSIONS };
export const DEFAULT_JUDGE_MODEL = "gpt-4o";

export function judgeModel(): string {
	return process.env.EVAL_JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
}

export function costCapUsd(): number {
	const raw = Number(process.env.EVAL_COST_CAP_USD);
	return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

export function baseUrl(): string {
	return process.env.EVAL_BASE_URL ?? "http://localhost:3001";
}

// USD per MILLION tokens. Source: https://platform.openai.com/pricing,
// retrieved 2026-07-14. Update the date when you touch a number.
export const PRICES_USD_PER_MTOK: Record<
	string,
	{ input: number; output: number }
> = {
	"gpt-4o": { input: 2.5, output: 10 },
	"gpt-4o-mini": { input: 0.15, output: 0.6 },
	"text-embedding-3-small": { input: 0.02, output: 0 },
	"text-embedding-3-large": { input: 0.13, output: 0 },
};

// Committed datasets (I2.6 — same evals/ convention as knowledge-hub.jsonl).
export const GOLDEN_PATH = "evals/rag-golden.jsonl";
export const OOC_PROBES_PATH = "evals/rag-ooc-probes.jsonl";
export const PARAPHRASES_PATH = "evals/rag-paraphrases.jsonl";

// Gitignored artifacts (I2.2 logs live under evals/results/, judge cache
// under evals/.judge-cache/ — R11 wires both into .gitignore).
export const RESULTS_DIR = "evals/results";
export const JUDGE_CACHE_DIR = "evals/.judge-cache";

// k values for the retrieval sweep (all <= the RPC's hard cap of 20).
export const K_SWEEP = [3, 5, 8, 10] as const;
export const PRODUCTION_K = 8; // ENVELOPE_CHUNKS in lib/retrieval.ts
export const CONSISTENCY_REPEATS = 5;
