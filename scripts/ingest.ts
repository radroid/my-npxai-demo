#!/usr/bin/env bun
// Offline ingestion: parse scraped_regdocs/*.json, chunk per Appendix C.4,
// embed per C.5, batch-insert into regdoc_chunks, print C.6 verification.
//
// Uses SUPABASE_SERVICE_ROLE_KEY — runs only from dev machines, never bundled
// into runtime. See Appendix A.5 for the key/role separation rule.
//
// Idempotent: TRUNCATEs regdoc_chunks first (derived data, safe to rebuild).
//
// CLI:
//   bun run ingest                # full run
//   bun run ingest --dry-run      # chunk + print stats, no API or DB writes
//   bun run ingest --only=REGDOC-2.3.4   # restrict to one doc (debug)

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { get_encoding } from "tiktoken";

const CHUNK_TARGET_TOKENS = 400;
const CHUNK_OVERLAP_TOKENS = 60;
const CHUNK_MIN_TOKENS = 40; // skip tiny orphan chunks (ToC remnants, etc.)
const CHUNK_HARD_MAX_TOKENS = 700; // safety cap
const EMBED_BATCH_SIZE = 100;
const INSERT_BATCH_SIZE = 500;
const EMBEDDING_MODEL = "text-embedding-3-small";

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const ONLY = argv.find((a) => a.startsWith("--only="))?.split("=")[1];

type ScrapedRequirementType = "informational" | "guidance" | "requirement";

interface Paragraph {
	text: string;
	paragraph_number?: string;
	requirement_type?: ScrapedRequirementType;
}

interface Section {
	section_number: string;
	section_title: string;
	anchor?: string;
	paragraphs: Paragraph[];
}

interface Doc {
	regdoc_id: string;
	title: string;
	url: string;
	source_type?: string;
	scraped_at?: string;
	sections: Section[];
}

interface Chunk {
	regdoc_id: string;
	title: string;
	section_number: string | null;
	section_title: string | null;
	chunk_text: string;
	chunk_index: number;
	url: string | null;
	requirement_type: "requirement" | "guidance";
}

// Appendix C.3 requirement-vs-guidance classifier. Run against the fully
// assembled chunk, so it's robust to paragraph-boundary overlap.
const REQUIREMENT_MARKERS = [
	/\bshall\b/i,
	/\bmust\b/i,
	/\brequired to\b/i,
	/\bis required\b/i,
];
const GUIDANCE_MARKERS = [
	/\bshould\b/i,
	/\bmay\b/i,
	/\bis recommended\b/i,
	/\bit is expected that\b/i,
];

function classifyRequirement(text: string): "requirement" | "guidance" {
	if (REQUIREMENT_MARKERS.some((re) => re.test(text))) return "requirement";
	if (GUIDANCE_MARKERS.some((re) => re.test(text))) return "guidance";
	return "guidance";
}

const encoder = get_encoding("cl100k_base");
function countTokens(text: string): number {
	return encoder.encode(text).length;
}

// Sentence splitter — breaks on sentence terminators followed by whitespace
// then a capital letter / digit / open-quote. Conservative; if it misses a
// boundary, the chunker will still flush when the token budget is hit.
function splitSentences(text: string): string[] {
	const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
	return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

function assembleSectionText(section: Section): string {
	return section.paragraphs
		.map((p) => p.text?.trim() ?? "")
		.filter((t) => t.length > 0)
		.join("\n\n");
}

function buildSectionUrl(section: Section, doc: Doc): string {
	if (section.anchor && section.anchor.length > 0) {
		return `${doc.url}${section.anchor}`;
	}
	return doc.url;
}

interface ChunkingStats {
	totalSections: number;
	emptySections: number;
	chunksEmitted: number;
	skippedTiny: number;
}

function chunkDoc(doc: Doc, stats: ChunkingStats): Chunk[] {
	const out: Chunk[] = [];
	let chunkIndex = 0;

	for (const section of doc.sections) {
		stats.totalSections++;
		const sectionText = assembleSectionText(section);
		if (!sectionText) {
			stats.emptySections++;
			continue;
		}

		const url = buildSectionUrl(section, doc);
		const sentences = splitSentences(sectionText);

		let bufferSentences: string[] = [];
		let bufferTokens = 0;

		const flush = () => {
			if (bufferSentences.length === 0) return;
			const text = bufferSentences.join(" ").trim();
			const tokens = countTokens(text);
			if (tokens < CHUNK_MIN_TOKENS) {
				stats.skippedTiny++;
				return;
			}
			out.push({
				regdoc_id: doc.regdoc_id,
				title: doc.title,
				section_number: section.section_number?.length ? section.section_number : null,
				section_title: section.section_title?.length ? section.section_title : null,
				chunk_text: text,
				chunk_index: chunkIndex++,
				url,
				requirement_type: classifyRequirement(text),
			});
			stats.chunksEmitted++;
		};

		for (const sentence of sentences) {
			const sentTokens = countTokens(sentence);

			// Overflow guard: even a single sentence can exceed the target.
			// Emit what we have, then emit the oversized sentence as its own chunk.
			if (sentTokens > CHUNK_HARD_MAX_TOKENS) {
				flush();
				bufferSentences = [];
				bufferTokens = 0;
				out.push({
					regdoc_id: doc.regdoc_id,
					title: doc.title,
					section_number: section.section_number?.length ? section.section_number : null,
					section_title: section.section_title?.length ? section.section_title : null,
					chunk_text: sentence,
					chunk_index: chunkIndex++,
					url,
					requirement_type: classifyRequirement(sentence),
				});
				stats.chunksEmitted++;
				continue;
			}

			if (
				bufferTokens + sentTokens > CHUNK_TARGET_TOKENS &&
				bufferTokens >= CHUNK_TARGET_TOKENS - 100
			) {
				flush();

				// Retain the trailing CHUNK_OVERLAP_TOKENS worth of sentences
				// as the seed of the next chunk.
				const overlap: string[] = [];
				let overlapTokens = 0;
				for (let i = bufferSentences.length - 1; i >= 0; i--) {
					const s = bufferSentences[i]!;
					const t = countTokens(s);
					if (overlapTokens + t > CHUNK_OVERLAP_TOKENS) break;
					overlap.unshift(s);
					overlapTokens += t;
				}
				bufferSentences = overlap;
				bufferTokens = overlapTokens;
			}

			bufferSentences.push(sentence);
			bufferTokens += sentTokens;
		}

		flush();
	}

	return out;
}

async function embedBatch(client: OpenAI, texts: string[]): Promise<number[][]> {
	let attempt = 0;
	let delay = 1000;
	const maxAttempts = 5;
	while (attempt < maxAttempts) {
		try {
			const resp = await client.embeddings.create({
				model: EMBEDDING_MODEL,
				input: texts,
			});
			return resp.data.map((d) => d.embedding);
		} catch (err) {
			attempt++;
			const msg = err instanceof Error ? err.message : String(err);
			if (attempt >= maxAttempts) {
				throw new Error(`embedBatch exhausted retries: ${msg}`);
			}
			console.warn(`  embed retry ${attempt}/${maxAttempts - 1} after: ${msg}`);
			await new Promise((r) => setTimeout(r, delay));
			delay = Math.min(delay * 2, 32000);
		}
	}
	throw new Error("unreachable");
}

async function main() {
	const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	const openaiKey = process.env.OPENAI_API_KEY;

	if (!supabaseUrl || !supabaseServiceKey || !openaiKey) {
		console.error(
			"Missing env. Required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY",
		);
		console.error("  (Bun loads .env.local automatically — is it at the repo root?)");
		process.exit(1);
	}

	const dir = join(process.cwd(), "scraped_regdocs");
	const entries = await readdir(dir);
	let files = entries.filter((f) => f.endsWith(".json") && !f.startsWith("_"));
	if (ONLY) {
		// --only=REGDOC-2.3.4 maps to regdoc-2-3-4.json
		const wanted = ONLY.toLowerCase().replace(/\./g, "-");
		files = files.filter((f) => f.includes(wanted));
		if (files.length === 0) {
			console.error(`No file matched --only=${ONLY}`);
			process.exit(1);
		}
	}
	console.log(`Loading ${files.length} doc(s) from ${dir}`);

	const stats: ChunkingStats = {
		totalSections: 0,
		emptySections: 0,
		chunksEmitted: 0,
		skippedTiny: 0,
	};
	const allChunks: Chunk[] = [];
	const perDocCounts: Record<string, number> = {};

	for (const file of files) {
		const raw = await readFile(join(dir, file), "utf-8");
		const doc = JSON.parse(raw) as Doc;
		const before = allChunks.length;
		const chunks = chunkDoc(doc, stats);
		allChunks.push(...chunks);
		perDocCounts[doc.regdoc_id] = allChunks.length - before;
		console.log(`  ${doc.regdoc_id.padEnd(16)} ${perDocCounts[doc.regdoc_id]} chunks`);
	}

	const reqCount = allChunks.filter((c) => c.requirement_type === "requirement").length;
	const guideCount = allChunks.length - reqCount;
	console.log(
		`\nTotal: ${allChunks.length} chunks (${reqCount} requirement, ${guideCount} guidance)`,
	);
	console.log(
		`Sections: ${stats.totalSections} total, ${stats.emptySections} empty, ${stats.skippedTiny} tiny-orphans skipped`,
	);

	if (allChunks.length === 0) {
		console.error("No chunks to ingest — aborting.");
		process.exit(1);
	}

	if (DRY_RUN) {
		encoder.free();
		console.log("\n--dry-run: stopping before API/DB writes.");
		console.log("Sample chunk:");
		console.log(JSON.stringify(allChunks[0], null, 2).slice(0, 600));
		return;
	}

	const supabase = createClient(supabaseUrl, supabaseServiceKey, {
		auth: { persistSession: false, autoRefreshToken: false },
	});
	const openai = new OpenAI({ apiKey: openaiKey });

	// Wipe existing chunks (derived data). Rerun-safe.
	console.log("\nClearing regdoc_chunks…");
	const { error: delErr } = await supabase.from("regdoc_chunks").delete().gte("id", 0);
	if (delErr) {
		console.error("  delete failed:", delErr.message);
		process.exit(1);
	}

	// Embed
	console.log(`\nEmbedding (${EMBEDDING_MODEL})…`);
	const rows: Array<Chunk & { embedding: number[] }> = [];
	for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
		const batch = allChunks.slice(i, i + EMBED_BATCH_SIZE);
		const embeddings = await embedBatch(
			openai,
			batch.map((c) => c.chunk_text),
		);
		for (let j = 0; j < batch.length; j++) {
			rows.push({ ...batch[j]!, embedding: embeddings[j]! });
		}
		console.log(`  ${rows.length}/${allChunks.length}`);
	}

	// Insert
	console.log(`\nInserting (batch=${INSERT_BATCH_SIZE})…`);
	for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
		const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
		const { error } = await supabase.from("regdoc_chunks").insert(batch);
		if (error) {
			console.error(`  insert failed at batch ${i / INSERT_BATCH_SIZE}:`, error.message);
			process.exit(1);
		}
		console.log(`  ${Math.min(i + INSERT_BATCH_SIZE, rows.length)}/${rows.length}`);
	}

	// C.6 verification
	console.log("\n— C.6 verification —");
	const { count: totalCount, error: countErr } = await supabase
		.from("regdoc_chunks")
		.select("*", { count: "exact", head: true });
	if (countErr) console.error("  count failed:", countErr.message);
	else console.log(`  total chunks in DB: ${totalCount}`);

	const { count: nullEmbedCount } = await supabase
		.from("regdoc_chunks")
		.select("*", { count: "exact", head: true })
		.is("embedding", null);
	console.log(`  chunks with NULL embedding: ${nullEmbedCount ?? "?"}  (expect 0)`);

	const [smokeEmbedding] = await embedBatch(openai, ["shift turnover"]);
	const { data: matches, error: matchErr } = await supabase.rpc("match_regdoc_chunks", {
		query_embedding: smokeEmbedding,
		match_count: 3,
		min_similarity: 0.3,
	});
	if (matchErr) {
		console.error(`  smoke test RPC failed: ${matchErr.message}`);
	} else {
		console.log(`  smoke query "shift turnover" → ${matches?.length ?? 0} matches`);
		for (const m of matches ?? []) {
			const sim = typeof m.similarity === "number" ? m.similarity.toFixed(3) : "?";
			console.log(
				`    ${m.regdoc_id} §${m.section_number ?? "-"} — sim=${sim}`,
			);
		}
	}

	encoder.free();
	console.log("\n✅ Ingestion complete");
}

main().catch((err) => {
	encoder.free();
	console.error(err);
	process.exit(1);
});
