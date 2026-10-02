// Legacy-vs-v2 retrieval parity for CNSC (gate 5: "a pinned-CNSC answer
// retrieves what the legacy path retrieved, except where the edition really
// changed").
//
//   bun run sources:parity            # all 92 golden questions
//   bun run sources:parity --force    # allow a non-local Supabase URL
//
// For each evals/rag-golden.jsonl question, runs the production retrieval
// three ways — legacy (match_regdoc_chunks), v2 pinned CNSC (current
// editions), v2 pinned CNSC + superseded editions — and checks whether a gold
// (document, section) lands in the 8-chunk envelope, plus whether the OOS
// gate decision matches. Questions are split by their gold document:
//   unchanged — the v2 edition is the legacy text, copied (backfill_from_regdoc).
//               Any drop here is a regression.
//   refreshed — v2 holds a newer edition (or dropped a draft); the legacy
//               gold section may be renumbered or gone, so a change is
//               expected and reported, not failed.
// Writes corpus/reports/parity.json. Cost: embeddings only (~$0.005).

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RetrievedChunk } from "../../lib/context-envelope";
import { retrieveForScope } from "../../lib/knowledge-hub/scoped-retrieval";
import { retrieveChunks } from "../../lib/retrieval";
import { thresholdsFor } from "../../lib/sources/thresholds";
import { checkClients, noopRecordUsage } from "./db";
import {
	ensureDirs,
	loadRegister,
	REPO_ROOT,
	REPORTS_DIR,
} from "./register-io";

const argv = process.argv.slice(2);
const ENVELOPE = 8;

interface Golden {
	question_id: string;
	question: string;
	difficulty: string;
	gold_chunks: Array<{ regdoc_id: string; section_number: string | null }>;
}

const key = (doc: string, section: string | null) => `${doc}§${section ?? ""}`;

function hit(envelope: RetrievedChunk[], gold: Golden["gold_chunks"]): boolean {
	const got = new Set(envelope.map((c) => key(c.regdoc_id, c.section_number)));
	return gold.some((g) => got.has(key(g.regdoc_id, g.section_number)));
}

async function main() {
	await ensureDirs();
	const { anon, openai } = checkClients(argv, { needOpenAI: true });
	if (!openai) throw new Error("OPENAI_API_KEY required");
	const register = await loadRegister();

	// Documents whose v2 text is not the legacy text.
	const refreshed = new Set<string>();
	for (const e of register.entries) {
		if (e.collection !== "cnsc") continue;
		const changed =
			(e.status === "current" && e.ingest && !e.backfill_from_regdoc) ||
			e.status === "draft";
		if (changed) refreshed.add(e.doc_ref);
	}

	const golden = readFileSync(
		join(REPO_ROOT, "evals", "rag-golden.jsonl"),
		"utf-8",
	)
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Golden);
	const deps = { supabase: anon, openai, recordUsage: noopRecordUsage };
	const t = thresholdsFor("cnsc");

	interface Row {
		id: string;
		group: "refreshed" | "unchanged";
		gold_docs: string[];
		legacy_hit: boolean;
		v2_hit: boolean;
		v2_historical_hit: boolean;
		legacy_top: number;
		v2_top: number;
		gate_agrees: boolean;
	}
	const rows: Row[] = [];
	for (const g of golden) {
		// v2 goes through retrieveForScope — the production path, including
		// the named-document search and CNSC's thresholds.
		const pinned = (historical: boolean) =>
			retrieveForScope(
				g.question,
				{ kind: "single", collection: "cnsc", via: "pinned", historical },
				deps,
				ENVELOPE,
			);
		const [legacy, v2r, v2hr] = await Promise.all([
			retrieveChunks(g.question, deps, { envelopeChunks: ENVELOPE }),
			pinned(false),
			pinned(true),
		]);
		const v2 = { envelope: v2r.chunks, topSim: v2r.topSim };
		const v2h = { envelope: v2hr.chunks, topSim: v2hr.topSim };
		const group: Row["group"] = g.gold_chunks.some((c) =>
			refreshed.has(c.regdoc_id),
		)
			? "refreshed"
			: "unchanged";
		rows.push({
			id: g.question_id,
			group,
			gold_docs: [...new Set(g.gold_chunks.map((c) => c.regdoc_id))],
			legacy_hit: hit(legacy.envelope, g.gold_chunks),
			v2_hit: hit(v2.envelope, g.gold_chunks),
			v2_historical_hit: hit(v2h.envelope, g.gold_chunks),
			legacy_top: Math.round(legacy.topSim * 1000) / 1000,
			v2_top: Math.round(v2.topSim * 1000) / 1000,
			gate_agrees: legacy.topSim < t.oos === v2.topSim < t.oos,
		});
	}

	const summarize = (group: string) => {
		const g = rows.filter((r) => r.group === group);
		const n = (f: (r: Row) => boolean) => g.filter(f).length;
		return {
			questions: g.length,
			legacy_hit: n((r) => r.legacy_hit),
			v2_hit: n((r) => r.v2_hit),
			v2_historical_hit: n((r) => r.v2_historical_hit),
			lost: g.filter((r) => r.legacy_hit && !r.v2_hit).map((r) => r.id),
			gained: g.filter((r) => !r.legacy_hit && r.v2_hit).map((r) => r.id),
			gate_disagreements: g.filter((r) => !r.gate_agrees).map((r) => r.id),
		};
	};
	const summary = {
		unchanged: summarize("unchanged"),
		refreshed: summarize("refreshed"),
		refreshed_documents: [...refreshed].sort(),
	};
	await writeFile(
		join(REPORTS_DIR, "parity.json"),
		`${JSON.stringify({ run_at: new Date().toISOString(), envelope: ENVELOPE, summary, rows }, null, "\t")}\n`,
	);
	for (const group of ["unchanged", "refreshed"] as const) {
		const s = summary[group];
		console.log(
			`${group.padEnd(9)} n=${s.questions}  hit@${ENVELOPE}: legacy ${s.legacy_hit} · v2 ${s.v2_hit} · v2+superseded ${s.v2_historical_hit}  lost [${s.lost.join(", ")}] gained [${s.gained.join(", ")}]  gate disagreements [${s.gate_disagreements.join(", ")}]`,
		);
	}
	console.log("report → corpus/reports/parity.json");
	// Only the unchanged group can regress: its text is identical.
	if (
		summary.unchanged.lost.length > 0 ||
		summary.unchanged.gate_disagreements.length > 0
	) {
		process.exit(1);
	}
}

await main();
