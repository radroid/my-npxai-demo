// Request guard: tier-aware rate limits (Appendix B.1 + J.5) + global daily
// OpenAI circuit breaker (B.4). Every public API route wraps with `withGuard()`.

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { hashIp, hashUser, logGuardEvent, logRequest } from "./logger";
import { createSupabaseServerClient } from "./supabase";
import { OUTPUT_MAX_TOKENS, QUERY_CHAR_CAP, type Tier } from "./validators";

const GLOBAL_DAILY_CAP = 2000;

type Window = "1 m" | "1 h" | "24 h";
const WINDOWS = [
	["minute", "1 m"],
	["hour", "1 h"],
	["day", "24 h"],
] as const;

const RETRY_AFTER_SECONDS: Record<Window, number> = {
	"1 m": 60,
	"1 h": 60 * 60,
	"24 h": 60 * 60 * 24,
};

const LIMITS: Record<
	string,
	Record<Tier, { minute: number; hour: number; day: number }>
> = {
	"knowledge-hub/query": {
		// day caps the 24h window; minute + hour are spike-protection inside
		// that window. Keep hour <= day so the hour bucket can actually fire
		// (previous hour: 10 with day: 5 was dead code).
		anon: { minute: 3, hour: 5, day: 5 },
		signed_in: { minute: 10, hour: 40, day: 50 },
		npx_circle: { minute: 15, hour: 80, day: 200 },
	},
	"knowledge-hub/artifact": {
		// Per-artifact cost is ~4× a chat answer (ARTIFACT_MAX_TOKENS=3000 vs
		// the anon chat cap of 800), so every tier/window here is strictly
		// tighter than knowledge-hub/query's (invariant I1.9). Anon matches
		// the generator's anon posture.
		anon: { minute: 1, hour: 2, day: 2 },
		signed_in: { minute: 2, hour: 6, day: 10 },
		npx_circle: { minute: 3, hour: 12, day: 30 },
	},
	"generator/turnover": {
		anon: { minute: 1, hour: 3, day: 2 },
		signed_in: { minute: 3, hour: 12, day: 20 },
		npx_circle: { minute: 5, hour: 20, day: 40 },
	},
	"threads/title": {
		// Auto-title is a single 20-token gpt-4o-mini call fired once per
		// thread's first user+assistant pair. Its cost is negligible compared
		// to the main query path — the limiter exists only to stop pathological
		// loops, not to ration titles. Bumped well above any realistic ceiling
		// so organic thread creation never runs out of titles.
		anon: { minute: 10, hour: 60, day: 100 },
		signed_in: { minute: 20, hour: 200, day: 1000 },
		npx_circle: { minute: 30, hour: 400, day: 2000 },
	},
};

// ── BOUNDED FAILURE BUDGET (PR #11 round 2, B6) ─────────────────────────────
//
// Fail-open is only worth anything if failing is FAST. @upstash/redis defaults
// to 5 retries with exponential backoff (`Math.exp(i) * 50` ms → 50+136+369+
// 1004+2730 ≈ 4.3 s of sleeping, 6 fetch attempts, PER COMMAND). A request
// touches Redis up to five times (three limiter windows, the breaker read, the
// answer-cache read, the cache write, the spend counter), so a dead Upstash
// stacked to ~20 s of pure backoff and ~30 wasted Cloudflare subrequests —
// most of it BEFORE the first token. That is not "degrades to a MISS", that is
// a platform timeout or an abandoned request.
//
// Two bounds, both applied where the client is built so EVERY caller inherits
// them (the Ratelimit instances below are constructed on top of this client):
//   • retries: 1 with zero backoff → at most 2 fetch attempts per command.
//   • a fresh AbortSignal.timeout per command. The SDK resolves a function
//     `signal` ONCE per command and reuses it across that command's retries, so
//     this bounds the WHOLE command — retries included — not each attempt.
//
// 1000 ms, not 500: Upstash REST p99 from the same region is comfortably under
// 100 ms, so 1 s is ~10× headroom. Cutting healthy-but-slow calls short would
// push us into degraded mode (below) and BLIND the spend counter for no reason
// — the failure we are bounding here is a dead host, and a dead host fails in
// milliseconds anyway. Worst case for a total outage is now ~5 s of added
// latency across the whole request instead of ~20 s.
const REDIS_MAX_RETRIES = 1;
const REDIS_COMMAND_TIMEOUT_MS = 1000;

// Exported as a factory, not just a memoised getter, because getRedis()
// MEMOISES: once anything in the process has built a client, no env swap can
// inject a differently-configured one, and a test that relies on that is
// vacuous. Tests build their own client from this and assert the budget really
// is bounded.
export function createRedisClient(url: string, token: string): Redis {
	return new Redis({
		url,
		token,
		retry: { retries: REDIS_MAX_RETRIES, backoff: () => 0 },
		signal: () => AbortSignal.timeout(REDIS_COMMAND_TIMEOUT_MS),
	});
}

let redisSingleton: Redis | undefined;
export function getRedis(): Redis {
	if (redisSingleton) return redisSingleton;
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		throw new Error(
			"UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set",
		);
	}
	redisSingleton = createRedisClient(url, token);
	return redisSingleton;
}

// ── REDIS HEALTH ────────────────────────────────────────────────────────────
//
// Every Redis touch in this app now reports its outcome here. The signal is
// "what did the LAST Redis call in this isolate do", not a rolling average: a
// single success clears it, and withGuard probes Redis (the rate limiter) on
// every single request, so a false "degraded" cannot outlive one request.
let redisDegraded = false;

export function markRedisFailure(): void {
	redisDegraded = true;
}
export function markRedisHealthy(): void {
	redisDegraded = false;
}
export function isRedisDegraded(): boolean {
	return redisDegraded;
}

// ── DEGRADED-MODE BACKSTOP (PR #11 round 2, B5) ─────────────────────────────
//
// THE HOLE THIS PLUGS. Every cost control in this app rides on ONE dependency:
// Upstash. The per-tier rate limiter, the GLOBAL_DAILY_CAP circuit breaker, the
// spend counter (recordOpenAICall) and the answer cache (lib/cache.ts) are all
// Redis, and they all fail OPEN. Fail-open is right for availability — a dead
// cache must not be an outage — and ruinous for the wallet if nothing takes
// over: with Upstash unreachable, the limiter enforces nothing, the breaker can
// never trip because it cannot count, the cache never hits so every repeat of
// the same question re-pays, and the spend counter records none of it. Net:
// every request from every anonymous IP reaches OpenAI, unlimited, uncached and
// uncounted, at a volume the caller picks. Raj funds this demo out of pocket.
//
// THE BACKSTOP. When — and ONLY when — a Redis-backed control could not be
// read, an in-isolate limiter takes over on a deliberately small budget. Under
// the cap a casual visitor still gets a working demo; over it they get the same
// friendly 429 the circuit breaker already returns. Never a 5xx, and never a
// silent free ride to OpenAI.
//
// WHAT THIS IS NOT — read before trusting it. Cloudflare Workers runs many
// short-lived isolates. This counter lives in ONE of them and dies with it, so
// N live isolates can admit up to N × the cap and a cold isolate starts at
// zero. It is BEST-EFFORT and PER-ISOLATE, not a global guarantee. It converts
// "unbounded" into "bounded per isolate" — strictly better than nothing,
// strictly worse than a working global counter. The fix for a Redis outage is
// to restore Redis; this only stops the bleeding meanwhile.
//
// THE CAPS. A worst-case anon answer is ~6k input + 800 output tokens on
// gpt-4o-mini (OUTPUT_MAX_TOKENS.anon), i.e. ≈ $0.0015. 25 admissions per
// isolate-hour therefore bounds degraded spend at roughly $0.04 per
// isolate-hour — pennies even across a handful of live isolates — while 3 per
// identifier still lets a visitor ask a few questions and see the demo work.
const DEGRADED_WINDOW_MS = 60 * 60 * 1000;
const DEGRADED_IDENTIFIER_CAP = 3;
const DEGRADED_ISOLATE_CAP = 25;

export interface DegradedDecision {
	allowed: boolean;
	scope?: "identifier" | "isolate";
	retryAfterSeconds: number;
}

class DegradedBackstop {
	// Timestamps of ADMITTED requests only. Denials are not recorded, so the map
	// cannot be grown by a caller rotating identifiers: admissions are themselves
	// capped at DEGRADED_ISOLATE_CAP per window, so it holds ≤ 25 keys.
	private byIdentifier = new Map<string, number[]>();
	private isolate: number[] = [];

	check(key: string, now: number = Date.now()): DegradedDecision {
		const cutoff = now - DEGRADED_WINDOW_MS;
		this.isolate = this.isolate.filter((t) => t > cutoff);
		for (const [k, times] of this.byIdentifier) {
			const live = times.filter((t) => t > cutoff);
			if (live.length === 0) this.byIdentifier.delete(k);
			else this.byIdentifier.set(k, live);
		}

		const retryAfter = (times: number[]): number =>
			Math.max(1, Math.ceil((times[0] + DEGRADED_WINDOW_MS - now) / 1000));

		if (this.isolate.length >= DEGRADED_ISOLATE_CAP) {
			return {
				allowed: false,
				scope: "isolate",
				retryAfterSeconds: retryAfter(this.isolate),
			};
		}
		const mine = this.byIdentifier.get(key) ?? [];
		if (mine.length >= DEGRADED_IDENTIFIER_CAP) {
			return {
				allowed: false,
				scope: "identifier",
				retryAfterSeconds: retryAfter(mine),
			};
		}

		mine.push(now);
		this.byIdentifier.set(key, mine);
		this.isolate.push(now);
		return { allowed: true, retryAfterSeconds: 0 };
	}

	// Admissions currently charged against the isolate budget. Used by tests to
	// prove the backstop does NOT engage while Redis is healthy.
	admitted(): number {
		return this.isolate.length;
	}

	reset(): void {
		this.byIdentifier.clear();
		this.isolate = [];
	}
}

export const degradedBackstop = new DegradedBackstop();

// Cache keyed by prefix + window + limit value. The limit has to be part of
// the key: if you tighten e.g. hour 10 → 5, the cached Ratelimit instance
// built with limit=10 would keep approving requests up to 10 until the
// process restarts. Including the limit in the key means a config edit
// invalidates the stale instance on the next request. The Redis bucket
// prefix uses only prefix+window (unchanged) so the server-side counter
// itself is continuous across limit edits — only the per-request math
// picks up the new ceiling.
const limiterCache = new Map<string, Ratelimit>();
function getLimiter(
	prefix: string,
	limit: number,
	window: Window,
	redis?: Redis,
): Ratelimit {
	const build = (client: Redis) =>
		new Ratelimit({
			redis: client,
			limiter: Ratelimit.slidingWindow(limit, window),
			prefix: `${prefix}:${window}`,
			analytics: false,
		});
	// An INJECTED client (tests only) must never be memoised into — or served
	// from — the process-wide cache, or a test's fake Redis would leak into
	// production limiters and vice versa.
	if (redis) return build(redis);
	const cacheKey = `${prefix}:${window}:${limit}`;
	const cached = limiterCache.get(cacheKey);
	if (cached) return cached;
	const rl = build(getRedis());
	limiterCache.set(cacheKey, rl);
	return rl;
}

function resolveClientIp(req: NextRequest): string {
	const cf = req.headers.get("cf-connecting-ip");
	if (cf) return cf;
	const first = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
	return first || "unknown";
}

export interface GuardContext {
	tier: Tier;
	userId?: string;
	userHash?: string;
	ipHash: string;
	identifier: string; // rate-limit bucket identifier
	rateLimitRemaining: number;
	inputCharCap: number;
	outputMaxTokens: number;
	// Handler attaches route-specific fields (prompt_version, retrieval_*, etc.)
	// so the post-handler logRequest() emits a single rich line per Appendix H.6.
	logFields: Record<string, unknown>;
}

export interface GuardedHandlerArgs {
	req: NextRequest;
	ctx: GuardContext;
	supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
}

export type GuardedHandler = (args: GuardedHandlerArgs) => Promise<Response>;

export interface WithGuardOptions {
	route: keyof typeof LIMITS;
}

// TEST SEAM — never passed by any route (all four call `withGuard(opts, handler)`).
//
// It exists because the two things this guard is MADE of cannot be reached from
// an offline harness otherwise:
//   • `redis` — the limiter + breaker client. getRedis() memoises, so pointing
//     UPSTASH_REDIS_REST_URL at a dead host injects no failure once anything in
//     the process has built a client. Injecting a client that REJECTS is the
//     only faithful way to reproduce "Upstash is unreachable" with no network,
//     and it is injected at the CLIENT boundary — the real @upstash/ratelimit
//     sliding-window code still runs on top of it.
//   • `createSupabase` — withGuard's first act is to build a Supabase server
//     client, which needs next/headers' request scope. Outside a Next request
//     there is none, so the guard could not be invoked at all.
export interface GuardDeps {
	redis?: Redis;
	createSupabase?: () => Promise<
		Awaited<ReturnType<typeof createSupabaseServerClient>>
	>;
}

export function withGuard(
	opts: WithGuardOptions,
	handler: GuardedHandler,
	deps: GuardDeps = {},
): (req: NextRequest) => Promise<Response> {
	return async (req: NextRequest) => {
		const start = Date.now();
		const supabase = await (
			deps.createSupabase ?? createSupabaseServerClient
		)();

		// Resolve tier
		const {
			data: { user },
		} = await supabase.auth.getUser();

		let tier: Tier = "anon";
		let userId: string | undefined;
		let userHash: string | undefined;
		if (user) {
			userId = user.id;
			const { data: tierRow } = await supabase.rpc("get_user_tier", {
				p_user_id: user.id,
			});
			tier = tierRow === "npx_circle" ? "npx_circle" : "signed_in";
			userHash = await hashUser(user.id);
		}

		const ipHash = await hashIp(resolveClientIp(req));
		const identifier = user ? `user:${user.id}:${tier}` : `anon:${ipHash}`;

		// Eval-only bypass: if EVAL_BYPASS_KEY is set server-side and the
		// x-eval-bypass request header matches, skip rate limit + circuit
		// breaker so the 20-question battery can run in one shot. Opt-in only
		// — unset the env var in production so bypass is impossible.
		const bypassKey = process.env.EVAL_BYPASS_KEY;
		const bypassed =
			Boolean(bypassKey) && req.headers.get("x-eval-bypass") === bypassKey;

		// Rate limits (per-minute / per-hour / per-day) — check cheapest first.
		// Upstash being unreachable (network blip, missing env, account paused)
		// must NOT take the whole worker down — that's how this surfaced as a
		// page-wide 503 in production. Fail-open with a logged warning: the
		// demo stays usable, we just stop enforcing limits until Upstash is
		// back.
		//
		// Fail-open here means NOTHING is enforced (`remaining` stays +Infinity),
		// and the circuit breaker below cannot save us either — it reads the same
		// dead Redis. That is why a failure on this path arms the in-isolate
		// degraded backstop further down: SOMETHING has to bound the spend.
		const guardBase = {
			route: opts.route,
			ip_hash: ipHash,
			tier,
			user_hash: userHash,
		};
		const limits = LIMITS[opts.route][tier];
		const prefix = `rl:${opts.route}`;
		let remaining = Number.POSITIVE_INFINITY;
		for (const [key, window] of WINDOWS) {
			if (bypassed) break;
			try {
				const rl = getLimiter(prefix, limits[key], window, deps.redis);
				const result = await rl.limit(identifier);
				markRedisHealthy();
				if (result.remaining < remaining) remaining = result.remaining;
				if (!result.success) {
					logGuardEvent({ ...guardBase, reason: "rate_limit", detail: window });
					return NextResponse.json(
						{
							error: "rate_limited",
							message:
								tier === "anon"
									? "Anon daily quota reached. Sign in to unlock a higher tier."
									: "You've hit your daily quota. Try again tomorrow.",
							window,
							// Include the server-resolved tier so the client can detect a
							// stale-cookie mismatch (UI thinks signed_in, server sees anon)
							// and kick a refresh + retry before surfacing this to the user.
							tier,
						},
						{
							status: 429,
							headers: {
								"X-Ratelimit-Tier": tier,
								"Retry-After": String(RETRY_AFTER_SECONDS[window]),
								// Don't let any client (Arc's link-preview / page-prefetch
								// is the known offender) latch onto a transient error
								// response. Browsers shouldn't cache non-cacheable status
								// codes per spec, but a few do under specific UI flows.
								"Cache-Control": "no-store",
							},
						},
					);
				}
			} catch (err) {
				console.error("rate_limit_unavailable", { window, err });
				markRedisFailure();
				logGuardEvent({
					...guardBase,
					reason: "rate_limit_degraded",
					detail: window,
				});
				// Break so we don't keep retrying every window in the same request.
				break;
			}
		}

		// Global daily circuit breaker (skipped when bypassed).
		// Same fail-open posture as the per-tier limits: a Redis hiccup here
		// previously crashed the route and surfaced as 5xx on every call. Note
		// what fail-open costs here: currentCalls stays 0, so GLOBAL_DAILY_CAP can
		// never trip. The backstop below is what stands in for it.
		let currentCalls = 0;
		if (!bypassed) {
			try {
				const dayKey = `openai:calls:${new Date().toISOString().slice(0, 10)}`;
				const client = deps.redis ?? getRedis();
				currentCalls = Number((await client.get<number>(dayKey)) ?? 0);
				markRedisHealthy();
			} catch (err) {
				console.error("circuit_breaker_unavailable", err);
				markRedisFailure();
			}
		}

		// DEGRADED-MODE BACKSTOP (B5). Reached only when a Redis-backed control
		// above could not be read — i.e. exactly when the rate limiter enforces
		// nothing, the breaker cannot count, the answer cache is inert and the
		// spend counter is blind. In that state an in-isolate budget takes over.
		// Per-isolate and best-effort; see the contract at DegradedBackstop.
		if (!bypassed && isRedisDegraded()) {
			const decision = degradedBackstop.check(`${opts.route}|${identifier}`);
			if (!decision.allowed) {
				logGuardEvent({
					...guardBase,
					reason: "degraded_backstop",
					detail: decision.scope,
				});
				// The SAME friendly 429 the circuit breaker returns — a spent quota
				// is not a server fault, and a 5xx here would hand Arc / link
				// previewers / CDNs a full-page "Loading Error" instead of JSON.
				return NextResponse.json(
					{
						error: "demo_rate_limit",
						message:
							"This live demo's rate limiter is temporarily unavailable, so it's running on a reduced safety budget. Please try again shortly, or reach out to Raj directly.",
					},
					{
						status: 429,
						headers: {
							"Retry-After": String(decision.retryAfterSeconds),
							"Cache-Control": "no-store",
						},
					},
				);
			}
		}

		if (currentCalls >= GLOBAL_DAILY_CAP) {
			logGuardEvent({ ...guardBase, reason: "circuit_breaker" });
			// 429, not 503: the *service* is up — this specific quota is spent.
			// 503 caused Arc / link previewers / CDNs to render a full-page
			// "Loading Error" instead of letting the client parse the JSON.
			return NextResponse.json(
				{
					error: "demo_rate_limit",
					message:
						"This live demo has hit its daily request cap. Please try again tomorrow or reach out to Raj directly.",
				},
				{
					status: 429,
					headers: {
						"Retry-After": String(RETRY_AFTER_SECONDS["24 h"]),
						"Cache-Control": "no-store",
					},
				},
			);
		}

		const ctx: GuardContext = {
			tier,
			userId,
			userHash,
			ipHash,
			identifier,
			rateLimitRemaining: Number.isFinite(remaining) ? remaining : 0,
			inputCharCap: QUERY_CHAR_CAP[tier],
			outputMaxTokens: OUTPUT_MAX_TOKENS[tier],
			logFields: {},
		};

		let response: Response;
		try {
			response = await handler({ req, ctx, supabase });
		} catch (err) {
			console.error("handler_error", err);
			response = NextResponse.json(
				{ error: "internal_error", message: "Something went wrong." },
				{ status: 500, headers: { "Cache-Control": "no-store" } },
			);
		}

		logRequest({
			route: opts.route,
			status: response.status,
			ms: Date.now() - start,
			ip_hash: ipHash,
			rl_remaining: ctx.rateLimitRemaining,
			tier,
			user_hash: userHash,
			...ctx.logFields,
		});
		return response;
	};
}

// Call this after a successful OpenAI request to feed the B.4 counter.
//
// NEVER THROWS. This is accounting, not a precondition — it runs AFTER the
// OpenAI call has already succeeded and already cost money. Letting a Redis
// outage throw here fails the user's request for spend that was already
// incurred: we pay, and they still see an error.
//
// It is also the same fail-open posture the two Redis reads above already
// take (`ratelimit_unavailable`, `circuit_breaker_unavailable`); this writer
// was simply never given it. That inconsistency had teeth: `retrieveChunks`
// calls this INSIDE its embedding try-block, so a dead Redis surfaced to the
// user as "Embedding failed." — sending an operator to debug OpenAI while the
// actual fault was Upstash. (Observed in production 2026-07-14: the Upstash
// database's host stopped resolving; embeddings were provably fine.)
//
// The trade-off is stated plainly: when Redis is unreachable, the global daily
// circuit breaker CANNOT COUNT and therefore cannot trip. Cost protection is
// degraded until Redis returns. We log it loudly rather than deny service —
// but a persistent `openai_accounting_unavailable` in the logs means the spend
// cap is not being enforced and Redis must be restored. What stands in for it
// meanwhile is the in-isolate degraded backstop above (B5) — best-effort and
// per-isolate, NOT a replacement for this counter.
//
// `deps.redis` is a TEST SEAM, never passed in production (both routes call
// `recordOpenAICall(0)`). It exists because getRedis() MEMOISES its client:
// once anything in the process has built one, swapping UPSTASH_REDIS_REST_URL
// to a dead host injects no failure at all, and a test that relies on that is
// vacuous. Injecting a rejecting client reproduces the actual incident — the
// Upstash REST call rejecting — deterministically and offline.
export type AccountingRedis = Pick<Redis, "incr" | "expire" | "incrby">;

export async function recordOpenAICall(
	costUsd = 0,
	deps: { redis?: AccountingRedis } = {},
): Promise<void> {
	try {
		const today = new Date().toISOString().slice(0, 10);
		// Inside the try on purpose: getRedis() THROWS when the env vars are
		// missing, and that must be swallowed here like any other Redis fault.
		const redis = deps.redis ?? getRedis();
		// Increment + set TTL on first write (48h — generous headroom over daily reset).
		const calls = await redis.incr(`openai:calls:${today}`);
		if (calls === 1) await redis.expire(`openai:calls:${today}`, 60 * 60 * 48);
		if (costUsd > 0) {
			const cents = Math.round(costUsd * 100);
			const costKey = `openai:cost_cents:${today}`;
			const total = await redis.incrby(costKey, cents);
			if (total === cents) await redis.expire(costKey, 60 * 60 * 48);
		}
		markRedisHealthy();
	} catch (err) {
		// Loud in logs, invisible to the user — their request already succeeded.
		console.error("openai_accounting_unavailable", err);
		markRedisFailure();
	}
}
