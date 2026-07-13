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
	embedding: "text-embedding-3-small",
} as const;

// Artifact explainer model (DELTA D1): overridable per-deploy via env so a
// stronger model can be swapped in without a code change (`wrangler`-managed
// in production). Resolved lazily so the env var is read at request time,
// consistent with getOpenAIClient above. Both routes share the one client.
export function getArtifactModel(): string {
	return process.env.OPENAI_ARTIFACT_MODEL || OPENAI_MODELS.chat;
}

export const EMBEDDING_DIMENSIONS = 1536;
