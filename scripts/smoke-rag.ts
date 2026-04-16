#!/usr/bin/env bun
// Quick smoke test for the RAG retrieval path. Run after ingestion or
// after an index migration to confirm the match_regdoc_chunks RPC is
// returning semantically-correct top-K.
//
// Usage: bun run scripts/smoke-rag.ts

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const supabase = createClient(
	process.env.NEXT_PUBLIC_SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
	{ auth: { persistSession: false, autoRefreshToken: false } },
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Each probe: query, and which REGDOC we expect in the top-3.
const PROBES: Array<{ q: string; expect: string }> = [
	{ q: "What are the CNSC requirements for shift turnover at a reactor facility?", expect: "REGDOC-2.3.4" },
	{ q: "What is the minimum staff complement for a nuclear power plant?", expect: "REGDOC-2.2.5" },
	{ q: "What does REGDOC-2.2.2 say about personnel training programs?", expect: "REGDOC-2.2.2" },
	{ q: "What does REGDOC-2.6.3 require for aging management?", expect: "REGDOC-2.6.3" },
	{ q: "How should an accident management program be structured?", expect: "REGDOC-2.3.2" },
	{ q: "What are CNSC radiation protection requirements for workers?", expect: "REGDOC-2.7.1" },
];

let passed = 0;
for (const probe of PROBES) {
	const { data: embData } = await openai.embeddings.create({
		model: "text-embedding-3-small",
		input: probe.q,
	});
	const embedding = embData[0]!.embedding;
	const { data: matches, error } = await supabase.rpc("match_regdoc_chunks", {
		query_embedding: embedding,
		match_count: 3,
		min_similarity: -1,
	});
	if (error) {
		console.log(`❌ "${probe.q.slice(0, 40)}…"  rpc error: ${error.message}`);
		continue;
	}
	const topRegdocs = (matches ?? []).map((m) => m.regdoc_id);
	const ok = topRegdocs.includes(probe.expect);
	console.log(`${ok ? "✅" : "❌"}  expect ${probe.expect}  got [${topRegdocs.join(", ")}]`);
	console.log(`     "${probe.q.slice(0, 70)}"`);
	if (ok) passed++;
}
console.log(`\n${passed}/${PROBES.length} probes found their expected REGDOC in top-3`);
if (passed < PROBES.length) {
	console.log(
		"If this failed after ingestion, run migrations/001-switch-to-hnsw.sql in the Supabase SQL editor and retry.",
	);
	process.exit(1);
}
