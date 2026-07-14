// Fail-open Redis cache primitives, shared by the knowledge-hub routes.
//
// PRODUCTION INCIDENT (2026-07-14). The Upstash host stopped resolving. The
// chat route's answer-cache READ was the one Redis touch in the request path
// with NO error handling — a bare `await redis.get(...)` — and it runs BEFORE
// retrieval. The rejection escaped into withGuard's handler catch and every
// chat request became a blanket 500 "Something went wrong.". The artifact
// route's read was already wrapped, which is exactly why the two modes failed
// DIFFERENTLY (artifact: "Embedding failed."; chat: a bare 500) — and why a fix
// that only touched the accounting call inside retrieval never even executed on
// the chat path.
//
// A cache is an OPTIMISATION. A dead cache must degrade to a MISS, never to an
// outage. These helpers make fail-open the only available shape and put BOTH
// failure modes inside the same try:
//   1. acquisition — getRedis() itself throws when the env vars are missing
//      (the artifact route called it outside its try, so that path was unguarded
//      there too), and
//   2. the REST call — which rejects when the host is unreachable.
// Every call site passes its own log key, so the logs still name which cache
// broke, and the two routes can no longer drift apart.
//
// "DEGRADES TO A MISS" IS ONLY TRUE IF IT DEGRADES FAST. An earlier version of
// this comment claimed a dead cache is just a miss while the Upstash client was
// still on its default retry policy — 5 retries with exponential backoff, ≈4.3 s
// of sleeping per command. Across the request's several Redis touches that was
// ~20 s of backoff, most of it before the first token: a hang, not a miss. The
// client is now built with a bounded failure budget (lib/guard.ts
// createRedisClient — 1 retry, no backoff, a 1 s per-command abort), so the
// claim above is now literally true.
//
// TRADE-OFF, stated plainly: with Redis down the answer cache is inert. Every
// request re-embeds, re-retrieves and re-generates, so OpenAI spend per request
// goes UP exactly when the spend counter (lib/guard.ts recordOpenAICall) can no
// longer increment. That is why every failure below reports to markRedisFailure()
// — it arms the in-isolate degraded backstop in lib/guard.ts, which caps how
// many of those uncached, uncounted requests can reach OpenAI. Best-effort and
// per-isolate; read DegradedBackstop's contract before trusting it.

import type { Redis } from "@upstash/redis";
import { getRedis, markRedisFailure, markRedisHealthy } from "./guard";

// The slice of the Upstash client these helpers use — and the TEST SEAM.
// Injecting a rejecting client is how the fail-open property is proven with no
// network, and without depending on getRedis()'s memoised singleton (which
// makes any env-var-based failure injection vacuous once something else in the
// process has already built the client).
export type CacheClient = Pick<Redis, "get" | "set" | "del">;

// Cache READ. Returns null on ANY failure — indistinguishable, by design, from
// a genuine miss: the caller then does the real work it would have done anyway.
export async function cacheRead<T>(
	key: string,
	logKey: string,
	client?: CacheClient,
): Promise<T | null> {
	try {
		const redis = client ?? getRedis();
		const hit = (await redis.get<T>(key)) ?? null;
		markRedisHealthy();
		return hit;
	} catch (err) {
		console.error(logKey, err);
		markRedisFailure();
		return null;
	}
}

// Cache WRITE. Never throws: the response it would have cached has already been
// generated and paid for, so a failed write must not fail the user's request.
export async function cacheWrite(
	key: string,
	value: unknown,
	ttlSeconds: number,
	logKey: string,
	client?: CacheClient,
): Promise<void> {
	try {
		const redis = client ?? getRedis();
		await redis.set(key, value, { ex: ttlSeconds });
		markRedisHealthy();
	} catch (err) {
		console.error(logKey, err);
		markRedisFailure();
	}
}

// Cache INVALIDATE. Never throws. A failed delete degrades to "the stale entry
// lives out its TTL", which is strictly better than failing the request.
export async function cacheDelete(
	key: string,
	logKey: string,
	client?: CacheClient,
): Promise<void> {
	try {
		const redis = client ?? getRedis();
		await redis.del(key);
		markRedisHealthy();
	} catch (err) {
		console.error(logKey, err);
		markRedisFailure();
	}
}
