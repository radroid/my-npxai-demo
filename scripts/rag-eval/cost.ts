// RAG eval framework — cost accountant (item-2 slice 2.1, R9 / I2.3 / I2.12).
//
// ONE module through which every OpenAI call in the framework flows: judge
// calls, golden/paraphrase generation, relevancy embeddings (actual token
// counts from API `usage` fields) and the server-side answerer + its
// embeddings (ESTIMATED with tiktoken over envelope-sized input + measured
// response text — the SSE stream carries no usage field).
//
// The accountant throws CostCapError the moment actual+estimated total
// reaches the cap; the runner finalizes logs, prints what was spent and why,
// and exits non-zero (Edge case 8).

import { PRICES_USD_PER_MTOK } from "./config";

export type CostKind = "answerer_estimated" | "judge" | "embeddings";

export interface CostEntry {
	kind: CostKind;
	model: string;
	inputTokens: number;
	outputTokens: number;
	usd: number;
	estimated: boolean;
	label?: string;
}

export class CostCapError extends Error {
	readonly totalUsd: number;
	readonly capUsd: number;
	readonly lastEntry: CostEntry;

	constructor(totalUsd: number, capUsd: number, lastEntry: CostEntry) {
		super(
			`EVAL_COST_CAP_USD reached: $${totalUsd.toFixed(4)} >= $${capUsd.toFixed(2)} ` +
				`(last charge: ${lastEntry.kind}/${lastEntry.model} ` +
				`${lastEntry.inputTokens} in + ${lastEntry.outputTokens} out)`,
		);
		this.name = "CostCapError";
		this.totalUsd = totalUsd;
		this.capUsd = capUsd;
		this.lastEntry = lastEntry;
	}
}

export function priceUsd(
	model: string,
	inputTokens: number,
	outputTokens: number,
): number {
	const p = PRICES_USD_PER_MTOK[model];
	if (!p) {
		throw new Error(
			`No price entry for model "${model}" — add it to PRICES_USD_PER_MTOK ` +
				`in scripts/rag-eval/config.ts (with a dated source comment).`,
		);
	}
	return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export class CostAccountant {
	readonly capUsd: number;
	private entries: CostEntry[] = [];

	constructor(capUsd: number) {
		this.capUsd = capUsd;
	}

	/**
	 * Record one OpenAI charge. Throws CostCapError when the running total
	 * reaches the cap — AFTER recording the entry, so the abort report and
	 * the finalized manifest still include the charge that tripped it.
	 */
	record(entry: Omit<CostEntry, "usd">): CostEntry {
		const usd = priceUsd(entry.model, entry.inputTokens, entry.outputTokens);
		const full: CostEntry = { ...entry, usd };
		this.entries.push(full);
		const total = this.totalUsd();
		if (total >= this.capUsd) throw new CostCapError(total, this.capUsd, full);
		return full;
	}

	totalUsd(): number {
		return this.entries.reduce((acc, e) => acc + e.usd, 0);
	}

	totalsByKind(): Record<CostKind, { usd: number; tokens: number }> {
		const out: Record<CostKind, { usd: number; tokens: number }> = {
			answerer_estimated: { usd: 0, tokens: 0 },
			judge: { usd: 0, tokens: 0 },
			embeddings: { usd: 0, tokens: 0 },
		};
		for (const e of this.entries) {
			out[e.kind].usd += e.usd;
			out[e.kind].tokens += e.inputTokens + e.outputTokens;
		}
		return out;
	}

	entryCount(): number {
		return this.entries.length;
	}

	// Three-way split per R9: answerer-estimated / judge / embeddings.
	summaryLines(): string[] {
		const by = this.totalsByKind();
		const fmt = (k: CostKind) =>
			`${by[k].tokens.toLocaleString()} tok  $${by[k].usd.toFixed(4)}`;
		return [
			`answerer (estimated): ${fmt("answerer_estimated")}`,
			`judge      (actual):  ${fmt("judge")}`,
			`embeddings (actual):  ${fmt("embeddings")}`,
			`TOTAL: $${this.totalUsd().toFixed(4)} of $${this.capUsd.toFixed(2)} cap`,
		];
	}

	snapshot(): {
		capUsd: number;
		totalUsd: number;
		byKind: Record<CostKind, { usd: number; tokens: number }>;
	} {
		return {
			capUsd: this.capUsd,
			totalUsd: this.totalUsd(),
			byKind: this.totalsByKind(),
		};
	}
}
