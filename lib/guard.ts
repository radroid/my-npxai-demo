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
	redisSingleton = new Redis({ url, token });
	return redisSingleton;
}

// Cache keyed by prefix + window + limit value. The limit has to be part of
// the key: if you tighten e.g. hour 10 → 5, the cached Ratelimit instance
// built with limit=10 would keep approving requests up to 10 until the
// process restarts. Including the limit in the key means a config edit
// invalidates the stale instance on the next request. The Redis bucket
// prefix uses only prefix+window (unchanged) so the server-side counter
// itself is continuous across limit edits — only the per-request math
// picks up the new ceiling.
const limiterCache = new Map<string, Ratelimit>();
function getLimiter(prefix: string, limit: number, window: Window): Ratelimit {
	const cacheKey = `${prefix}:${window}:${limit}`;
	const cached = limiterCache.get(cacheKey);
	if (cached) return cached;
	const rl = new Ratelimit({
		redis: getRedis(),
		limiter: Ratelimit.slidingWindow(limit, window),
		prefix: `${prefix}:${window}`,
		analytics: false,
	});
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

export function withGuard(
	opts: WithGuardOptions,
	handler: GuardedHandler,
): (req: NextRequest) => Promise<Response> {
	return async (req: NextRequest) => {
		const start = Date.now();
		const supabase = await createSupabaseServerClient();

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
		// back. The global circuit breaker below is the second line of defense.
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
				const rl = getLimiter(prefix, limits[key], window);
				const result = await rl.limit(identifier);
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
		// previously crashed the route and surfaced as 5xx on every call.
		let currentCalls = 0;
		if (!bypassed) {
			try {
				const dayKey = `openai:calls:${new Date().toISOString().slice(0, 10)}`;
				currentCalls = Number((await getRedis().get<number>(dayKey)) ?? 0);
			} catch (err) {
				console.error("circuit_breaker_unavailable", err);
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
// cap is not being enforced and Redis must be restored.
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
	} catch (err) {
		// Loud in logs, invisible to the user — their request already succeeded.
		console.error("openai_accounting_unavailable", err);
	}
}
