#!/usr/bin/env bun
// Prepare an isolated corpus variant. The generic "CNSC Regulatory Document
// Series" section is consolidated into one reference file and excluded from
// searchable document JSON. Existing Preface and §1.3 text is left untouched;
// the upstream fetcher had already filtered some from the 26 new documents.
//
// bun run scripts/rag-eval/prepare-shared-series.ts --out-dir=/tmp/rag-series

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface Section {
	section_number: string;
	section_title: string;
	paragraphs: Array<{ text: string }>;
}

interface Doc {
	regdoc_id: string;
	title: string;
	url: string;
	sections: Section[];
}

interface SharedVariant {
	sha256: string;
	text: string;
	sources: Array<{ regdoc_id: string; title: string; url: string }>;
}

function option(name: string): string | undefined {
	return process.argv
		.slice(2)
		.find((arg) => arg.startsWith(`${name}=`))
		?.slice(name.length + 1);
}

function isSharedSeries(section: Section): boolean {
	return (
		section.section_title.trim().toLowerCase() ===
		"cnsc regulatory document series"
	);
}

async function main(): Promise<void> {
	const sourceDir = resolve(option("--source-dir") ?? "scraped_regdocs");
	const outArg = option("--out-dir");
	if (!outArg) throw new Error("Pass --out-dir for a new, empty directory");
	const outDir = resolve(outArg);
	const referenceFile = option("--reference-file");
	const referencePath = referenceFile ? resolve(referenceFile) : null;
	if (outDir === sourceDir || outDir.startsWith(`${sourceDir}/`)) {
		throw new Error("Output must be outside the source corpus directory");
	}
	if (referencePath?.startsWith(`${sourceDir}/`)) {
		throw new Error(
			"Reference file must be outside the source corpus directory",
		);
	}
	await mkdir(outDir, { recursive: true });
	if ((await readdir(outDir)).length > 0) {
		throw new Error(`Output directory is not empty: ${outDir}`);
	}

	const files = (await readdir(sourceDir))
		.filter((name) => name.endsWith(".json") && !name.startsWith("_"))
		.sort();
	const variants = new Map<string, SharedVariant>();
	let removed = 0;
	for (const file of files) {
		const doc = JSON.parse(
			await readFile(join(sourceDir, file), "utf8"),
		) as Doc;
		if (!doc.regdoc_id || !Array.isArray(doc.sections)) {
			throw new Error(`Invalid document: ${file}`);
		}
		const kept: Section[] = [];
		for (const section of doc.sections) {
			if (!isSharedSeries(section)) {
				kept.push(section);
				continue;
			}
			removed++;
			const text = section.paragraphs
				.map((paragraph) => paragraph.text.trim())
				.filter(Boolean)
				.join("\n\n");
			const sha256 = createHash("sha256").update(text).digest("hex");
			const variant = variants.get(sha256) ?? { sha256, text, sources: [] };
			variant.sources.push({
				regdoc_id: doc.regdoc_id,
				title: doc.title,
				url: doc.url,
			});
			variants.set(sha256, variant);
		}
		await writeFile(
			join(outDir, file),
			`${JSON.stringify({ ...doc, sections: kept }, null, 2)}\n`,
		);
	}

	// The reference retains every distinct source wording and every original
	// document URL. It is deliberately not in the RAG index: its generic blurb
	// is useful for provenance but competes with substantive answers.
	const reference = {
		title: "CNSC Regulatory Document Series — shared administrative reference",
		note: "Distinct source wordings consolidated from the corpus. All Preface and relevant-legislation text present in the input remains untouched; the upstream fetcher had already filtered some new-document sections. This reference is not indexed for RAG retrieval.",
		sectionsRemoved: removed,
		variants: [...variants.values()].sort(
			(a, b) =>
				b.sources.length - a.sources.length || a.sha256.localeCompare(b.sha256),
		),
	};
	const referenceJson = `${JSON.stringify(reference, null, 2)}\n`;
	await writeFile(join(outDir, "_shared-series-reference.json"), referenceJson);
	if (referencePath) await writeFile(referencePath, referenceJson);
	console.log(
		`Prepared ${files.length} documents in ${outDir}; consolidated ${removed} series sections into ${variants.size} distinct source wordings.`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
