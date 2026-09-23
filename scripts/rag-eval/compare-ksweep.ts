#!/usr/bin/env bun
// Compare two saved k-sweep runs question by question. Reads only local logs;
// no database, embeddings, or judge calls. Both runs must use the same golden
// set, embedding model, k and retrieval thresholds.
//
// bun run eval:rag:compare --baseline=evals/results/<old>-ksweep \
//   --candidate=evals/results/<new>-ksweep --only=h006,s007

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Manifest {
	items: number;
	golden_set: { sha256: string };
	models: { embedding: string };
	config: { k: number; thresholds: Record<string, number> };
}

interface Item {
	question_id: string;
	question: string;
	gold_chunk_ids: number[];
	stages: { post_filter_ranked_ids: number[] };
	k_sweep: { k8: { hit_rate: number | null; context_recall: number | null } };
	metrics: { reciprocal_rank: number | null };
	pool: Array<{ regdoc_id: string }>;
}

function optionalValue(name: string): string | undefined {
	return process.argv
		.slice(2)
		.find((arg) => arg.startsWith(`${name}=`))
		?.slice(name.length + 1);
}

function option(name: string): string {
	const value = optionalValue(name);
	if (!value) throw new Error(`Pass ${name}=<ksweep-run-directory>`);
	return value;
}

function readRun(dir: string): {
	manifest: Manifest;
	items: Map<string, Item>;
} {
	const manifest = JSON.parse(
		readFileSync(join(dir, "manifest.json"), "utf8"),
	) as Manifest;
	const items = new Map<string, Item>();
	for (const line of readFileSync(join(dir, "items.jsonl"), "utf8").split(
		"\n",
	)) {
		if (!line.trim()) continue;
		const item = JSON.parse(line) as Item;
		if (items.has(item.question_id))
			throw new Error(`Duplicate question: ${item.question_id}`);
		items.set(item.question_id, item);
	}
	if (items.size !== manifest.items) {
		throw new Error(
			`${dir}: manifest says ${manifest.items} items, log has ${items.size}`,
		);
	}
	return { manifest, items };
}

function mean(values: Array<number | null>): number {
	const valid = values.filter((value): value is number => value !== null);
	if (valid.length === 0)
		throw new Error("No scored values in selected questions");
	return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function requiredItem(items: Map<string, Item>, id: string): Item {
	const item = items.get(id);
	if (!item) throw new Error(`Missing question: ${id}`);
	return item;
}

function percentage(value: number): string {
	return `${(100 * value).toFixed(1)}%`;
}

function hasGoldInPool(item: Item): boolean {
	const gold = new Set(item.gold_chunk_ids);
	return item.stages.post_filter_ranked_ids.some((id) => gold.has(id));
}

function transportTopEight(item: Item): number {
	return item.pool
		.slice(0, 8)
		.filter((chunk) => chunk.regdoc_id.startsWith("REGDOC-2.14.1")).length;
}

function main(): void {
	const baseline = readRun(option("--baseline"));
	const candidate = readRun(option("--candidate"));
	const only = new Set(optionalValue("--only")?.split(",").filter(Boolean));
	const excluded = new Set(
		optionalValue("--exclude")?.split(",").filter(Boolean),
	);
	const included = (id: string) =>
		(only.size === 0 || only.has(id)) && !excluded.has(id);
	const a = baseline.manifest;
	const b = candidate.manifest;
	if (
		a.golden_set.sha256 !== b.golden_set.sha256 ||
		a.models.embedding !== b.models.embedding ||
		a.config.k !== b.config.k ||
		JSON.stringify(a.config.thresholds) !== JSON.stringify(b.config.thresholds)
	) {
		throw new Error(
			"Runs differ in golden set, embedding model, k, or thresholds",
		);
	}
	const oldItems = [...baseline.items.values()].filter((item) =>
		included(item.question_id),
	);
	const candidateIds = [...candidate.items.keys()].filter(included);
	if (
		oldItems.length !== candidateIds.length ||
		oldItems.some((item) => !candidate.items.has(item.question_id))
	) {
		throw new Error("Runs contain different question IDs");
	}

	if (oldItems.length === 0)
		throw new Error("No questions remain after exclusions");
	const newItems = oldItems.map((item) =>
		requiredItem(candidate.items, item.question_id),
	);
	console.log(
		`Compared ${oldItems.length} identical questions (saved logs; no API calls)${excluded.size ? `; excluded: ${[...excluded].join(", ")}` : ""}`,
	);
	for (const [label, key] of [
		["Hit@8", "hit_rate"],
		["Context recall@8", "context_recall"],
	] as const) {
		const oldValue = mean(oldItems.map((item) => item.k_sweep.k8[key]));
		const newValue = mean(newItems.map((item) => item.k_sweep.k8[key]));
		console.log(
			`${label}: ${percentage(oldValue)} → ${percentage(newValue)} (${((newValue - oldValue) * 100).toFixed(1)} pp)`,
		);
	}
	const oldMrr = mean(oldItems.map((item) => item.metrics.reciprocal_rank));
	const newMrr = mean(newItems.map((item) => item.metrics.reciprocal_rank));
	console.log(
		`MRR: ${percentage(oldMrr)} → ${percentage(newMrr)} (${((newMrr - oldMrr) * 100).toFixed(1)} pp)`,
	);
	console.log(
		`Gold in post-filter pool: ${oldItems.filter(hasGoldInPool).length} → ${newItems.filter(hasGoldInPool).length}`,
	);
	console.log(
		`Transport chunks in top eight: ${oldItems.reduce((n, item) => n + transportTopEight(item), 0)} → ${newItems.reduce((n, item) => n + transportTopEight(item), 0)}`,
	);

	const changed = oldItems.flatMap((oldItem) => {
		const newItem = requiredItem(candidate.items, oldItem.question_id);
		const oldHit = oldItem.k_sweep.k8.hit_rate;
		const newHit = newItem.k_sweep.k8.hit_rate;
		if (oldHit === newHit) return [];
		return [
			{
				id: oldItem.question_id,
				oldHit,
				newHit,
				oldPool: hasGoldInPool(oldItem),
				newPool: hasGoldInPool(newItem),
				oldTransport: transportTopEight(oldItem),
				newTransport: transportTopEight(newItem),
			},
		];
	});
	console.log(`Hit@8 changes: ${changed.length}`);
	for (const item of changed) {
		console.log(
			`  ${item.id}: ${item.oldHit} → ${item.newHit}; gold in pool ${item.oldPool} → ${item.newPool}; transport top-8 ${item.oldTransport} → ${item.newTransport}`,
		);
	}
}

try {
	main();
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
