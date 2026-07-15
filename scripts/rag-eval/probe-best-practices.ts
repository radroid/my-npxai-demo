#!/usr/bin/env bun
// Best-practices retrieval probe. Confirms the newly-ingested best-practice
// documents (evals/best-practices-probes.jsonl) are actually retrievable: for
// each probe it embeds the question with the SAME model/dims as production,
// calls the match_regdoc_chunks RPC, and checks whether the expected document
// appears in the top-k. This is a lightweight coverage check for the corpus
// expansion — it does NOT replace the full eval (scripts/rag-eval/run.ts).
//
// Run against LOCAL supabase (never prod) via inline env, e.g.:
//   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
//   SUPABASE_SERVICE_ROLE_KEY=$(bunx supabase status -o env | grep '^SERVICE_ROLE_KEY=' | cut -d'"' -f2) \
//   bun run scripts/rag-eval/probe-best-practices.ts [--k=8] [--min-sim=0.35]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { EMBEDDING_DIMENSIONS, OPENAI_MODELS } from "../../lib/openai";

const argv = process.argv.slice(2);
const K = Number(argv.find((a) => a.startsWith("--k="))?.split("=")[1] ?? "8");
const MIN_SIM = Number(argv.find((a) => a.startsWith("--min-sim="))?.split("=")[1] ?? "0.35");

interface Probe {
	probe_id: string;
	question: string;
	expected_regdoc_id: string;
	sca: string;
	topic: string;
}
interface Match {
	regdoc_id: string;
	section_number: string | null;
	similarity: number;
}

async function main() {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
	const openaiKey = process.env.OPENAI_API_KEY;
	if (!url || !key || !openaiKey) {
		console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / OPENAI_API_KEY");
		process.exit(1);
	}
	if (!/127\.0\.0\.1|localhost/.test(url)) {
		console.error(`Refusing to probe a non-local Supabase (${url}). Point at local via inline env.`);
		process.exit(1);
	}

	const probes = readFileSync(join(process.cwd(), "evals/best-practices-probes.jsonl"), "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Probe);

	const supabase = createClient(url, key, {
		auth: { persistSession: false, autoRefreshToken: false },
	});
	const openai = new OpenAI({ apiKey: openaiKey });

	let hits = 0;
	let top1 = 0;
	const misses: string[] = [];
	console.log(`Best-practices retrieval probe — ${probes.length} probes, k=${K}, min_sim=${MIN_SIM}\n`);

	for (const p of probes) {
		const emb = await openai.embeddings.create({
			model: OPENAI_MODELS.embedding,
			input: p.question,
			dimensions: EMBEDDING_DIMENSIONS,
		});
		const { data, error } = await supabase.rpc("match_regdoc_chunks", {
			query_embedding: emb.data[0]?.embedding,
			match_count: K,
			min_similarity: MIN_SIM,
		});
		if (error) {
			console.error(`  ${p.probe_id} RPC error: ${error.message}`);
			misses.push(p.probe_id);
			continue;
		}
		const matches = (data ?? []) as Match[];
		const rank = matches.findIndex((m) => m.regdoc_id === p.expected_regdoc_id);
		const found = rank >= 0;
		if (found) hits++;
		if (rank === 0) top1++;
		if (!found) misses.push(p.probe_id);
		const mark = found ? (rank === 0 ? "★" : "✓") : "✗";
		const topSim = matches[0]?.similarity?.toFixed(3) ?? "—";
		console.log(
			`  ${mark} ${p.probe_id}  expected ${p.expected_regdoc_id.padEnd(22)} ` +
				`rank=${found ? rank + 1 : "—"}  topSim=${topSim}  [${p.topic}]`,
		);
	}

	const pct = ((hits / probes.length) * 100).toFixed(1);
	const p1 = ((top1 / probes.length) * 100).toFixed(1);
	console.log(`\nExpected-doc hit@${K}: ${hits}/${probes.length} (${pct}%)  ·  top-1: ${top1}/${probes.length} (${p1}%)`);
	if (misses.length) console.log(`Misses: ${misses.join(", ")}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
