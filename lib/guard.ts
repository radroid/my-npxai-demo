// Request guard: rate limiting (tier-aware, Appendix B.1 + J.5), input
// validation hook, and global daily OpenAI circuit breaker (B.4).
// Every public API route wraps its handler with `withGuard()`.

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { hashIp, hashUser, logGuardEvent, logRequest } from "./logger";
import { createSupabaseServerClient } from "./supabase";
import { OUTPUT_MAX_TOKENS, QUERY_CHAR_CAP, type Tier } from "./validators";

const GLOBAL_DAILY_CAP = 500;

const LIMITS: Record<
	string,
	Record<Tier, { minute: number; hour: number; day: number }>
> = {
	"knowledge-hub/query": {
		anon: { minute: 3, hour: 10, day: 5 },
		signed_in: { minute: 10, hour: 40, day: 50 },
		npx_circle: { minute: 15, hour: 80, day: 100 },
	},
	"generator/turnover": {
		anon: { minute: 1, hour: 3, day: 2 },
		signed_in: { minute: 3, hour: 12, day: 20 },
		npx_circle: { minute: 5, hour: 20, day: 40 },
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

const limiterCache = new Map<string, Ratelimit>();
function getLimiter(
	prefix: string,
	limit: number,
	window: "1 m" | "1 h" | "24 h",
): Ratelimit {
	const key = `${prefix}:${window}`;
	const cached = limiterCache.get(key);
	if (cached) return cached;
	const rl = new Ratelimit({
		redis: getRedis(),
		limiter: Ratelimit.slidingWindow(limit, window),
		prefix: key,
		analytics: false,
	});
	limiterCache.set(key, rl);
	return rl;
}

function resolveClientIp(req: NextRequest): string {
	const cf = req.headers.get("cf-connecting-ip");
	if (cf) return cf;
	const xff = req.headers.get("x-forwarded-for");
	if (xff) {
		const first = xff.split(",")[0]?.trim();
		if (first) return first;
	}
	return "unknown";
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
			const resolved = typeof tierRow === "string" ? tierRow : "signed_in";
			tier = (resolved === "npx_circle" ? "npx_circle" : "signed_in") as Tier;
			userHash = await hashUser(user.id);
		}

		const clientIp = resolveClientIp(req);
		const ipHash = await hashIp(clientIp);
		const identifier = user ? `user:${user.id}:${tier}` : `anon:${ipHash}`;

		// Eval-only bypass: if EVAL_BYPASS_KEY is set server-side and the
		// x-eval-bypass request header matches, skip rate limit + circuit
		// breaker so the 20-question battery can run in one shot. Opt-in only
		// — unset the env var in production so bypass is impossible.
		const bypassKey = process.env.EVAL_BYPASS_KEY;
		const bypassed =
			Boolean(bypassKey) && req.headers.get("x-eval-bypass") === bypassKey;

		// Rate limits (per-minute / per-hour / per-day) — check cheapest first.
		const limits = LIMITS[opts.route][tier];
		const checks: Array<[number, "1 m" | "1 h" | "24 h"]> = [
			[limits.minute, "1 m"],
			[limits.hour, "1 h"],
			[limits.day, "24 h"],
		];
		const prefix = `rl:${opts.route}`;
		let remaining = Number.POSITIVE_INFINITY;
		for (const [max, window] of checks) {
			if (bypassed) break;
			const rl = getLimiter(prefix, max, window);
			const result = await rl.limit(identifier);
			if (result.remaining < remaining) remaining = result.remaining;
			if (!result.success) {
				logGuardEvent({
					route: opts.route,
					reason: "rate_limit",
					ip_hash: ipHash,
					tier,
					user_hash: userHash,
					detail: window,
				});
				return NextResponse.json(
					{
						error: "rate_limited",
						message:
							tier === "anon"
								? "Anon daily quota reached. Sign in to unlock a higher tier."
								: "You've hit your daily quota. Try again tomorrow.",
						window,
					},
					{ status: 429, headers: { "X-Ratelimit-Tier": tier } },
				);
			}
		}

		// Global daily circuit breaker (skipped when bypassed)
		const dayKey = `openai:calls:${new Date().toISOString().slice(0, 10)}`;
		const currentCalls = bypassed
			? 0
			: Number((await getRedis().get<number>(dayKey)) ?? 0);
		if (currentCalls >= GLOBAL_DAILY_CAP) {
			logGuardEvent({
				route: opts.route,
				reason: "circuit_breaker",
				ip_hash: ipHash,
				tier,
				user_hash: userHash,
			});
			return NextResponse.json(
				{
					error: "demo_rate_limit",
					message:
						"This live demo has hit its daily request cap. Please try again tomorrow or reach out to Raj directly.",
				},
				{ status: 503 },
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
				{ status: 500 },
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
export async function recordOpenAICall(costUsd = 0): Promise<void> {
	const dayKey = `openai:calls:${new Date().toISOString().slice(0, 10)}`;
	const costKey = `openai:cost_cents:${new Date().toISOString().slice(0, 10)}`;
	const redis = getRedis();
	// Increment + set TTL on first write (48h — generous headroom over daily reset).
	const calls = await redis.incr(dayKey);
	if (calls === 1) await redis.expire(dayKey, 60 * 60 * 48);
	if (costUsd > 0) {
		const cents = Math.round(costUsd * 100);
		const total = await redis.incrby(costKey, cents);
		if (total === cents) await redis.expire(costKey, 60 * 60 * 48);
	}
}
