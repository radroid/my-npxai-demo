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
	/** True when the cap tripped on a PRE-call projection (no spend happened). */
	readonly projected: boolean;

	constructor(
		totalUsd: number,
		capUsd: number,
		lastEntry: CostEntry,
		projected = false,
	) {
		super(
			`EVAL_COST_CAP_USD reached: $${totalUsd.toFixed(4)} >= $${capUsd.toFixed(2)} ` +
				`(${projected ? "projected" : "last"} charge: ${lastEntry.kind}/${lastEntry.model} ` +
				`${lastEntry.inputTokens} in + ${lastEntry.outputTokens} out)` +
				(projected ? " — call NOT made, aborted before the spend" : ""),
		);
		this.name = "CostCapError";
		this.totalUsd = totalUsd;
		this.capUsd = capUsd;
		this.lastEntry = lastEntry;
		this.projected = projected;
	}
}

/**
 * Unwrap a CostCapError from whatever wrapped it.
 *
 * PR #8 fix round 1 (issue 4b). `lib/retrieval.ts` catches ANY throw from the
 * embedding call and rethrows it as `RetrievalError("embedding", err)` — which
 * includes OUR OWN cap abort, raised by the metered OpenAI client. A bare
 * `err instanceof CostCapError` check therefore MISSES a cap trip that happened
 * inside retrieval: the runner rethrows, skips its finalize block (no
 * manifest.json, no cost totals), and the operator sees "retrieval_failed:
 * embedding" — which reads like an outage and invites a re-run, i.e. MORE
 * spend. Walking the cause chain makes a cap trip always land in the normal
 * aborted-run finalize path, whatever wrapped it.
 */
export function asCostCapError(err: unknown): CostCapError | null {
	let cur: unknown = err;
	// Bounded walk — a cyclic `cause` chain must not hang the runner.
	for (let depth = 0; cur != null && depth < 8; depth++) {
		if (cur instanceof CostCapError) return cur;
		cur = (cur as { cause?: unknown }).cause;
	}
	return null;
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
	 * PRE-CALL cost-cap check (PR #8 fix round 1, issue 4a). Call this with the
	 * WORST-CASE token projection for a call you are ABOUT to make; it throws
	 * CostCapError before a cent is spent when the projected total would reach
	 * the cap. Nothing is recorded — `record()` still books the actuals after
	 * the call returns.
	 *
	 * `record()` alone is not wallet protection: it pushed the entry and THEN
	 * threw, i.e. it aborted only AFTER the money was gone. Projections here
	 * must ERR HIGH; wallet protection fails safe.
	 */
	reserve(entry: Omit<CostEntry, "usd">): void {
		const usd = priceUsd(entry.model, entry.inputTokens, entry.outputTokens);
		const projected = this.totalUsd() + usd;
		if (projected >= this.capUsd) {
			throw new CostCapError(
				projected,
				this.capUsd,
				{ ...entry, usd },
				/* projected */ true,
			);
		}
	}

	/** Non-throwing form of reserve() — for callers that want to branch. */
	wouldExceed(entry: Omit<CostEntry, "usd">): boolean {
		const usd = priceUsd(entry.model, entry.inputTokens, entry.outputTokens);
		return this.totalUsd() + usd >= this.capUsd;
	}

	/**
	 * Record one OpenAI charge. Throws CostCapError when the running total
	 * reaches the cap — AFTER recording the entry, so the abort report and
	 * the finalized manifest still include the charge that tripped it. This is
	 * the ACTUALS ledger and the last line of defense; the pre-spend guard is
	 * reserve() at each call site.
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
