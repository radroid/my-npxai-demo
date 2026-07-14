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

// PR #8 fix round 1 — honest denominators. A metric that cannot be honestly
// computed prints "n/a", never a number. Every aggregated row carries `n` (the
// samples actually counted) AND, where any sample was dropped, how many and
// WHY. Two classes of exclusion exist and both are now visible:
//   - Zero-citation answers are excluded from citation VALIDITY (issue 1) and
//     surfaced by the "Citation coverage" row. They used to be scored 1.0 —
//     making the validity row read ~100% precisely when citations disappeared.
//   - OOS/guard refusals emit no envelope, so retrieval quality is not
//     measurable for them (issue 7b). They used to be scored 0. Both directions
//     of silent fudging are dishonest; both are now exclusions with a reason.

import fs from "node:fs";
import path from "node:path";
import { RESULTS_DIR } from "./config";
import { REFUSAL_BRANCHES } from "./metrics";

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
	/** Fix round 3, issue 2 — guard-rejected / malformed responses, counted
	 *  separately from judge_errors and from any refusal-branch count. */
	hard_errors?: number;
	daily_cap_headroom_at_start?: {
		available: boolean;
		remaining: number;
		cap: number;
	} | null;
	projected_daily_cap_calls?: number;
}

export interface Run {
	dir: string;
	manifest: Manifest;
	items: Record<string, unknown>[];
}

// Expected ranges + citations, verbatim from the research doc's
// §Realistic score expectations table. Do not edit without editing that doc.
const EXPECTED: Record<string, { range: string; source: string }> = {
	// Row labels NAME the pipeline stage each metric scores (fix round 2, issue
	// 2). A retrieval number is meaningless without it: the same question has a
	// different hit rate over the raw candidate pool, over the eligible
	// post-filter pool, and over the envelope the model was actually shown.
	"Retrieval quality — hit rate@8 [stage: envelope shown to the LLM]": {
		range: "context recall ≥ 0.85 target",
		source: "OpenAI evaluation best practices",
	},
	"Retrieval quality — MRR [stage: post-filter similarity-ranked pool]": {
		range: "rank of the first gold chunk among production-eligible candidates",
		source: "IR-book ch.8; OpenAI cookbook",
	},
	"Context recall@8 [stage: envelope shown to the LLM]": {
		range: "≥ 0.85",
		source: "OpenAI evaluation best practices",
	},
	"Context precision CP@8 [stage: envelope shown to the LLM, prompt order]": {
		range: "> 0.70",
		source: "OpenAI evaluation best practices (RAGAS retrieved_contexts)",
	},
	"Trace/server envelope agreement (offline trace reproduces the served envelope)":
		{
			range: "1.00 expected — below it, the pool-stage metric describes a different retrieval",
			source: "integrity check; deterministic",
		},
	Faithfulness: {
		range: "0.85–0.90 good; 0.95–0.98 gate for citation-critical domains",
		source: "qaskills; legal RAG case study 2026",
	},
	"Answer relevancy": {
		range: "high-0.8s+ when retrieval works",
		source: "RAGAS docs; qaskills",
	},
	"Answer relevancy coverage (model was invoked — excludes oos_or_guard / hard-error route constants)":
		{
			range:
				"companion to relevancy — undefined when the route made no LLM call at all, never a pass or a fail",
			source: "custom metric; deterministic",
		},
	"Hard errors (guard-rejected / malformed — never scored as model behaviour)": {
		range: "0 expected — any non-zero count means the server broke or rejected a curated question",
		source: "custom metric; deterministic (fix round 3, issue 2)",
	},
	"Citation correctness (claim support)": {
		range: "no published standard — read against the faithfulness gate (0.95+)",
		source: "custom metric; research doc §Recommended set #5",
	},
	"Citation validity (deterministic)": {
		range: "1.00 expected — any invalid citation is a fabricated pointer",
		source: "custom metric; deterministic",
	},
	"Citation coverage (answers carrying ≥ 1 citation)": {
		range:
			"companion to validity — validity is UNDEFINED for a zero-citation answer, never a pass",
		source: "custom metric; deterministic",
	},
	"Claim coverage (answers making ≥ 1 verifiable claim)": {
		range:
			"companion to faithfulness — faithfulness is UNDEFINED for an answer that claims nothing (a refusal claims nothing)",
		source: "custom metric; RAGAS no-claims case",
	},
	"Cited-claim coverage (answers making ≥ 1 CITED claim)": {
		range: "companion to claim support — undefined when the answer cites nothing",
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
	"Citation coverage across repeats (repeats carrying ≥ 1 citation)": {
		range:
			"companion to citation-set agreement — agreement is UNDEFINED when no repeat cited, never a pass",
		source: "custom metric; deterministic",
	},
	"Paraphrase retrieval Jaccard": {
		range: "no canonical threshold — track deltas over time",
		source: "arXiv 2604.10745; REAL-MM-RAG",
	},
	"Paraphrase envelope coverage (both sides retrieved something)": {
		range:
			"companion to Jaccard — an empty-vs-empty overlap is undefined, never 1.0",
		source: "custom metric; deterministic",
	},
	"Paraphrase citation coverage (both sides cited ≥ 1)": {
		range:
			"companion to citation-set stability — undefined when either side cited nothing",
		source: "custom metric; deterministic",
	},
	"Paraphrase answer coverage (neither side refused)": {
		range:
			"companion to answer-equivalence — two refusals are not a robust answer",
		source: "custom metric; deterministic",
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
 * (judge errors, no-claims items, zero-citation answers, unmeasurable
 * retrieval). Returns the count kept AND the count dropped, so no row can print
 * a percentage whose denominator silently swallowed the vacuous cases. */
export function meanDefined(values: Array<number | null | undefined>): {
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

export interface Row {
	category: string;
	measured: string;
	n: string;
	/** How many samples were dropped from the denominator, and why. */
	excluded: string;
}

export function rowsFor(run: Run): Row[] {
	const it = run.items;
	const rows: Row[] = [];
	/** Aggregated row. `n` is the denominator that produced `measured`; any
	 *  sample not in it is reported under `excluded` with its reason. */
	const add = (
		category: string,
		agg: { value: number | null; n: number; excluded: number },
		why = "not measurable (judge error / no claims)",
	) => {
		rows.push({
			category,
			measured: pct(agg.value),
			n: String(agg.n),
			excluded: agg.excluded > 0 ? `${agg.excluded} — ${why}` : "0",
		});
	};
	/** Row whose value is a plain count/label, not a mean over a denominator. */
	const addCount = (category: string, measured: string, n: number) => {
		rows.push({ category, measured, n: String(n), excluded: "0" });
	};

	switch (run.manifest.experiment) {
		case "baseline": {
			// Each retrieval row NAMES the stage it scores (issue 2), and is NULL —
			// excluded, never 0 — where that stage does not exist for the item (OOS /
			// guard refusal emits no envelope and no eligible pool). Issue 7b.
			const noEnvelope =
				"OOS/guard refusal — the route emitted NO envelope, so what-the-LLM-saw is not measurable (never scored 0); or the item has no gold chunk";
			const noPool =
				"OOS gate — no MIN_CHUNK_SIM-eligible candidate pool to rank (never scored 0); or the offline trace failed";
			add(
				"Retrieval quality — hit rate@8 [stage: envelope shown to the LLM]",
				meanDefined(it.map((i) => metric(i, "hit_rate_at_k"))),
				noEnvelope,
			);
			add(
				"Retrieval quality — MRR [stage: post-filter similarity-ranked pool]",
				meanDefined(it.map((i) => metric(i, "reciprocal_rank"))),
				noPool,
			);
			add(
				"Context recall@8 [stage: envelope shown to the LLM]",
				meanDefined(it.map((i) => metric(i, "context_recall_at_k"))),
				noEnvelope,
			);
			add(
				"Context precision CP@8 [stage: envelope shown to the LLM, prompt order]",
				meanDefined(it.map((i) => metric(i, "context_precision_at_k"))),
				noEnvelope,
			);
			add(
				"Trace/server envelope agreement (offline trace reproduces the served envelope)",
				meanDefined(it.map((i) => metric(i, "trace_envelope_agrees"))),
				"no envelope served, or no trace — nothing to compare",
			);
			add("Faithfulness", meanDefined(it.map((i) => metric(i, "faithfulness"))), "judge error, or answer made no verifiable claim");
			// Full-denominator companion: without it, faithfulness could read 100% over
			// a handful of items while every refusal silently left the denominator —
			// the same vacuous-pass shape as citation validity. Read the two together.
			add(
				"Claim coverage (answers making ≥ 1 verifiable claim)",
				meanDefined(it.map((i) => metric(i, "faithfulness_claim_coverage"))),
			);
			add(
				"Answer relevancy",
				meanDefined(it.map((i) => metric(i, "answer_relevancy"))),
				"judge error, or the route made NO LLM call at all (oos_or_guard / hard error) — the scored text would not be model output",
			);
			// Full-denominator companion (fix round 3, issue 1): makes visible how
			// many items were structurally excluded because the route never called
			// the model — as opposed to a GENUINE model refusal (llm_refusal /
			// low_confidence), which IS scored above, RAGAS-style, low by design.
			add(
				"Answer relevancy coverage (model was invoked — excludes oos_or_guard / hard-error route constants)",
				meanDefined(it.map((i) => metric(i, "relevancy_measurable"))),
			);
			add(
				"Citation correctness (claim support)",
				meanDefined(it.map((i) => metric(i, "citation_support"))),
				"judge error, or answer carried no cited claim",
			);
			add(
				"Cited-claim coverage (answers making ≥ 1 CITED claim)",
				meanDefined(it.map((i) => metric(i, "citation_support_claim_coverage"))),
			);
			// Issue 1: zero-citation answers are EXCLUDED from validity (score is
			// null), not counted as 1.0. The coverage row below is what makes them
			// visible — read the two together or you are reading a lie.
			add(
				"Citation validity (deterministic)",
				meanDefined(it.map((i) => metric(i, "citation_validity"))),
				"answer contained ZERO citations — validity is undefined, not a pass (see coverage row)",
			);
			add(
				"Citation coverage (answers carrying ≥ 1 citation)",
				meanDefined(it.map((i) => metric(i, "citation_coverage"))),
			);
			// False-rejection rate: golden (answerable) questions the pipeline
			// REFUSED. The route's limited-context disclaimer is NOT a refusal (the
			// model still answers), so it does not count here — issue 2.
			//
			// Fix round 3, issue 2: a HARD ERROR (guard-rejected / malformed) is
			// EXCLUDED from both the numerator and the denominator — the server
			// failed, so this item is neither "answered" nor "refused"; counting
			// it in the denominator would silently dilute the rate with a
			// question that was never actually put to the model.
			const rejectionEligible = it.filter((i) => !i.hard_error_reason);
			const refusedItems = rejectionEligible.filter((i) =>
				REFUSAL_BRANCHES.has(String(i.fallback_taken ?? "")),
			).length;
			const hardErrorCount = it.length - rejectionEligible.length;
			rows.push({
				category: "False-rejection rate (answerable golden questions refused)",
				measured: pct(
					rejectionEligible.length === 0 ? null : refusedItems / rejectionEligible.length,
				),
				n: String(rejectionEligible.length),
				excluded:
					hardErrorCount > 0
						? `${hardErrorCount} — hard error (guard-rejected / malformed): neither answered nor refused`
						: "0",
			});
			// Branch census — every item lands in exactly one bucket, so a reader can
			// reconcile the exclusions above against the run. A hard error gets its
			// OWN bucket, never "normal_answer" (fallback_taken is null for both, and
			// they must not be conflated — issue 2).
			const branches = new Map<string, number>();
			for (const i of it) {
				const b = i.hard_error_reason
					? "hard_error"
					: String(i.fallback_taken ?? "normal_answer");
				branches.set(b, (branches.get(b) ?? 0) + 1);
			}
			addCount(
				"Route branch census (which path produced each answer)",
				Array.from(branches.entries())
					.map(([b, n]) => `${b}: ${n}`)
					.join(", ") || "—",
				it.length,
			);
			// Fix round 3, issue 2: hard errors, counted and reported SEPARATELY —
			// never as a refusal, never silently folded into any other row's
			// exclusion reason.
			addCount(
				"Hard errors (guard-rejected / malformed — never scored as model behaviour)",
				String(hardErrorCount),
				it.length,
			);
			break;
		}
		case "ksweep": {
			// Every k row scores the ENVELOPE the route would select at that k —
			// stage-named (issue 2). OOS items are EXCLUDED at every k: the gate fires
			// on the raw pool's top-1 and is k-independent, so the route builds no
			// envelope at any k. Scoring them against the candidate pool the route
			// refused to surface would print a hit rate for chunks nobody was shown —
			// and would also vary the denominator across k, which alone would make the
			// across-k comparison the sweep exists for ill-formed.
			const oosExcluded =
				"OOS gate — the route builds NO envelope at any k (k-independent), or the item has no gold chunk";
			for (const k of [3, 5, 8, 10]) {
				const at = (key: string) =>
					meanDefined(
						it.map((i) => {
							const sweep = i.k_sweep as
								| Record<string, Record<string, number | null>>
								| undefined;
							const v = sweep?.[`k${k}`]?.[key];
							return typeof v === "number" ? v : null;
						}),
					);
				add(`hit rate@${k} [stage: envelope@${k}]`, at("hit_rate"), oosExcluded);
				add(`context recall@${k} [stage: envelope@${k}]`, at("context_recall"), oosExcluded);
				add(`context precision@${k} [stage: envelope@${k}]`, at("context_precision"), oosExcluded);
			}
			// MRR is k-INDEPENDENT — it ranks the post-filter candidate pool, which the
			// envelope size does not touch. It used to be printed inside the per-k
			// block over the k-truncated envelope, implying a k-sensitivity the metric
			// does not have.
			add(
				"MRR [stage: post-filter similarity-ranked pool — k-independent]",
				meanDefined(it.map((i) => metric(i, "reciprocal_rank"))),
				oosExcluded,
			);
			break;
		}
		case "consistency": {
			// Issue 1a. citationSetKey used to return "" for a zero-citation answer, so
			// totalAgreement over N repeats that ALL cited nothing returned a PERFECT 1
			// — the headline stability KPI read 100% precisely when the model cited
			// nothing at all, N times. Those items are EXCLUDED now, and the coverage
			// row below is what makes them visible. Read the two together.
			add(
				"Consistency (citation-set agreement ×5)",
				meanDefined(it.map((i) => metric(i, "citation_set_agreement"))),
				"every repeat cited nothing — there is no citation SET to agree about, so agreement is undefined, NOT a pass (see the coverage row)",
			);
			add(
				"Consistency (TARr exact text ×5)",
				meanDefined(it.map((i) => metric(i, "tarr_exact_text_agreement"))),
				"every repeat took the guard/OOS branch, where the route emits a CONSTANT string and never calls the model — agreement would be 1 by construction, measuring nothing",
			);
			add(
				"Citation coverage across repeats (repeats carrying ≥ 1 citation)",
				meanDefined(it.map((i) => metric(i, "citation_coverage_across_repeats"))),
			);
			add(
				"Answer equivalence among citation-disagreeing pairs",
				meanDefined(it.map((i) => metric(i, "equivalence_rate"))),
				"no citation-disagreeing pair to judge (the deterministic KPI already agreed), or judge error",
			);
			break;
		}
		case "paraphrase": {
			// Issue 1b. This experiment had NONE of the exclude-with-reason discipline:
			// jaccard(∅,∅) === 1 scored two refusals as PERFECT retrieval stability;
			// "" === "" gave a free citation-stability 1 when both sides cited nothing;
			// and the equivalence rubric literally calls two refusals "equivalent". All
			// three are excluded now, and the three coverage rows over the FULL
			// denominator are what keep the exclusions honest.
			const jaccards: Array<number | null> = [];
			const equivalents: Array<number | null> = [];
			const stable: Array<number | null> = [];
			const envCoverage: Array<number | null> = [];
			const citeCoverage: Array<number | null> = [];
			const answerCoverage: Array<number | null> = [];
			const num = (v: unknown): number | null =>
				typeof v === "number" ? v : null;
			for (const i of it) {
				for (const p of (i.paraphrases ?? []) as Array<{ metrics: Record<string, unknown> }>) {
					const m = p.metrics;
					jaccards.push(num(m.retrieval_jaccard));
					stable.push(num(m.citation_set_stable));
					equivalents.push(
						typeof m.answer_equivalent === "boolean"
							? m.answer_equivalent
								? 1
								: 0
							: null,
					);
					envCoverage.push(num(m.both_sides_have_envelope));
					citeCoverage.push(num(m.both_sides_cited));
					answerCoverage.push(num(m.both_sides_answered));
				}
			}
			add(
				"Paraphrase retrieval Jaccard",
				meanDefined(jaccards),
				"one or both sides retrieved NOTHING — an empty-vs-empty overlap is not 1.0, it is undefined (see envelope coverage)",
			);
			add(
				"Paraphrase answer-equivalence rate",
				meanDefined(equivalents),
				"one or both sides REFUSED — two refusals are not a robust answer (the judge's rubric would call them 'equivalent'); or judge error",
			);
			add(
				"Paraphrase citation-set stability",
				meanDefined(stable),
				"one or both sides cited NOTHING — there is no citation set to compare, so stability is undefined, NOT a pass",
			);
			add("Paraphrase envelope coverage (both sides retrieved something)", meanDefined(envCoverage));
			add("Paraphrase citation coverage (both sides cited ≥ 1)", meanDefined(citeCoverage));
			add("Paraphrase answer coverage (neither side refused)", meanDefined(answerCoverage));
			break;
		}
		case "negative": {
			add(
				"Negative rejection",
				meanDefined(it.map((i) => metric(i, "rejection_success"))),
				"a 200 that streamed NO text — neither a refusal nor an answer, so not measurable (scoring it 0 would be a false FAILURE)",
			);
			const fabricated = it.filter((i) => (metric(i, "fabricated_citations") ?? 0) > 0).length;
			addCount("Fabricated citations inside a rejection (must be 0)", String(fabricated), it.length);
			const layers = new Map<string, number>();
			for (const i of it) {
				const layer = (i.metrics as { layer?: string } | undefined)?.layer ?? "unknown";
				layers.set(layer, (layers.get(layer) ?? 0) + 1);
			}
			addCount(
				"Rejection layer that fired",
				Array.from(layers.entries()).map(([l, n]) => `${l}: ${n}`).join(", ") || "—",
				it.length,
			);
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
	lines.push(
		"`n` is the denominator that produced `Measured` — the samples actually counted. " +
			"`Excluded` is every sample dropped from it, with the reason. A metric that cannot be " +
			"honestly computed prints `n/a`; it is never given a number. In particular: citation " +
			"validity is UNDEFINED (not 1.0) for an answer that cites nothing — read it together " +
			"with citation coverage — and retrieval quality is UNDEFINED (not 0) for a question the " +
			"route refused before building an envelope.",
	);
	lines.push("");
	lines.push("| Category | Measured | n | Excluded (why) | Expected / realistic range | Source |");
	lines.push("|---|---|---|---|---|---|");
	for (const run of runs) {
		for (const row of rowsFor(run)) {
			const exp = EXPECTED[row.category];
			lines.push(
				`| ${row.category} | ${row.measured} | ${row.n} | ${row.excluded} | ${exp?.range ?? "—"} | ${exp?.source ?? "—"} |`,
			);
		}
	}
	lines.push("");
	lines.push(
		"**Stage note (read before any retrieval number).** The pipeline has three distinct " +
			"retrieval stages and the same question scores differently at each, so every retrieval " +
			"row above names the one it scores:",
	);
	lines.push("");
	lines.push(
		"- **raw candidate pool** — the unfiltered `match_regdoc_chunks` merge, in cosine order. " +
			"Production NEVER shows this to the model. **No reported metric scores it**; it is logged " +
			"per item for diagnosis only.",
	);
	lines.push(
		"- **post-filter similarity-ranked pool** — the same list with `MIN_CHUNK_SIM` applied: the " +
			"candidates production could actually surface. This is what **MRR** ranks. A rank metric " +
			"needs a genuine ranking (the envelope is diversity-reordered and named-doc-boosted, so " +
			"it is not one), but ranking chunks *below* the filter would credit the retriever with a " +
			"rank the pipeline discards.",
	);
	lines.push(
		"- **envelope** — what the route actually feeds the LLM, in prompt order. This is RAGAS's " +
			"`retrieved_contexts`, and it is what **hit rate, context recall, and context precision** " +
			"score. Its noise is the noise that causes generation errors, which is the whole reason " +
			"context precision exists.",
	);
	lines.push("");
	lines.push(
		"On the OOS branch the route refuses and builds **no envelope and no eligible pool** — so " +
			"both stages are empty and every retrieval row EXCLUDES those items (never scores them 0). " +
			"In the `ksweep` the exclusion also keeps the denominator constant across k, without which " +
			"comparing k values is not well-formed. The `Trace/server envelope agreement` row is the " +
			"integrity check that the offline trace supplying the pool stage reproduces the envelope " +
			"the server actually served; below 1.00, the MRR row is describing a different retrieval " +
			"than the one that produced the answers.",
	);
	lines.push("");
	lines.push("## Cost appendix");
	lines.push("");
	lines.push("| Run | Total $ | Answerer (est.) | Judge | Embeddings | Judge errors | Hard errors | Aborted |");
	lines.push("|---|---|---|---|---|---|---|---|");
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
				`$${(c.byKind.embeddings?.usd ?? 0).toFixed(4)} | ${errs || "none"} | ` +
				`${run.manifest.hard_errors ?? 0} | ${run.manifest.aborted} |`,
		);
	}
	lines.push(`| **TOTAL** | **$${grand.toFixed(4)}** | | | | | | |`);
	lines.push("");
	lines.push(
		"**Hard errors** (fix round 3, issue 2) are guard-rejected (4xx) or malformed (empty-body/" +
			"unparseable-stream) responses — counted here SEPARATELY from judge errors and NEVER folded " +
			"into a refusal branch or a silent exclusion. `askServer` throws and aborts the run outright " +
			"on any 5xx (a transport/server failure), so an outage cannot appear in this table at all — " +
			"it stops the run before any item reaches it.",
	);
	lines.push("");
	lines.push(
		"Answerer + server-embedding costs are ESTIMATED with tiktoken (the SSE stream carries " +
			"no `usage` field); judge and eval-side embedding costs are ACTUAL API `usage` counts. " +
			"The answerer estimate is taken over the RECONSTRUCTED REAL PROMPT — full `chunk_text` " +
			"re-fetched by id and re-wrapped with the production `buildContextEnvelope` — not the " +
			"260-char display snippet in the SSE frame, which under-counted the model's true input " +
			"by roughly 4-6×. The route's own embedding call (query + every expansion, made inside " +
			"the dev server) is counted EXACTLY, by calling the same pure `embeddingInputsFor()` " +
			"production calls — it used to be charged as `question × 5`, a constant billed as a " +
			"ceiling that a multi-doc query walks straight past. The only component still charged " +
			"by a factor is a chunk whose full text could not be re-fetched, and that factor ERRS " +
			"HIGH by construction. This number may over-state spend, never under-state it.",
	);
	lines.push("");
	lines.push("## Production budget impact");
	lines.push("");
	lines.push(
		"Retrieval-path eval calls are isolated from production: they pass a no-op `recordUsage` " +
			"into `lib/retrieval.ts`, so they never increment the shared daily OpenAI counter. " +
			"The ANSWER harness is a different story and is NOT isolated — by design it POSTs the " +
			"REAL production route (that is the only way generation metrics score the real path), " +
			"and `x-eval-bypass` skips the circuit-breaker CHECK but not its INCREMENT. A " +
			"server-backed battery therefore consumes the same `GLOBAL_DAILY_CAP` (2000 calls/day) " +
			"that real users share, at ~2 calls per question. The runner now reads that headroom in " +
			"PREFLIGHT and refuses to start a run the budget cannot absorb.",
	);
	lines.push("");
	lines.push("| Run | Headroom at start | Projected calls |");
	lines.push("|---|---|---|");
	for (const run of runs) {
		const h = run.manifest.daily_cap_headroom_at_start;
		const projected = run.manifest.projected_daily_cap_calls ?? 0;
		lines.push(
			`| ${run.manifest.experiment} | ${
				h?.available ? `${h.remaining} of ${h.cap} left` : "unreadable"
			} | ${projected || "0 (no server calls)"} |`,
		);
	}
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

// Only run the CLI when invoked directly (`bun run eval:rag:report`). The
// offline self-test IMPORTS rowsFor/meanDefined to assert the aggregation never
// prints a percentage over a silently-padded denominator (fix round 1), and an
// import must not execute the CLI.
if (import.meta.main) {
	try {
		main();
	} catch (err) {
		console.error(`\nFAILED — ${(err as Error).message}`);
		process.exit(1);
	}
}
