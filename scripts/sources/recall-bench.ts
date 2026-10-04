// Production search vs exact search (gate 5: "benchmark filtered recall
// against exact search").
//
//   bun run sources:recall            # every searchable collection + all-at-once
//   bun run sources:recall --force    # allow a non-local Supabase URL
//
// For each question, the top-k ids from match_source_chunks (what the app
// calls) against match_source_chunks_exact (same filters, sequential scan).
// recall@k = |production ∩ exact| / k. Pass bar: mean recall@8 >= 0.95 and no
// question below 0.75 for every scope, and no production call slower than
// LATENCY_MAX_MS (round trip, timed alone).
//
// match_source_chunks is EXACT by design at this corpus size (it sets
// enable_indexscan = off — see the migration), so 1.000 is expected. This is
// a guard on the production RPC's results, NOT a measurement of HNSW — and
// it would not necessarily turn red if the index were re-allowed (at this
// size the planner tends to scan exactly anyway). The filtered-HNSW path is
// measured by scripts/sources/sql/hnsw-forced-recall.sql (forces the index;
// report in corpus/reports/hnsw-forced-recall.txt) — run it before allowing
// the index.
// Writes corpus/reports/recall.json. Cost: embeddings only (~$0.001).

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EMBEDDING_DIMENSIONS, OPENAI_MODELS } from "../../lib/openai";
import type { CollectionId } from "../../lib/sources/catalog";
import { checkClients } from "./db";
import { ensureDirs, REPO_ROOT, REPORTS_DIR } from "./register-io";

const argv = process.argv.slice(2);
const KS = [8, 20] as const;
const MEAN_BAR = 0.95;
const MIN_BAR = 0.75;
// The anon role's statement timeout is 3 s per call, and one question can
// make up to 1 + 6 + 4 calls (primary, expansions, named fetch). Exact
// search must stay well inside that — on hosted, run this before rollout.
const LATENCY_MAX_MS = 2500;

interface Scope {
	name: string;
	collections: CollectionId[];
	historical: boolean;
	questions: string[];
}

function questionsFor(col: CollectionId | null): string[] {
	const rows = readFileSync(
		join(REPO_ROOT, "evals", "sources-calibration.jsonl"),
		"utf-8",
	)
		.split("\n")
		.filter((l) => l.trim())
		.map(
			(l) =>
				JSON.parse(l) as { collection: string; kind: string; query: string },
		)
		.filter((r) => r.kind !== "oos" && (col === null || r.collection === col))
		.map((r) => r.query);
	if (col === "cnsc" || col === null) {
		const golden = readFileSync(
			join(REPO_ROOT, "evals", "rag-golden.jsonl"),
			"utf-8",
		)
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => (JSON.parse(l) as { question: string }).question)
			.slice(0, col === null ? 6 : 20);
		rows.push(...golden);
	}
	return rows;
}

async function main() {
	await ensureDirs();
	const { admin, openai } = checkClients(argv, { needOpenAI: true });
	if (!openai) throw new Error("OPENAI_API_KEY required");
	const { data: cols, error } = await admin
		.from("source_collections")
		.select("id,searchable");
	if (error) throw error;
	const searchable = (cols ?? [])
		.filter((c) => c.searchable)
		.map((c) => c.id as CollectionId);

	const scopes: Scope[] = searchable.map((c) => ({
		name: c,
		collections: [c],
		historical: false,
		questions: questionsFor(c),
	}));
	if (searchable.includes("cnsc")) {
		scopes.push({
			name: "cnsc+historical",
			collections: ["cnsc"],
			historical: true,
			questions: questionsFor("cnsc").slice(0, 10),
		});
	}
	scopes.push({
		name: "all-searchable",
		collections: searchable,
		historical: false,
		questions: questionsFor(null),
	});

	// One embedding per distinct question.
	const distinct = [...new Set(scopes.flatMap((s) => s.questions))];
	const vectors = new Map<string, number[]>();
	for (let i = 0; i < distinct.length; i += 100) {
		const batch = distinct.slice(i, i + 100);
		const resp = await openai.embeddings.create({
			model: OPENAI_MODELS.embedding,
			input: batch,
			dimensions: EMBEDDING_DIMENSIONS,
		});
		resp.data.forEach((d, j) => vectors.set(batch[j]!, d.embedding));
	}

	// One untimed call first, so a cold connection is not charged to the
	// first question. (Timed through the service-role client: the same RPC
	// and plan as the app's anon calls, minus the anon statement timeout.)
	const warm = await admin.rpc("match_source_chunks", {
		query_embedding: vectors.get(distinct[0] as string),
		collection_ids: ["cnsc"],
		match_count: 1,
		min_similarity: -1,
		include_historical: false,
	});
	if (warm.error) throw warm.error;

	const out: Record<string, unknown> = {};
	let pass = true;
	for (const s of scopes) {
		const perQ: Array<{ query: string } & Record<string, number>> = [];
		for (const q of s.questions) {
			const embedding = vectors.get(q)!;
			// Sequential, so the production call is timed alone (round trip,
			// as the app sees it).
			const t0 = performance.now();
			const approx = await admin.rpc("match_source_chunks", {
				query_embedding: embedding,
				collection_ids: s.collections,
				match_count: 20,
				min_similarity: -1,
				include_historical: s.historical,
			});
			const ms = performance.now() - t0;
			const exact = await admin.rpc("match_source_chunks_exact", {
				query_embedding: embedding,
				collection_ids: s.collections,
				match_count: 20,
				include_historical: s.historical,
			});
			if (approx.error) throw approx.error;
			if (exact.error) throw exact.error;
			const a = (approx.data as Array<{ id: number }>).map((r) => r.id);
			const e = (exact.data as Array<{ id: number }>).map((r) => r.id);
			const row: { query: string } & Record<string, number> = {
				query: q,
			} as never;
			for (const k of KS) {
				const truth = new Set(e.slice(0, k));
				const denom = Math.min(k, truth.size);
				row[`recall@${k}`] =
					denom === 0
						? 1
						: a.slice(0, k).filter((id) => truth.has(id)).length / denom;
			}
			row.returned = a.length;
			row.ms = Math.round(ms);
			row.top1_match = a[0] === e[0] ? 1 : 0;
			perQ.push(row);
		}
		const mean = (key: string) =>
			Math.round(
				(perQ.reduce((acc, r) => acc + r[key]!, 0) / Math.max(1, perQ.length)) *
					1000,
			) / 1000;
		const min8 = Math.min(...perQ.map((r) => r["recall@8"]!));
		const times = perQ.map((r) => r.ms!).sort((x, y) => x - y);
		const pct = (p: number) =>
			times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? 0;
		const latency = { p50: pct(0.5), p95: pct(0.95), max: pct(1) };
		const ok =
			mean("recall@8") >= MEAN_BAR &&
			min8 >= MIN_BAR &&
			latency.max < LATENCY_MAX_MS;
		if (!ok) pass = false;
		out[s.name] = {
			collections: s.collections,
			include_historical: s.historical,
			questions: perQ.length,
			mean_recall_at_8: mean("recall@8"),
			mean_recall_at_20: mean("recall@20"),
			min_recall_at_8: min8,
			top1_agreement: mean("top1_match"),
			latency_ms: latency,
			pass: ok,
			per_question: perQ,
		};
		console.log(
			`${ok ? "PASS" : "FAIL"} ${s.name.padEnd(16)} n=${perQ.length}  recall@8 ${mean("recall@8").toFixed(3)} (min ${min8.toFixed(2)})  recall@20 ${mean("recall@20").toFixed(3)}  top1 ${mean("top1_match").toFixed(2)}  ms p50 ${latency.p50} p95 ${latency.p95} max ${latency.max}`,
		);
	}
	await writeFile(
		join(REPORTS_DIR, "recall.json"),
		`${JSON.stringify({ run_at: new Date().toISOString(), note: "match_source_chunks is exact by design (enable_indexscan=off), so recall 1.000 is expected: this guards the production RPC's results and times it; it is not an HNSW measurement. Filtered-HNSW recall: corpus/reports/hnsw-forced-recall.txt.", bar: { mean_recall_at_8: MEAN_BAR, min_recall_at_8: MIN_BAR, latency_max_ms: LATENCY_MAX_MS }, scopes: out }, null, "\t")}\n`,
	);
	console.log("report → corpus/reports/recall.json");
	if (!pass) process.exit(1);
}

await main();
