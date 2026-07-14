// RAG eval framework — dataset types, JSONL IO, chunk fingerprints
// (item-2 slice 2.1, R3/R4/R5 schemas + Edge case 6 / I2.10).

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Fingerprints — chunk ids are BIGSERIAL and NOT stable across re-ingests
// (scripts/ingest.ts wipes + re-inserts). Identity that survives re-ingest:
// (regdoc_id, chunk_index, sha256(chunk_text) short hash).

export interface GoldChunkRef {
	chunk_id: number;
	regdoc_id: string;
	section_number: string | null;
	chunk_index: number;
	text_sha256: string; // short (16 hex chars) sha256 of chunk_text
}

export async function shortSha256(text: string): Promise<string> {
	const buf = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 16);
}

// ---------------------------------------------------------------------------
// Record schemas (JSONL, one record per line — I2.6).

export interface GoldenRecord {
	question_id: string;
	question: string;
	ground_truth_answer: string;
	origin: "synthetic" | "hand";
	difficulty: "single" | "multi";
	gold_chunks: GoldChunkRef[];
	// Set ONLY on the committed placeholder dataset (DELTA D4 fallback when
	// Supabase is unreachable at generation time). The runner refuses to
	// score a placeholder dataset — regenerate with `bun run eval:rag:golden`.
	placeholder?: boolean;
}

export interface OocProbe {
	probe_id: string;
	question: string;
	category:
		| "us_nrc"
		| "iaea"
		| "other_jurisdiction"
		| "general_physics"
		| "adjacent_cnsc"
		| "false_premise";
	expected: "reject";
}

export interface ParaphraseRecord {
	parent_question_id: string;
	paraphrase_id: string;
	question: string;
	placeholder?: boolean;
}

// ---------------------------------------------------------------------------
// JSONL IO

export function readJsonl<T>(filePath: string): T[] {
	const raw = fs.readFileSync(filePath, "utf8");
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line, idx) => {
			try {
				return JSON.parse(line) as T;
			} catch (err) {
				throw new Error(
					`Bad JSONL in ${filePath} at line ${idx + 1}: ${(err as Error).message}`,
				);
			}
		});
}

export function writeJsonl(filePath: string, records: unknown[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
}

export function isPlaceholderDataset(records: GoldenRecord[]): boolean {
	return records.some((r) => r.placeholder === true);
}

// sha256 (full hex) of a dataset file — recorded in every run manifest so
// reports can prove which golden set produced which numbers.
export async function fileSha256(filePath: string): Promise<string> {
	const raw = fs.readFileSync(filePath);
	const buf = await crypto.subtle.digest("SHA-256", raw);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// ---------------------------------------------------------------------------
// Fingerprint verification / re-mapping (Edge case 6, I2.10).
//
// `dbRows` is the DB truth for the fingerprinted chunks (fetched by the
// caller). Verification is pure so the self-test can exercise it offline.

export interface DbChunkRow {
	id: number;
	regdoc_id: string;
	section_number: string | null;
	chunk_index: number;
	text_sha256: string;
}

export type FingerprintOutcome =
	| { status: "ok" }
	| { status: "remapped"; newChunkId: number }
	| { status: "missing" };

export function verifyFingerprint(
	ref: GoldChunkRef,
	dbRows: DbChunkRow[],
): FingerprintOutcome {
	const byId = dbRows.find((r) => r.id === ref.chunk_id);
	if (
		byId &&
		byId.regdoc_id === ref.regdoc_id &&
		byId.chunk_index === ref.chunk_index &&
		byId.text_sha256 === ref.text_sha256
	) {
		return { status: "ok" };
	}
	// Id drifted (re-ingest reassigned BIGSERIALs) — re-map by fingerprint.
	const byFingerprint = dbRows.find(
		(r) =>
			r.regdoc_id === ref.regdoc_id &&
			r.chunk_index === ref.chunk_index &&
			r.text_sha256 === ref.text_sha256,
	);
	if (byFingerprint) return { status: "remapped", newChunkId: byFingerprint.id };
	// Fingerprint itself is gone: corpus content changed — the golden set
	// must be regenerated. Never score against stale ids.
	return { status: "missing" };
}
