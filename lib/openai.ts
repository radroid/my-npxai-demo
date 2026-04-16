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

export const EMBEDDING_DIMENSIONS = 1536;
