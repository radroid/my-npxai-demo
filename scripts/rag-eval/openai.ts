// RAG eval framework — metered OpenAI access (item-2 slice 2.1, R9 / I2.12).
//
// EVERY OpenAI call the framework makes goes through this module so the cost
// accountant sees it:
//   - chatJson()      judge + generator completions (actual `usage` tokens)
//   - embedTexts()    relevancy embeddings (actual `usage` tokens)
//   - meteredOpenAI() a Proxy for the client handed to lib/retrieval's
//                     retrieveChunks, which embeds internally — the proxy
//                     records that call's real usage without retrieval.ts
//                     needing to know the accountant exists.
//
// The server-side answerer is NOT callable from here (it runs inside the dev
// server); its tokens are ESTIMATED with tiktoken in answer.ts.

import OpenAI from "openai";
import { EMBEDDING_MODEL } from "./config";
import type { CostAccountant, CostKind } from "./cost";

export function getEvalOpenAI(): OpenAI {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error("OPENAI_API_KEY must be set (see .env.local)");
	return new OpenAI({ apiKey });
}

/**
 * Wrap an OpenAI client so `embeddings.create` charges the accountant with the
 * response's ACTUAL usage. Used for the client passed into retrieveChunks():
 * the eval path drives production retrieval code, so its embedding spend must
 * be metered even though retrieval.ts has no cost plumbing (and must not grow
 * any — the routes share that file).
 */
export function meteredOpenAI(
	client: OpenAI,
	cost: CostAccountant,
	label: string,
	kind: CostKind = "embeddings",
): OpenAI {
	const embeddings = {
		...client.embeddings,
		create: async (
			body: OpenAI.Embeddings.EmbeddingCreateParams,
			opts?: OpenAI.RequestOptions,
		) => {
			const resp = await client.embeddings.create(body, opts);
			cost.record({
				kind,
				model: String(body.model),
				inputTokens: resp.usage?.prompt_tokens ?? 0,
				outputTokens: 0,
				estimated: false,
				label,
			});
			return resp;
		},
	};
	return new Proxy(client, {
		get(target, prop, receiver) {
			if (prop === "embeddings") return embeddings;
			return Reflect.get(target, prop, receiver);
		},
	}) as OpenAI;
}

/** Embed texts with the production embedding model; charges `embeddings`. */
export async function embedTexts(
	client: OpenAI,
	cost: CostAccountant,
	texts: string[],
	label: string,
): Promise<number[][]> {
	if (texts.length === 0) return [];
	const resp = await client.embeddings.create({
		model: EMBEDDING_MODEL,
		input: texts,
	});
	cost.record({
		kind: "embeddings",
		model: EMBEDDING_MODEL,
		inputTokens: resp.usage?.prompt_tokens ?? 0,
		outputTokens: 0,
		estimated: false,
		label,
	});
	return resp.data.map((d) => d.embedding);
}

export interface ChatResult {
	text: string;
	inputTokens: number;
	outputTokens: number;
}

/**
 * One judge-tier chat completion at temperature 0 with JSON output
 * (research doc §Judge design). Charges `judge` with actual usage.
 */
export async function chatJson(
	client: OpenAI,
	cost: CostAccountant,
	model: string,
	system: string,
	user: string,
	label: string,
): Promise<ChatResult> {
	const resp = await client.chat.completions.create({
		model,
		temperature: 0,
		response_format: { type: "json_object" },
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
	});
	const text = resp.choices[0]?.message?.content ?? "";
	cost.record({
		kind: "judge",
		model,
		inputTokens: resp.usage?.prompt_tokens ?? 0,
		outputTokens: resp.usage?.completion_tokens ?? 0,
		estimated: false,
		label,
	});
	return {
		text,
		inputTokens: resp.usage?.prompt_tokens ?? 0,
		outputTokens: resp.usage?.completion_tokens ?? 0,
	};
}
