// Corpus embedding for the offline ingestion scripts. Same model and width as
// the query path (lib/retrieval.ts) — corpus and query vectors must share a
// space or cosine search is meaningless.

import type OpenAI from "openai";
import { EMBEDDING_DIMENSIONS, OPENAI_MODELS } from "../../lib/openai";

export const EMBEDDING_MODEL = OPENAI_MODELS.embedding;
export const EMBED_BATCH_SIZE = 100;

export async function embedBatch(
	client: OpenAI,
	texts: string[],
): Promise<number[][]> {
	let attempt = 0;
	let delay = 1000;
	const maxAttempts = 5;
	while (true) {
		try {
			const resp = await client.embeddings.create({
				model: EMBEDDING_MODEL,
				input: texts,
				dimensions: EMBEDDING_DIMENSIONS,
			});
			const out = resp.data.map((d) => d.embedding);
			if (
				out.length !== texts.length ||
				out.some((v) => v.length !== EMBEDDING_DIMENSIONS)
			) {
				throw new Error("embedding response shape mismatch");
			}
			return out;
		} catch (err) {
			attempt++;
			const msg = err instanceof Error ? err.message : String(err);
			if (attempt >= maxAttempts)
				throw new Error(`embedBatch exhausted retries: ${msg}`);
			console.warn(`  embed retry ${attempt}/${maxAttempts - 1} after: ${msg}`);
			await new Promise((r) => setTimeout(r, delay));
			delay = Math.min(delay * 2, 32000);
		}
	}
}

/** Loopback only — anything else is treated as the hosted demo. */
export function isLocalSupabaseUrl(url: string): boolean {
	try {
		const { hostname } = new URL(url);
		return (
			hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
		);
	} catch {
		return false;
	}
}
