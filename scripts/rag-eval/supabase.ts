// RAG eval framework — corpus access (item-2 slice 2.1).
//
// Corpus of record is the Supabase `regdoc_chunks` table, NOT scraped_regdocs/
// (gitignored, absent on fresh clones, and NOT what retrieval searches). Gold
// chunk ids must be the same ids the RPC returns.
//
// I2.8: READ-ONLY. Service-role key is used for SELECT + RPC only — no INSERT,
// UPDATE, DELETE, migration, or re-ingest anywhere in this framework.

import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import {
	type DbChunkRow,
	type GoldChunkRef,
	type GoldenRecord,
	shortSha256,
	verifyFingerprint,
} from "./datasets";

export interface CorpusChunk {
	id: number;
	regdoc_id: string;
	title: string;
	section_number: string | null;
	section_title: string | null;
	chunk_index: number;
	chunk_text: string;
	requirement_type: "requirement" | "guidance" | null;
}

export class SupabaseUnreachableError extends Error {
	constructor(cause: string) {
		super(
			`Supabase is unreachable (${cause}).\n` +
				"A free-tier project that has been idle gets PAUSED, and a paused " +
				"project can drop its DNS record — NXDOMAIN does not by itself prove " +
				"deletion. Un-pause it from the dashboard; see supabase/RECOVERY.md.\n" +
				"Preflight aborts here, BEFORE any OpenAI spend (Edge case 1).",
		);
		this.name = "SupabaseUnreachableError";
	}
}

export function getEvalSupabase(): SupabaseClient {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) {
		throw new Error(
			"NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set " +
				"(.env.local, auto-loaded by Bun).",
		);
	}
	return createClient(url, key, {
		auth: { persistSession: false, autoRefreshToken: false },
	});
}

/** Cheap liveness + corpus-size probe. Throws SupabaseUnreachableError. */
export async function countChunks(supabase: SupabaseClient): Promise<number> {
	try {
		const { count, error } = await supabase
			.from("regdoc_chunks")
			.select("id", { count: "exact", head: true });
		if (error) throw new SupabaseUnreachableError(error.message);
		return count ?? 0;
	} catch (err) {
		if (err instanceof SupabaseUnreachableError) throw err;
		throw new SupabaseUnreachableError((err as Error).message);
	}
}

const PAGE = 1000;

/** Full corpus (paginated) — golden-set generation + fingerprint verification. */
export async function fetchAllChunks(
	supabase: SupabaseClient,
): Promise<CorpusChunk[]> {
	const out: CorpusChunk[] = [];
	for (let from = 0; ; from += PAGE) {
		const { data, error } = await supabase
			.from("regdoc_chunks")
			.select(
				"id, regdoc_id, title, section_number, section_title, chunk_index, chunk_text, requirement_type",
			)
			.order("id", { ascending: true })
			.range(from, from + PAGE - 1);
		if (error) throw new SupabaseUnreachableError(error.message);
		const rows = (data ?? []) as CorpusChunk[];
		out.push(...rows);
		if (rows.length < PAGE) break;
	}
	return out;
}

/**
 * Full chunk_text by id — the SSE `data-sources` snippet is truncated at 260
 * chars, and faithfulness / citation-support judging needs the WHOLE chunk
 * (spec R7 metrics 3 and 5b).
 */
export async function fetchChunksByIds(
	supabase: SupabaseClient,
	ids: number[],
): Promise<Map<number, CorpusChunk>> {
	const map = new Map<number, CorpusChunk>();
	if (ids.length === 0) return map;
	for (let i = 0; i < ids.length; i += PAGE) {
		const slice = ids.slice(i, i + PAGE);
		const { data, error } = await supabase
			.from("regdoc_chunks")
			.select(
				"id, regdoc_id, title, section_number, section_title, chunk_index, chunk_text, requirement_type",
			)
			.in("id", slice);
		if (error) throw new SupabaseUnreachableError(error.message);
		for (const row of (data ?? []) as CorpusChunk[]) map.set(row.id, row);
	}
	return map;
}

export async function toDbChunkRow(c: CorpusChunk): Promise<DbChunkRow> {
	return {
		id: c.id,
		regdoc_id: c.regdoc_id,
		section_number: c.section_number,
		chunk_index: c.chunk_index,
		text_sha256: await shortSha256(c.chunk_text),
	};
}

export async function toGoldChunkRef(c: CorpusChunk): Promise<GoldChunkRef> {
	return {
		chunk_id: c.id,
		regdoc_id: c.regdoc_id,
		section_number: c.section_number,
		chunk_index: c.chunk_index,
		text_sha256: await shortSha256(c.chunk_text),
	};
}

export interface FingerprintReport {
	ok: number;
	remapped: number;
	missing: number;
	/** Golden records with >= 1 missing gold chunk — the run must abort. */
	missingQuestionIds: string[];
	/** Records mutated in memory with re-mapped ids (Edge case 6 / I2.10). */
	verified: GoldenRecord[];
}

/**
 * Edge case 6: `scripts/ingest.ts` wipes + re-inserts regdoc_chunks, so
 * BIGSERIAL ids drift across re-ingests. Every gold chunk id is re-verified
 * against its (regdoc_id, chunk_index, text hash) fingerprint before scoring;
 * drifted ids are re-mapped, vanished fingerprints abort the run. NEVER score
 * against stale ids (I2.10).
 */
export async function verifyGoldenAgainstDb(
	golden: GoldenRecord[],
	corpus: CorpusChunk[],
): Promise<FingerprintReport> {
	const dbRows = await Promise.all(corpus.map(toDbChunkRow));
	const report: FingerprintReport = {
		ok: 0,
		remapped: 0,
		missing: 0,
		missingQuestionIds: [],
		verified: [],
	};
	for (const rec of golden) {
		let recMissing = false;
		const chunks = rec.gold_chunks.map((ref) => {
			const outcome = verifyFingerprint(ref, dbRows);
			if (outcome.status === "ok") {
				report.ok++;
				return ref;
			}
			if (outcome.status === "remapped") {
				report.remapped++;
				return { ...ref, chunk_id: outcome.newChunkId };
			}
			report.missing++;
			recMissing = true;
			return ref;
		});
		if (recMissing) report.missingQuestionIds.push(rec.question_id);
		report.verified.push({ ...rec, gold_chunks: chunks });
	}
	return report;
}
