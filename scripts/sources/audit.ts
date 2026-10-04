// Phase 12 release audit (gate 5): does the database hold exactly what the
// register says it may, and nothing else?
//
//   bun run sources:audit             # register + DB consistency
//   bun run sources:audit --pages     # + PDF page-number spot check (needs corpus/.cache)
//   bun run sources:audit --strict    # warnings (e.g. overdue rights recheck) fail too
//   bun run sources:audit --force     # allow a non-local Supabase URL (read-only)
//
// Checks, each a hard failure unless marked (warn):
//   register  — cross-field rules (lib/sources/register.ts registerIssues);
//               rights recheck older than recheck_cadence_days (warn)
//   documents — every register entry has its row with the same status,
//               collection, kind, legal force, rights decision, checksum and
//               canonical URL; no DB row the register does not list
//   text      — metadata-only / not-ingested entries hold zero chunks; the
//               reference-only collections (IAEA, AERB, Fukushima) hold zero
//               chunks; chunk_count equals the real chunk count; every chunk
//               carries its document's collection
//   links     — every canonical and chunk locator URL passes the render-time
//               allowlist (lib/sources/catalog.ts isAllowedSourceUrl)
//   gates     — IAEA never searchable; a searchable collection with no current
//               text document (warn)
//   pages     — (--pages) sampled PDF chunks: the chunk's text is found on the
//               page range it cites, using an independent pdf.js extraction
// Writes corpus/reports/audit.json.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { COLLECTIONS, isAllowedSourceUrl } from "../../lib/sources/catalog";
import {
	daysSinceReview,
	type RegisterEntry,
	registerIssues,
} from "../../lib/sources/register";
import { checkClients, selectAll } from "./db";
import {
	cachePath,
	ensureDirs,
	entryId,
	readRegisterRaw,
	REPORTS_DIR,
} from "./register-io";

const argv = process.argv.slice(2);
const STRICT = argv.includes("--strict");
const PAGES = argv.includes("--pages");
const PAGE_SAMPLES_PER_DOC = 6;

interface Finding {
	check: string;
	level: "fail" | "warn";
	subject: string;
	message: string;
}

interface DocRow {
	id: number;
	document_key: string;
	version_key: string;
	collection: string;
	status: string;
	document_kind: string;
	legal_force: string;
	rights_decision: string;
	checksum_sha256: string | null;
	canonical_url: string;
	register_version: string;
	chunk_count: number;
	parser_version: string | null;
}

interface ChunkRow {
	id: number;
	document_id: number;
	collection: string;
	chunk_index: number;
	page_start: number | null;
	page_end: number | null;
	locator_url: string | null;
}

const findings: Finding[] = [];
const fail = (check: string, subject: string, message: string) =>
	findings.push({ check, level: "fail", subject, message });
const warn = (check: string, subject: string, message: string) =>
	findings.push({ check, level: "warn", subject, message });

/** Letters and digits only — immune to wrapping, hyphenation and spacing. */
function squash(s: string): string {
	return s
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
}

async function main() {
	await ensureDirs();
	// Raw read so a broken register is reported, not thrown.
	const register = await readRegisterRaw();
	const today = new Date();

	// ── register ──────────────────────────────────────────────────────────
	for (const i of registerIssues(register)) {
		fail("register", i.document_key, i.message);
	}
	for (const e of register.entries) {
		const days = daysSinceReview(e, today);
		if (days > register.recheck_cadence_days) {
			warn(
				"register",
				entryId(e),
				`rights reviewed ${days} days ago (cadence ${register.recheck_cadence_days})`,
			);
		}
	}

	// ── documents ─────────────────────────────────────────────────────────
	const { admin } = checkClients(argv, { needOpenAI: false });
	const docs = await selectAll<DocRow>((from, to) =>
		admin
			.from("source_documents")
			.select(
				"id,document_key,version_key,collection,status,document_kind,legal_force,rights_decision,checksum_sha256,canonical_url,register_version,chunk_count,parser_version",
			)
			.order("id")
			.range(from, to),
	);
	const byId = new Map(
		docs.map((d) => [`${d.document_key}@${d.version_key}`, d]),
	);
	const listed = new Set<string>();
	for (const e of register.entries) {
		const id = entryId(e);
		listed.add(id);
		const d = byId.get(id);
		if (!d) {
			fail(
				"documents",
				id,
				"register entry has no source_documents row (run sources:publish)",
			);
			continue;
		}
		const expect: Array<[string, unknown, unknown]> = [
			["status", d.status, e.status],
			["collection", d.collection, e.collection],
			["document_kind", d.document_kind, e.document_kind],
			["legal_force", d.legal_force, e.legal_force],
			["rights_decision", d.rights_decision, e.rights.decision],
			["canonical_url", d.canonical_url, e.canonical_url],
		];
		if (e.checksum_sha256) {
			expect.push(["checksum_sha256", d.checksum_sha256, e.checksum_sha256]);
		}
		for (const [field, got, want] of expect) {
			if (got !== want) {
				fail(
					"documents",
					id,
					`${field} is ${JSON.stringify(got)} in the DB, register says ${JSON.stringify(want)}`,
				);
			}
		}
		if (d.register_version !== register.version) {
			warn(
				"documents",
				id,
				`published from register ${d.register_version}, register is now ${register.version}`,
			);
		}
	}
	for (const d of docs) {
		const id = `${d.document_key}@${d.version_key}`;
		if (!listed.has(id)) {
			fail(
				"documents",
				id,
				"DB row the register does not list (unpublish_source_document or add it)",
			);
		}
	}

	// ── text ──────────────────────────────────────────────────────────────
	const chunks = await selectAll<ChunkRow>((from, to) =>
		admin
			.from("source_chunks")
			.select(
				"id,document_id,collection,chunk_index,page_start,page_end,locator_url",
			)
			.order("id")
			.range(from, to),
	);
	const docById = new Map(docs.map((d) => [d.id, d]));
	const realCount = new Map<number, number>();
	const perCollection = new Map<string, number>();
	for (const c of chunks) {
		realCount.set(c.document_id, (realCount.get(c.document_id) ?? 0) + 1);
		perCollection.set(c.collection, (perCollection.get(c.collection) ?? 0) + 1);
		const d = docById.get(c.document_id);
		if (d && d.collection !== c.collection) {
			fail(
				"text",
				`chunk ${c.id}`,
				`collection ${c.collection} ≠ its document's ${d.collection}`,
			);
		}
		if (c.locator_url !== null && !isAllowedSourceUrl(c.locator_url)) {
			fail(
				"links",
				`chunk ${c.id}`,
				`locator_url is not allowlisted: ${c.locator_url}`,
			);
		}
	}
	const entryById = new Map(register.entries.map((e) => [entryId(e), e]));
	for (const d of docs) {
		const id = `${d.document_key}@${d.version_key}`;
		const real = realCount.get(d.id) ?? 0;
		if (real !== d.chunk_count) {
			fail("text", id, `chunk_count ${d.chunk_count} but ${real} chunks exist`);
		}
		const e = entryById.get(id);
		const textAllowed = e?.ingest === true && e.rights.decision === "full_text";
		if (!textAllowed && real > 0) {
			fail(
				"text",
				id,
				`${real} chunks for an entry that is metadata-only or not ingested`,
			);
		}
		if (textAllowed && real === 0) {
			warn("text", id, "text entry has no chunks yet (run sources:publish)");
		}
		if (!isAllowedSourceUrl(d.canonical_url)) {
			fail("links", id, `canonical_url is not allowlisted: ${d.canonical_url}`);
		}
	}
	for (const id of ["iaea", "aerb", "fukushima"]) {
		const n = perCollection.get(id) ?? 0;
		if (n > 0) fail("text", id, `${n} chunks in a reference-only collection`);
	}

	// ── gates ─────────────────────────────────────────────────────────────
	const { data: cols, error: colErr } = await admin
		.from("source_collections")
		.select("id,searchable")
		.order("id");
	if (colErr) throw colErr;
	const searchable = (cols ?? [])
		.filter((c) => c.searchable)
		.map((c) => c.id as string);
	if (searchable.includes("iaea")) fail("gates", "iaea", "IAEA is searchable");
	for (const id of searchable) {
		const hasText = docs.some(
			(d) => d.collection === id && d.status === "current" && d.chunk_count > 0,
		);
		if (!hasText)
			warn("gates", id, "searchable but holds no current text document");
		if (!(id in COLLECTIONS))
			fail("gates", id, "unknown collection is searchable");
	}

	// ── pages ─────────────────────────────────────────────────────────────
	const pageResults: Array<{
		id: string;
		sampled: number;
		on_cited_page: number;
		off_by_one: number;
		not_found: number;
	}> = [];
	if (PAGES) {
		const pdfEntries = register.entries.filter(
			(e: RegisterEntry) => e.format === "pdf" && e.ingest,
		);
		for (const e of pdfEntries) {
			const id = entryId(e);
			const d = byId.get(id);
			const path = cachePath(e);
			if (!d || d.chunk_count === 0) continue;
			if (!existsSync(path)) {
				warn("pages", id, "no cached PDF — run sources:fetch first");
				continue;
			}
			const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)));
			const { text: pages } = await extractText(pdf, { mergePages: false });
			const squashedPages = (pages as string[]).map(squash);
			const docChunks = chunks
				.filter((c) => c.document_id === d.id && c.page_start !== null)
				.sort((a, b) => a.chunk_index - b.chunk_index);
			const step = Math.max(
				1,
				Math.floor(docChunks.length / PAGE_SAMPLES_PER_DOC),
			);
			const sample = docChunks
				.filter((_, i) => i % step === 0)
				.slice(0, PAGE_SAMPLES_PER_DOC);
			const { data: texts, error } = await admin
				.from("source_chunks")
				.select("id,chunk_text")
				.in(
					"id",
					sample.map((c) => c.id),
				);
			if (error) throw error;
			const textById = new Map(
				(texts ?? []).map((t) => [t.id as number, t.chunk_text as string]),
			);
			const r = {
				id,
				sampled: 0,
				on_cited_page: 0,
				off_by_one: 0,
				not_found: 0,
			};
			for (const c of sample) {
				const body = squash(textById.get(c.id) ?? "");
				if (body.length < 80) continue;
				// A window from the middle of the chunk: the chunk's edges can be
				// overlap carried from a neighbour or a joined heading.
				const mid = Math.floor(body.length / 2);
				const needle = body.slice(mid - 20, mid + 20);
				const start = (c.page_start ?? 1) - 1;
				const end = (c.page_end ?? c.page_start ?? 1) - 1;
				const span = (a: number, b: number) =>
					squashedPages
						.slice(Math.max(0, a), Math.min(squashedPages.length, b + 1))
						.join("");
				r.sampled++;
				if (span(start, end).includes(needle)) r.on_cited_page++;
				else if (span(start - 1, end + 1).includes(needle)) r.off_by_one++;
				else r.not_found++;
			}
			pageResults.push(r);
			if (r.not_found > 0) {
				fail(
					"pages",
					id,
					`${r.not_found}/${r.sampled} sampled chunks not found on or next to their cited pages`,
				);
			} else if (r.off_by_one > 0) {
				warn(
					"pages",
					id,
					`${r.off_by_one}/${r.sampled} sampled chunks are one page off`,
				);
			}
		}
	}

	// ── report ────────────────────────────────────────────────────────────
	const fails = findings.filter((f) => f.level === "fail");
	const warns = findings.filter((f) => f.level === "warn");
	const summary = {
		register_version: register.version,
		entries: register.entries.length,
		db_documents: docs.length,
		chunks: Object.fromEntries([...perCollection].sort()),
		searchable,
		fails: fails.length,
		warns: warns.length,
	};
	await writeFile(
		join(REPORTS_DIR, "audit.json"),
		`${JSON.stringify({ run_at: today.toISOString(), summary, pages: pageResults, findings }, null, "\t")}\n`,
	);
	for (const f of findings) {
		console.log(
			`${f.level === "fail" ? "FAIL" : "warn"} [${f.check}] ${f.subject}: ${f.message}`,
		);
	}
	if (PAGES) {
		const tot = pageResults.reduce(
			(a, r) => ({
				sampled: a.sampled + r.sampled,
				on: a.on + r.on_cited_page,
				off: a.off + r.off_by_one,
				miss: a.miss + r.not_found,
			}),
			{ sampled: 0, on: 0, off: 0, miss: 0 },
		);
		console.log(
			`pages: ${tot.on}/${tot.sampled} on the cited page, ${tot.off} one off, ${tot.miss} not found (${pageResults.length} PDFs)`,
		);
	}
	console.log(JSON.stringify(summary));
	console.log("report → corpus/reports/audit.json");
	if (fails.length > 0 || (STRICT && warns.length > 0)) process.exit(1);
}

await main();
