// RAG eval framework — production daily-cap headroom (item-2, Edge case 2).
//
// TWO different budgets, easy to confuse:
//
//   1. EVAL_COST_CAP_USD  — this framework's OWN wallet guard (cost.ts). Hard
//      abort. Protects Raj's out-of-pocket spend.
//   2. GLOBAL_DAILY_CAP=2000 (lib/guard.ts) — the PRODUCTION circuit breaker,
//      an OpenAI-call counter in Redis that real users share. `x-eval-bypass`
//      skips the CHECK, but a bypassed request still INCREMENTS the counter
//      (recordOpenAICall), so a full battery burns ~500 of it.
//
// DELTA D2 keeps the two apart on the retrieval side: eval-path calls to
// lib/retrieval's retrieveChunks pass a no-op `recordUsage`, so offline
// retrieval (the k-sweep) never touches the production counter. Answers that go
// through the dev server DO increment it — unavoidable, that IS the production
// path — so the runner reads the counter and prints the headroom impact after
// every server-backed run, and the report notes that real users share it.
//
// Read-only: this module never writes to Redis.

import { Redis } from "@upstash/redis";

/** Mirrors lib/guard.ts GLOBAL_DAILY_CAP. */
export const GLOBAL_DAILY_CAP = 2000;

export interface Headroom {
	available: boolean;
	callsToday: number;
	cap: number;
	remaining: number;
	reason?: string;
}

export async function readHeadroom(): Promise<Headroom> {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		return {
			available: false,
			callsToday: 0,
			cap: GLOBAL_DAILY_CAP,
			remaining: GLOBAL_DAILY_CAP,
			reason: "UPSTASH_REDIS_REST_URL / _TOKEN not set",
		};
	}
	try {
		const redis = new Redis({ url, token });
		const key = `openai:calls:${new Date().toISOString().slice(0, 10)}`;
		const calls = Number((await redis.get<number>(key)) ?? 0);
		return {
			available: true,
			callsToday: calls,
			cap: GLOBAL_DAILY_CAP,
			remaining: Math.max(0, GLOBAL_DAILY_CAP - calls),
		};
	} catch (err) {
		return {
			available: false,
			callsToday: 0,
			cap: GLOBAL_DAILY_CAP,
			remaining: GLOBAL_DAILY_CAP,
			reason: (err as Error).message,
		};
	}
}

export function headroomLine(h: Headroom): string {
	if (!h.available) {
		return `production daily OpenAI counter: unavailable (${h.reason}) — headroom unknown`;
	}
	return (
		`production daily OpenAI counter: ${h.callsToday}/${h.cap} used, ` +
		`${h.remaining} left today (real users share this budget; lib/guard.ts)`
	);
}

// ---------------------------------------------------------------------------
// PREFLIGHT projection (PR #8 fix round 1, issue 5).
//
// The framework knew a battery burns ~500 of the shared 2000-call budget, but
// only called readHeadroom() in FINALIZE — i.e. it reported the damage after
// doing it. A run that starts with insufficient headroom can circuit-break
// PRODUCTION for real users. The runner now projects the spend and ABORTS
// before the first request.

/**
 * OpenAI calls the production route books per server request: one for the
 * retrieval embedding (lib/retrieval.ts) and one for the chat completion
 * (route.ts) — both go through recordOpenAICall, and `x-eval-bypass` skips the
 * CHECK, not the INCREMENT. Guard/OOS refusals book fewer, so 2 errs high.
 */
export const DAILY_CAP_CALLS_PER_REQUEST = 2;

export function projectDailyCapCalls(serverRequests: number): number {
	return serverRequests * DAILY_CAP_CALLS_PER_REQUEST;
}

/**
 * Must this run be refused? True only when the counter is READABLE and the
 * remaining headroom cannot absorb the projection. An unreadable counter warns
 * loudly but does not block — we cannot prove a breach, and blocking every run
 * on a Redis outage would be its own failure mode.
 */
export function headroomBlocksRun(h: Headroom, projectedCalls: number): boolean {
	return h.available && h.remaining < projectedCalls;
}
