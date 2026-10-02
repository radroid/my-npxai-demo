// Per-collection threshold calibration (PLAN.md Phase 12: "recalibrate
// similarity/fallback thresholds per collection").
//
//   bun run sources:calibrate            # all collections with text
//   bun run sources:calibrate --force    # allow a non-local Supabase URL
//
// For every collection, runs the production retrieval (lib/retrieval.ts
// retrieveChunks, the same call lib/knowledge-hub/scoped-retrieval.ts makes)
// on:
//   in   — questions that collection's documents answer
//          (evals/sources-calibration.jsonl; CNSC uses the first 14 single-hop
//          questions of evals/rag-golden.jsonl)
//   oos  — off-topic probes shared by every collection
//   near — on-regulator questions the corpus does NOT cover (reported, not
//          used to choose numbers: the right outcome there is a limited or
//          refused answer, and either is acceptable)
// and records top-1 similarity (the OOS gate input) and the envelope mean
// (the limited-context input).
//
// Rule, deliberately conservative: a collection keeps the legacy CNSC values
// unless they misclassify one of its in/oos questions. Only then is the
// refusal gate MOVED AS LITTLE AS POSSIBLE — just past the misclassified side
// with a 0.03 margin (raised above the highest off-topic top-1, or lowered
// below the lowest in-scope top-1), rounded to 0.01 — and only if the two
// sides are separated by more than both margins. Not the midpoint: with a
// dozen probes per side the gap's far edge is the least-measured number, and
// a gate placed deep inside it risks refusing real questions the probes did
// not cover. Overlap is reported, never papered over. The limited-context and
// per-chunk floors are left at legacy (no probe measures them). The output is
// a recommendation; lib/sources/thresholds.ts is edited by hand with the basis.
// Writes corpus/reports/calibration.json. Cost: embeddings only (~$0.001).

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_THRESHOLDS, retrieveChunks } from "../../lib/retrieval";
import type { CollectionId } from "../../lib/sources/catalog";
import { COLLECTION_THRESHOLDS } from "../../lib/sources/thresholds";
import { checkClients, noopRecordUsage } from "./db";
import { ensureDirs, REPO_ROOT, REPORTS_DIR } from "./register-io";

const argv = process.argv.slice(2);
const COLLECTIONS: CollectionId[] = ["cnsc", "nrc", "onr", "eu"];
const CNSC_GOLDEN = 14;
const MARGIN = 0.03;

interface Probe {
	collection: CollectionId | "*";
	kind: "in" | "oos" | "near";
	query: string;
}

interface Measured extends Probe {
	topSim: number;
	avgSim: number;
	poolAvgSim: number;
}

function loadProbes(): Probe[] {
	const probes = readFileSync(
		join(REPO_ROOT, "evals", "sources-calibration.jsonl"),
		"utf-8",
	)
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Probe);
	const golden = readFileSync(
		join(REPO_ROOT, "evals", "rag-golden.jsonl"),
		"utf-8",
	)
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as { question: string; difficulty: string })
		.filter((g) => g.difficulty === "single")
		.slice(0, CNSC_GOLDEN);
	for (const g of golden) {
		probes.push({ collection: "cnsc", kind: "in", query: g.question });
	}
	return probes;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

async function main() {
	await ensureDirs();
	const { anon, openai } = checkClients(argv, { needOpenAI: true });
	if (!openai) throw new Error("OPENAI_API_KEY required");
	const probes = loadProbes();
	const deps = { supabase: anon, openai, recordUsage: noopRecordUsage };

	const report: Record<string, unknown> = {};
	for (const col of COLLECTIONS) {
		const mine = probes.filter(
			(p) => p.collection === col || p.collection === "*",
		);
		const measured: Measured[] = [];
		for (const p of mine) {
			const r = await retrieveChunks(p.query, deps, {
				envelopeChunks: 8,
				source: { collections: [col] },
				thresholds: DEFAULT_THRESHOLDS,
			});
			measured.push({
				...p,
				topSim: round(r.topSim),
				avgSim: round(r.avgSim),
				poolAvgSim: round(r.poolAvgSim),
			});
		}
		const ins = measured.filter((m) => m.kind === "in").map((m) => m.topSim);
		const oos = measured.filter((m) => m.kind === "oos").map((m) => m.topSim);
		const minIn = Math.min(...ins);
		const maxOos = Math.max(...oos);
		const gate = DEFAULT_THRESHOLDS.oos;
		const refusedIn = ins.filter((s) => s < gate).length;
		const answeredOos = oos.filter((s) => s >= gate).length;
		let recommendation: string;
		let proposedOos: number | null = null;
		if (refusedIn === 0 && answeredOos === 0) {
			recommendation = `keep legacy values: the ${gate} gate answers ${ins.length}/${ins.length} in-scope and refuses ${oos.length}/${oos.length} off-topic`;
		} else if (maxOos + 2 * MARGIN < minIn) {
			proposedOos =
				answeredOos > 0
					? Math.ceil((maxOos + MARGIN) * 100) / 100
					: Math.floor((minIn - MARGIN) * 100) / 100;
			recommendation = `legacy gate misclassifies (${refusedIn} in-scope refused, ${answeredOos} off-topic answered); separable — propose oos ${proposedOos} (smallest move with a ${MARGIN} margin), legacy disclaimer/minChunk`;
		} else {
			recommendation = `legacy gate misclassifies (${refusedIn} in-scope refused, ${answeredOos} off-topic answered) and in/oos overlap (max oos ${maxOos} ≥ min in ${minIn}) — keep legacy values, needs more data`;
		}
		const near = measured.filter((m) => m.kind === "near");
		report[col] = {
			current: COLLECTION_THRESHOLDS[col],
			in_scope: {
				n: ins.length,
				min_top: minIn,
				refused_at_legacy_gate: refusedIn,
			},
			off_topic: {
				n: oos.length,
				max_top: maxOos,
				answered_at_legacy_gate: answeredOos,
			},
			margin: round(minIn - maxOos),
			near: near.map((m) => ({
				query: m.query,
				topSim: m.topSim,
				avgSim: m.avgSim,
			})),
			recommendation,
			proposed_oos: proposedOos,
			measured,
		};
		console.log(
			`${col.padEnd(5)} in ${ins.length} (min top ${minIn}) · oos ${oos.length} (max top ${maxOos}) · margin ${round(minIn - maxOos)}\n      ${recommendation}`,
		);
		for (const m of near) {
			console.log(
				`      near ${m.topSim.toFixed(3)} avg ${m.avgSim.toFixed(3)}  ${m.query.slice(0, 70)}`,
			);
		}
	}
	await writeFile(
		join(REPORTS_DIR, "calibration.json"),
		`${JSON.stringify({ run_at: new Date().toISOString(), legacy: DEFAULT_THRESHOLDS, collections: report }, null, "\t")}\n`,
	);
	console.log("report → corpus/reports/calibration.json");
}

await main();
