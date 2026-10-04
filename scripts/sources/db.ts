// Shared client setup for the Phase 12 release checks (audit, recall bench,
// parity, calibration). Same guard as publish.ts: a non-loopback Supabase URL
// is treated as the hosted demo and refused unless --force is passed, so a
// stray env file can never point a benchmark at production by accident.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { isLocalSupabaseUrl } from "../lib/embed";

export interface CheckClients {
	/** service_role — reads source_* tables and the exact-search twin. */
	admin: SupabaseClient;
	/** anon — the role the app's retrieval actually runs as. */
	anon: SupabaseClient;
	openai: OpenAI | null;
	url: string;
}

export function checkClients(
	argv: string[],
	opts: { needOpenAI: boolean },
): CheckClients {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
	const openaiKey = process.env.OPENAI_API_KEY;
	const missing = [
		!url && "NEXT_PUBLIC_SUPABASE_URL",
		!serviceKey && "SUPABASE_SERVICE_ROLE_KEY",
		!anonKey && "NEXT_PUBLIC_SUPABASE_ANON_KEY",
		opts.needOpenAI && !openaiKey && "OPENAI_API_KEY",
	].filter(Boolean);
	if (missing.length > 0 || !url || !serviceKey || !anonKey) {
		console.error(`Missing env: ${missing.join(", ")}`);
		process.exit(1);
	}
	if (!isLocalSupabaseUrl(url) && !argv.includes("--force")) {
		console.error(
			`Refusing to run against ${url}: not a local Supabase URL. Pass --force for a deliberate hosted check (docs/phase-12-sources.md).`,
		);
		process.exit(1);
	}
	const auth = { persistSession: false, autoRefreshToken: false };
	return {
		admin: createClient(url, serviceKey, { auth }),
		anon: createClient(url, anonKey, { auth }),
		openai: openaiKey ? new OpenAI({ apiKey: openaiKey }) : null,
		url,
	};
}

/** Offline checks never touch the production daily OpenAI counter. */
export const noopRecordUsage = async (): Promise<void> => {};

/** Fetch every row of a PostgREST select, 1000 at a time. */
export async function selectAll<T>(
	page: (
		from: number,
		to: number,
	) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
	const out: T[] = [];
	for (let from = 0; ; from += 1000) {
		const { data, error } = await page(from, from + 999);
		if (error)
			throw error instanceof Error ? error : new Error(JSON.stringify(error));
		out.push(...(data ?? []));
		if (!data || data.length < 1000) return out;
	}
}
