#!/usr/bin/env bun
// RAG eval framework — aggregator (item-2 slice 2.1, R10 last paragraph).
//
//   bun run eval:rag:report [dir ...] [--mixed] [--allow-partial] [--out FILE]
//
// Folds one or more evals/results/<stamp>-<experiment>/ dirs into the
// per-category 0-100% markdown table that slice 2.2's committed report is built
// on. With no dirs given, it folds the LATEST run of each experiment.
//
// Two refusals, both deliberate:
//   - Runs with differing PROMPT_VERSION are not folded into one table unless
//     --mixed is passed: scores are only comparable within a prompt version
//     (Edge case 5).
//   - Aborted runs (cost cap hit) are skipped unless --allow-partial
//     (Edge case 8).
//
// Every row carries its measured %, the expected/realistic range from
// docs/orchestration/research/rag-eval-metrics.md §Realistic score expectations,
// and that range's citation (I2.4 — no invented metrics, sources cited).

import fs from "node:fs";
import path from "node:path";
import { RESULTS_DIR } from "./config";

interface Manifest {
	experiment: string;
	aborted: boolean;
	items: number;
	prompt_version: string;
	models: Record<string, string>;
	judge_errors: Record<string, number>;
	cost: {
		capUsd: number;
		totalUsd: number;
		byKind: Record<string, { usd: number; tokens: number }>;
	};
	golden_set: { sha256: string; records: number };
}

interface Run {
	dir: string;
	manifest: Manifest;
	items: Record<string, unknown>[];
}

// Expected ranges + citations, verbatim from the research doc's
// §Realistic score expectations table. Do not edit without editing that doc.
const EXPECTED: Record<string, { range: string; source: string }> = {
	"Retrieval quality (hit rate@8)": {
		range: "context recall ≥ 0.85 target",
		source: "OpenAI evaluation best practices",
	},
	"Context recall@8": {
		range: "≥ 0.85",
		source: "OpenAI evaluation best practices",
	},
	"Context precision (CP@8)": {
		range: "> 0.70",
		source: "OpenAI evaluation best practices",
	},
	Faithfulness: {
		range: "0.85–0.90 good; 0.95–0.98 gate for citation-critical domains",
		source: "qaskills; legal RAG case study 2026",
	},
	"Answer relevancy": {
		range: "high-0.8s+ when retrieval works",
		source: "RAGAS docs; qaskills",
	},
	"Citation correctness (claim support)": {
		range: "no published standard — read against the faithfulness gate (0.95+)",
		source: "custom metric; research doc §Recommended set #5",
	},
	"Citation validity (deterministic)": {
		range: "1.00 expected — any invalid citation is a fabricated pointer",
		source: "custom metric; deterministic",
	},
	"Consistency (citation-set agreement ×5)": {
		range: "TARa high-90s target; ~24% of exact repeats differ at temp 0",
		source: "arXiv 2408.04667; arXiv 2601.19934",
	},
	"Consistency (TARr exact text ×5)": {
		range: "~76% expected (i.e. ~24% of repeats differ verbatim)",
		source: "arXiv 2408.04667",
	},
	"Paraphrase retrieval Jaccard": {
		range: "no canonical threshold — track deltas over time",
		source: "arXiv 2604.10745; REAL-MM-RAG",
	},
	"Negative rejection": {
		range: "~24.7% exact-match for vanilla ChatGPT — refusal prompting should beat it decisively",
		source: "RGB (arXiv 2309.01431)",
	},
};

function pct(x: number | null): string {
	return x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

/** Mean over defined values only — nulls are EXCLUDED from the denominator
 * (judge errors and no-claims items, per Edge case 3). Returns the count kept. */
function meanDefined(values: Array<number | null | undefined>): {
	value: number | null;
	n: number;
	excluded: number;
} {
	const kept = values.filter((v): v is number => typeof v === "number");
	return {
		value: kept.length === 0 ? null : kept.reduce((a, b) => a + b, 0) / kept.length,
		n: kept.length,
		excluded: values.length - kept.length,
	};
}

function metric(item: Record<string, unknown>, key: string): number | null {
	const m = item.metrics as Record<string, unknown> | undefined;
	const v = m?.[key];
	return typeof v === "number" ? v : null;
}

function loadRun(dir: string): Run | null {
	const manifestPath = path.join(dir, "manifest.json");
	const itemsPath = path.join(dir, "items.jsonl");
	if (!fs.existsSync(manifestPath) || !fs.existsSync(itemsPath)) return null;
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
	const items = fs
		.readFileSync(itemsPath, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Record<string, unknown>);
	return { dir, manifest, items };
}

/** Latest run dir per experiment (dir names start with a sortable UTC stamp). */
function latestRuns(): string[] {
	if (!fs.existsSync(RESULTS_DIR)) return [];
	const dirs = fs
		.readdirSync(RESULTS_DIR)
		.filter((d) => fs.statSync(path.join(RESULTS_DIR, d)).isDirectory())
		.sort();
	const byExperiment = new Map<string, string>();
	for (const d of dirs) {
		const experiment = d.split("-").pop() ?? d;
		byExperiment.set(experiment, path.join(RESULTS_DIR, d));
	}
	return Array.from(byExperiment.values());
}

interface Row {
	category: string;
	measured: string;
	n: string;
}

function rowsFor(run: Run): Row[] {
	const it = run.items;
	const rows: Row[] = [];
	const add = (
		category: string,
		agg: { value: number | null; n: number; excluded: number },
	) => {
		rows.push({
			category,
			measured: pct(agg.value),
			n: agg.excluded > 0 ? `${agg.n} (${agg.excluded} excluded)` : String(agg.n),
		});
	};

	switch (run.manifest.experiment) {
		case "baseline": {
			add("Retrieval quality (hit rate@8)", meanDefined(it.map((i) => metric(i, "hit_rate_at_k"))));
			add("Retrieval quality (MRR)", meanDefined(it.map((i) => metric(i, "reciprocal_rank"))));
			add("Context recall@8", meanDefined(it.map((i) => metric(i, "context_recall_at_k"))));
			add("Context precision (CP@8)", meanDefined(it.map((i) => metric(i, "context_precision_at_k"))));
			add("Faithfulness", meanDefined(it.map((i) => metric(i, "faithfulness"))));
			add("Answer relevancy", meanDefined(it.map((i) => metric(i, "answer_relevancy"))));
			add("Citation correctness (claim support)", meanDefined(it.map((i) => metric(i, "citation_support"))));
			add("Citation validity (deterministic)", meanDefined(it.map((i) => metric(i, "citation_validity"))));
			// False-rejection rate: golden (answerable) questions that took a
			// fallback branch anyway — the control for the negative experiment.
			const falseRejections = it.filter((i) => i.fallback_taken !== null).length;
			rows.push({
				category: "False-rejection rate (answerable golden questions refused)",
				measured: pct(it.length === 0 ? null : falseRejections / it.length),
				n: String(it.length),
			});
			break;
		}
		case "ksweep": {
			for (const k of [3, 5, 8, 10]) {
				const at = (key: string) =>
					meanDefined(
						it.map((i) => {
							const sweep = i.k_sweep as Record<string, Record<string, number>> | undefined;
							const v = sweep?.[`k${k}`]?.[key];
							return typeof v === "number" ? v : null;
						}),
					);
				rows.push({ category: `hit rate@${k}`, measured: pct(at("hit_rate").value), n: String(it.length) });
				rows.push({ category: `context recall@${k}`, measured: pct(at("context_recall").value), n: String(it.length) });
				rows.push({ category: `context precision@${k}`, measured: pct(at("context_precision").value), n: String(it.length) });
			}
			break;
		}
		case "consistency": {
			add("Consistency (citation-set agreement ×5)", meanDefined(it.map((i) => metric(i, "citation_set_agreement"))));
			add("Consistency (TARr exact text ×5)", meanDefined(it.map((i) => metric(i, "tarr_exact_text_agreement"))));
			add("Answer equivalence among citation-disagreeing pairs", meanDefined(it.map((i) => metric(i, "equivalence_rate"))));
			break;
		}
		case "paraphrase": {
			const jaccards: number[] = [];
			const equivalents: Array<number | null> = [];
			const stable: number[] = [];
			for (const i of it) {
				for (const p of (i.paraphrases ?? []) as Array<{ metrics: Record<string, unknown> }>) {
					const m = p.metrics;
					if (typeof m.retrieval_jaccard === "number") jaccards.push(m.retrieval_jaccard);
					if (typeof m.citation_set_stable === "number") stable.push(m.citation_set_stable);
					equivalents.push(typeof m.answer_equivalent === "boolean" ? (m.answer_equivalent ? 1 : 0) : null);
				}
			}
			add("Paraphrase retrieval Jaccard", meanDefined(jaccards));
			add("Paraphrase answer-equivalence rate", meanDefined(equivalents));
			add("Paraphrase citation-set stability", meanDefined(stable));
			break;
		}
		case "negative": {
			add("Negative rejection", meanDefined(it.map((i) => metric(i, "rejection_success"))));
			const fabricated = it.filter((i) => (metric(i, "fabricated_citations") ?? 0) > 0).length;
			rows.push({
				category: "Fabricated citations inside a rejection (must be 0)",
				measured: String(fabricated),
				n: String(it.length),
			});
			const layers = new Map<string, number>();
			for (const i of it) {
				const layer = (i.metrics as { layer?: string } | undefined)?.layer ?? "unknown";
				layers.set(layer, (layers.get(layer) ?? 0) + 1);
			}
			rows.push({
				category: "Rejection layer that fired",
				measured: Array.from(layers.entries()).map(([l, n]) => `${l}: ${n}`).join(", "),
				n: String(it.length),
			});
			break;
		}
	}
	return rows;
}

function main(): void {
	const argv = process.argv.slice(2);
	const mixed = argv.includes("--mixed");
	const allowPartial = argv.includes("--allow-partial");
	const outIdx = argv.indexOf("--out");
	const out = outIdx >= 0 ? argv[outIdx + 1] : null;
	const dirs = argv.filter(
		(a, i) => !a.startsWith("--") && !(outIdx >= 0 && i === outIdx + 1),
	);

	const targets = dirs.length > 0 ? dirs : latestRuns();
	if (targets.length === 0) {
		throw new Error(
			`No result dirs found under ${RESULTS_DIR}/. Run \`bun run eval:rag --experiment baseline\` first.`,
		);
	}

	const runs: Run[] = [];
	for (const d of targets) {
		const run = loadRun(d);
		if (!run) {
			console.error(`skip ${d} — no manifest.json/items.jsonl`);
			continue;
		}
		if (run.manifest.aborted && !allowPartial) {
			console.error(`skip ${d} — run ABORTED (cost cap). Pass --allow-partial to fold it anyway.`);
			continue;
		}
		runs.push(run);
	}
	if (runs.length === 0) throw new Error("No foldable runs.");

	const versions = new Set(runs.map((r) => r.manifest.prompt_version));
	if (versions.size > 1 && !mixed) {
		throw new Error(
			`Runs span multiple PROMPT_VERSIONs (${Array.from(versions).join(", ")}). ` +
				"Scores are only comparable within one prompt version — re-run, or pass " +
				"--mixed if you accept the mixture (Edge case 5).",
		);
	}

	const lines: string[] = [];
	lines.push("# RAG eval — aggregate report");
	lines.push("");
	lines.push(`Generated: ${new Date().toISOString()}`);
	lines.push(`PROMPT_VERSION: ${Array.from(versions).join(", ")}`);
	lines.push(
		`Runs folded: ${runs.map((r) => `${r.manifest.experiment} (${r.manifest.items} items)`).join(", ")}`,
	);
	lines.push("");
	lines.push(
		"Metric definitions, expected ranges, and their citations: " +
			"`docs/orchestration/research/rag-eval-metrics.md`.",
	);
	lines.push("");
	lines.push("## Scores");
	lines.push("");
	lines.push("| Category | Measured | n | Expected / realistic range | Source |");
	lines.push("|---|---|---|---|---|");
	for (const run of runs) {
		for (const row of rowsFor(run)) {
			const exp = EXPECTED[row.category];
			lines.push(
				`| ${row.category} | ${row.measured} | ${row.n} | ${exp?.range ?? "—"} | ${exp?.source ?? "—"} |`,
			);
		}
	}
	lines.push("");
	lines.push("## Cost appendix");
	lines.push("");
	lines.push("| Run | Total $ | Answerer (est.) | Judge | Embeddings | Judge errors | Aborted |");
	lines.push("|---|---|---|---|---|---|---|");
	let grand = 0;
	for (const run of runs) {
		const c = run.manifest.cost;
		grand += c.totalUsd;
		const errs = Object.entries(run.manifest.judge_errors ?? {})
			.filter(([, n]) => n > 0)
			.map(([k, n]) => `${k}: ${n}`)
			.join(", ");
		lines.push(
			`| ${run.manifest.experiment} | $${c.totalUsd.toFixed(4)} | ` +
				`$${(c.byKind.answerer_estimated?.usd ?? 0).toFixed(4)} | ` +
				`$${(c.byKind.judge?.usd ?? 0).toFixed(4)} | ` +
				`$${(c.byKind.embeddings?.usd ?? 0).toFixed(4)} | ${errs || "none"} | ${run.manifest.aborted} |`,
		);
	}
	lines.push(`| **TOTAL** | **$${grand.toFixed(4)}** | | | | | |`);
	lines.push("");
	lines.push(
		"Answerer + server-embedding costs are ESTIMATED with tiktoken (the SSE stream carries " +
			"no `usage` field); judge and eval-side embedding costs are ACTUAL API `usage` counts.",
	);
	lines.push("");

	const md = lines.join("\n");
	if (out) {
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, `${md}\n`);
		console.log(`wrote ${out}`);
	} else {
		console.log(md);
	}
}

try {
	main();
} catch (err) {
	console.error(`\nFAILED — ${(err as Error).message}`);
	process.exit(1);
}
