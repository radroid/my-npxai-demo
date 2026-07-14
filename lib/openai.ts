import OpenAI from "openai";

let client: OpenAI | undefined;

export function getOpenAIClient() {
	if (client) return client;
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error("OPENAI_API_KEY must be set");
	client = new OpenAI({ apiKey });
	return client;
}

export const OPENAI_MODELS = {
	chat: "gpt-4o-mini",
	embedding: "text-embedding-3-large",
} as const;

// Artifact explainer model (DELTA D1): overridable per-deploy via env so a
// stronger model can be swapped in without a code change (`wrangler`-managed
// in production). Resolved lazily so the env var is read at request time,
// consistent with getOpenAIClient above. Both routes share the one client.
export function getArtifactModel(): string {
	return process.env.OPENAI_ARTIFACT_MODEL || OPENAI_MODELS.chat;
}

// Full-dimension text-embedding-3-large. The 3072-dim vectors measurably beat
// -small@1536 on the golden set (brute-force cosine: hit@8 92.4%→96.7%,
// recall@8 79.2%→85.8%, MRR 0.782→0.816). Matryoshka-truncating -large back to
// 1536 dims erased most of that gain, so we store AND query at the FULL 3072
// dims. Every openai.embeddings.create call MUST pass
// `dimensions: EMBEDDING_DIMENSIONS` — corpus and query embeddings landing in
// different-width spaces would silently break retrieval. pgvector caps
// HNSW/IVFFlat on the `vector` type at 2000 dims, so the corpus column is
// `halfvec(3072)` indexed with `halfvec_cosine_ops` (HNSW supports halfvec to
// 4000 dims at half the storage).
export const EMBEDDING_DIMENSIONS = 3072;
