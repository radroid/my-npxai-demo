// Structured JSON logger. One line per request. Cloudflare captures stdout.
// Never logs raw query/response text, raw IPs, or secrets (Appendix H.6).

import type { Tier } from "./validators";

const encoder = new TextEncoder();

function utcDateKey(): string {
	return new Date().toISOString().slice(0, 10);
}

async function sha256Hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", encoder.encode(input));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// Daily-rotating salt. If LOG_HASH_SALT isn't set, derives an ephemeral
// per-process salt so hashes are still stable for a deployment instance.
let ephemeralBase: string | undefined;
function baseSalt(): string {
	const env = process.env.LOG_HASH_SALT;
	if (env && env.length > 0) return env;
	if (!ephemeralBase) ephemeralBase = crypto.randomUUID();
	return ephemeralBase;
}

async function dailySalt(): Promise<string> {
	return sha256Hex(`${baseSalt()}|${utcDateKey()}`);
}

async function saltedHash(prefix: string, value: string): Promise<string> {
	return (await sha256Hex(`${prefix}|${value}|${await dailySalt()}`)).slice(
		0,
		16,
	);
}

export const hashIp = (ip: string) => saltedHash("ip", ip);
export const hashUser = (userId: string) => saltedHash("uid", userId);

export interface RequestLogFields {
	route: string;
	status: number;
	ms: number;
	ip_hash: string;
	rl_remaining?: number;
	tier: Tier;
	user_hash?: string;
	// Knowledge Hub specifics
	prompt_version?: string;
	query_len?: number;
	retrieval_top_sim?: number;
	retrieval_avg_sim?: number;
	fallback_taken?: boolean;
	// Generator specifics
	unit?: string;
	shift?: string;
	// Common model fields
	model?: string;
	input_tokens?: number;
	output_tokens?: number;
	est_cost_usd?: number;
}

function emit(event: string, fields: object): void {
	console.log(
		JSON.stringify({ t: new Date().toISOString(), event, ...fields }),
	);
}

export function logRequest(fields: RequestLogFields): void {
	emit("request", fields);
}

export type GuardReason =
	| "rate_limit"
	| "rate_limit_degraded"
	| "validation"
	| "circuit_breaker"
	| "output_guard"
	| "auth";

export interface GuardLogFields {
	route: string;
	reason: GuardReason;
	ip_hash: string;
	tier: Tier;
	user_hash?: string;
	detail?: string; // short code/phrase — NEVER raw user content
}

export function logGuardEvent(fields: GuardLogFields): void {
	emit("guard", fields);
}
