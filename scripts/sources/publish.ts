// Phase 12 publisher: one register entry → one atomically published edition.
//
//   bun run sources:publish --dry-run             # parse + quality + chunk, no API/DB
//   bun run sources:publish                       # everything in the register
//   bun run sources:publish --only nrc-rg-1.21    # one document (all its editions)
//   bun run sources:publish --force               # allow a non-local Supabase URL
//   bun run sources:publish --prune               # also DELETE editions the
//                                                 # register no longer lists
//   bun run sources:publish --reembed             # re-embed even unchanged editions
//
// An edition whose re-parsed chunk rows (text, sections, pages, locators,
// requirement tags) are exactly what the DB holds, under the same embedding
// model, is UNCHANGED: its metadata is refreshed (register_source_document)
// and its chunks are kept — a rerun after a register-only edit costs no
// embeddings. Every text entry is still re-parsed, so an adapter or chunker
// change republishes whatever it changed even without a version bump.
//
// Per entry, in register order (superseded editions before current ones):
//   • not ingestible (metadata-only, draft, fetch-blocked) → unpublish_source_document
//     (drops any chunks an earlier register allowed — pulling a document from
//     the register must pull its text from search) then register_source_document
//     (metadata row, zero chunks — the DB refuses chunks for it anyway)
//   • backfill_from_regdoc → backfill_source_document_from_regdoc (legacy rows
//     copied with their embeddings, no API cost)
//   • otherwise → verify the cached bytes against the pinned sha256, parse
//     with the format's adapter, refuse on the quality gate, chunk, embed,
//     stage, and publish_source_document (atomic: the edition's metadata and
//     exactly N chunks land, or nothing changes; reruns replace, never
//     duplicate; other documents are never touched).
// A full run (no --only) then lists DB editions the register no longer names:
// it fails with their ids, and --prune deletes them (chunks cascade) — but
// only after a run with no errors or quality blocks, and never when the DB
// was published from a newer register than this checkout's.
// Evidence for every text entry is written to corpus/reports/<key@version>.json.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { EMBEDDING_DIMENSIONS } from "../../lib/openai";
import type { RegisterEntry, SourceRegister } from "../../lib/sources/register";
import {
	CHUNKER_VERSION,
	type ChunkingStats,
	chunkDocPaged,
	emptyStats,
	freeEncoder,
	type PagedChunk,
} from "../lib/chunker";
import {
	EMBED_BATCH_SIZE,
	EMBEDDING_MODEL,
	embedBatch,
	isLocalSupabaseUrl,
} from "../lib/embed";
import { CNSC_PARSER_VERSION, parseCnscPageData } from "./adapters/cnsc-html";
import { DOCX_PARSER_VERSION, parseDocx } from "./adapters/docx";
import { ECFR_PARSER_VERSION, parseEcfrXml } from "./adapters/ecfr-xml";
import { EU_PARSER_VERSION, parseEuXhtml } from "./adapters/eu-xhtml";
import { PDF_PARSER_VERSION, parsePdf } from "./adapters/pdf";
import type { ParsedSource } from "./adapters/types";
import { pinnedChecksum } from "./content-hash";
import { selectAll } from "./db";
import { sha256Hex } from "./http";
import { buildReport } from "./quality";
import {
	cachePath,
	ensureDirs,
	entryId,
	loadRegister,
	parseOnly,
	REPORTS_DIR,
	selected,
} from "./register-io";

const STAGE_BATCH = 200;
// Regulations and directives are split per paragraph/article; keep short
// ones ("(d) …", "This Directive is addressed to the Member States.").
const LEGAL_TEXT_FORMATS = new Set(["ecfr-xml", "eu-xhtml"]);
const LEGAL_TEXT_MIN_TOKENS = 8;
const MAX_CHUNKS_PER_DOCUMENT = 3000;
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const PRUNE = argv.includes("--prune");
const REEMBED = argv.includes("--reembed");

const ADAPTER_VERSIONS: Record<string, string> = {
	pdf: PDF_PARSER_VERSION,
	"cnsc-json": CNSC_PARSER_VERSION,
	"ecfr-xml": ECFR_PARSER_VERSION,
	"eu-xhtml": EU_PARSER_VERSION,
	docx: DOCX_PARSER_VERSION,
};
/** What publish_source_document records as parser_version. */
function pipelineVersion(format: string): string {
	return `${ADAPTER_VERSIONS[format] ?? format}+${CHUNKER_VERSION}`;
}

interface PublishedRow {
	id: number;
	checksum_sha256: string | null;
	parser_version: string | null;
	embedding_model: string | null;
	embedding_dims: number | null;
	chunk_count: number;
}
const FORCE_REMOTE =
	argv.includes("--force") || process.env.ALLOW_REMOTE_INGEST === "1";

/** The jsonb shape _source_document_upsert reads (rights flattened). */
export function docPayload(e: RegisterEntry): Record<string, unknown> {
	return {
		document_key: e.document_key,
		version_key: e.version_key,
		doc_ref: e.doc_ref,
		label: e.label,
		title: e.title,
		edition: e.edition,
		publisher: e.publisher,
		jurisdiction: e.jurisdiction,
		collection: e.collection,
		document_kind: e.document_kind,
		legal_force: e.legal_force,
		status: e.status,
		language: e.language,
		canonical_url: e.canonical_url,
		fetch_url: e.fetch_url,
		published_date: e.published_date,
		effective_date: e.effective_date,
		as_of: e.as_of,
		checksum_sha256: e.checksum_sha256,
		rights_decision: e.rights.decision,
		rights_basis: e.rights.basis,
		rights_evidence_url: e.rights.evidence_url,
		rights_reviewed_on: e.rights.reviewed_on,
		attribution: e.rights.attribution,
	};
}

function canIngestText(e: RegisterEntry): boolean {
	return e.ingest && e.rights.decision === "full_text";
}

// Superseded editions first, so publishing the current one last leaves it
// current (the upsert demotes any other current edition of the key).
function publishOrder(entries: RegisterEntry[]): RegisterEntry[] {
	const rank = (e: RegisterEntry) => (e.status === "current" ? 1 : 0);
	return [...entries].sort((a, b) => rank(a) - rank(b));
}

async function parseEntry(
	e: RegisterEntry,
	bytes: Uint8Array,
): Promise<ParsedSource> {
	const meta = { ref: e.doc_ref, title: e.title };
	switch (e.format) {
		case "pdf":
			return parsePdf(bytes, { ...meta, fetchUrl: e.fetch_url as string });
		case "cnsc-json":
			return parseCnscPageData(JSON.parse(new TextDecoder().decode(bytes)), {
				...meta,
				canonicalUrl: e.canonical_url,
			});
		case "ecfr-xml": {
			const section = e.doc_ref.match(/^10 CFR (\d+\.\d+)$/)?.[1] ?? null;
			return parseEcfrXml(new TextDecoder().decode(bytes), {
				...meta,
				canonicalUrl: e.canonical_url,
				sectionId: section,
			});
		}
		case "eu-xhtml":
			return parseEuXhtml(new TextDecoder().decode(bytes), {
				...meta,
				canonicalUrl: e.canonical_url,
			});
		case "docx":
			return parseDocx(bytes, { ...meta, canonicalUrl: e.canonical_url });
		default:
			throw new Error(`no adapter for format ${e.format}`);
	}
}

/**
 * Where a chunk's citation link points. PDFs: the PDF itself at the chunk's
 * first page (#page=N works in every browser viewer). Anchored formats: the
 * canonical page at the section anchor. Otherwise the canonical page.
 */
export function locatorFor(e: RegisterEntry, c: PagedChunk): string {
	if (e.format === "pdf") {
		const base = (e.fetch_url as string).split("#")[0];
		return c.page_start ? `${base}#page=${c.page_start}` : base;
	}
	return c.url && c.url.startsWith("https://") ? c.url : e.canonical_url;
}

interface DocReport {
	id: string;
	register_version: string;
	outcome: "published" | "dry-run" | "quality-blocked" | "error";
	failures?: string[];
	sha256: string;
	chunks: number;
	requirement_chunks: number;
	chunks_with_page: number;
	sections_sample: string[];
	report: unknown;
	published_at?: string;
}

async function writeReport(r: DocReport): Promise<void> {
	await writeFile(
		join(REPORTS_DIR, `${r.id}.json`),
		`${JSON.stringify(r, null, "\t")}\n`,
	);
}

type ChunkRowTuple = [
	number,
	string | null,
	string | null,
	number | null,
	number | null,
	string | null,
	string,
	string | null,
];
const FINGERPRINT_COLUMNS =
	"chunk_index,section_number,section_title,page_start,page_end,locator_url,chunk_text,requirement_type";

function fingerprint(rows: ChunkRowTuple[]): Promise<string> {
	return sha256Hex(new TextEncoder().encode(JSON.stringify(rows)));
}

/** Everything a re-parse can change in a document's rows, except vectors. */
function chunkFingerprint(e: RegisterEntry, chunks: PagedChunk[]) {
	return fingerprint(
		chunks.map((c) => [
			c.chunk_index,
			c.section_number,
			c.section_title,
			c.page_start,
			c.page_end,
			locatorFor(e, c),
			c.chunk_text,
			c.requirement_type,
		]),
	);
}

async function publishedFingerprint(
	supabase: SupabaseClient,
	documentId: number,
): Promise<string> {
	const rows = await selectAll<{
		chunk_index: number;
		section_number: string | null;
		section_title: string | null;
		page_start: number | null;
		page_end: number | null;
		locator_url: string | null;
		chunk_text: string;
		requirement_type: string | null;
	}>((from, to) =>
		supabase
			.from("source_chunks")
			.select(FINGERPRINT_COLUMNS)
			.eq("document_id", documentId)
			.order("chunk_index")
			.range(from, to),
	);
	return fingerprint(
		rows.map((r) => [
			r.chunk_index,
			r.section_number,
			r.section_title,
			r.page_start,
			r.page_end,
			r.locator_url,
			r.chunk_text,
			r.requirement_type,
		]),
	);
}

/** Register versions are "YYYY-MM-DD.N": date first, then N as a number. */
export function compareRegisterVersions(a: string, b: string): number {
	const [da = "", na = "0"] = a.split(".");
	const [db = "", nb = "0"] = b.split(".");
	if (da !== db) return da < db ? -1 : 1;
	return Number(na) - Number(nb);
}

async function stageAndPublish(
	supabase: SupabaseClient,
	openai: OpenAI,
	register: SourceRegister,
	e: RegisterEntry,
	chunks: PagedChunk[],
	parserVersion: string,
): Promise<number> {
	const publishId = crypto.randomUUID();
	const rows: Record<string, unknown>[] = [];
	for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
		const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
		const vectors = await embedBatch(
			openai,
			batch.map((c) => c.chunk_text),
		);
		for (let j = 0; j < batch.length; j++) {
			const c = batch[j] as PagedChunk;
			rows.push({
				publish_id: publishId,
				chunk_index: c.chunk_index,
				section_number: c.section_number,
				section_title: c.section_title,
				page_start: c.page_start,
				page_end: c.page_end,
				locator_url: locatorFor(e, c),
				chunk_text: c.chunk_text,
				text_sha256: await sha256Hex(new TextEncoder().encode(c.chunk_text)),
				requirement_type: c.requirement_type,
				embedding: JSON.stringify(vectors[j]),
			});
		}
	}
	try {
		for (let i = 0; i < rows.length; i += STAGE_BATCH) {
			const { error } = await supabase
				.from("source_chunks_staging")
				.insert(rows.slice(i, i + STAGE_BATCH));
			if (error) throw new Error(`staging insert failed: ${error.message}`);
		}
		const { data, error } = await supabase.rpc("publish_source_document", {
			p_doc: docPayload(e),
			p_register_version: register.version,
			p_publish_id: publishId,
			p_expected_count: rows.length,
			p_parser_version: parserVersion,
			p_embedding_model: EMBEDDING_MODEL,
			p_embedding_dims: EMBEDDING_DIMENSIONS,
		});
		if (error)
			throw new Error(`publish_source_document failed: ${error.message}`);
		return data as number;
	} finally {
		// On failure the staged rows are scratch; on success the RPC already
		// cleared them. Either way leave nothing behind.
		await supabase
			.from("source_chunks_staging")
			.delete()
			.eq("publish_id", publishId);
	}
}

async function main() {
	const only = parseOnly(argv);
	const register = await loadRegister();
	await ensureDirs();

	const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	const openaiKey = process.env.OPENAI_API_KEY;
	let supabase: SupabaseClient | null = null;
	let openai: OpenAI | null = null;
	if (!DRY_RUN) {
		if (!url || !serviceKey || !openaiKey) {
			console.error(
				"Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY",
			);
			process.exit(1);
		}
		if (!isLocalSupabaseUrl(url) && !FORCE_REMOTE) {
			console.error(
				`Refusing to publish to ${url}: not a local Supabase URL. Hosted publishing follows docs/phase-12-sources.md and needs --force.`,
			);
			process.exit(1);
		}
		supabase = createClient(url, serviceKey, {
			auth: { persistSession: false, autoRefreshToken: false },
		});
		openai = new OpenAI({ apiKey: openaiKey });
	}

	const entries = publishOrder(
		register.entries.filter((e) => selected(e, only)),
	);
	const stats: ChunkingStats = emptyStats();
	const publishedRows = new Map<string, PublishedRow>();
	if (supabase) {
		const { data, error } = await supabase
			.from("source_documents")
			.select(
				"id,document_key,version_key,checksum_sha256,parser_version,embedding_model,embedding_dims,chunk_count",
			);
		if (error) throw new Error(error.message);
		for (const d of data ?? []) {
			publishedRows.set(`${d.document_key}@${d.version_key}`, d);
		}
	}
	const summary = {
		unchanged: 0,
		metadata: 0,
		backfilled: 0,
		published: 0,
		blocked: 0,
		errors: 0,
		chunks: 0,
	};

	for (const e of entries) {
		const id = entryId(e);
		try {
			if (!canIngestText(e)) {
				if (supabase) {
					const { data: dropped, error: unpubErr } = await supabase.rpc(
						"unpublish_source_document",
						{ p_document_key: e.document_key, p_version_key: e.version_key },
					);
					if (unpubErr) throw new Error(unpubErr.message);
					if (typeof dropped === "number" && dropped > 0) {
						console.log(
							`⊖ ${id}: removed ${dropped} chunk(s) the register no longer allows`,
						);
					}
					const { error } = await supabase.rpc("register_source_document", {
						p_doc: docPayload(e),
						p_register_version: register.version,
					});
					if (error) throw new Error(error.message);
				}
				summary.metadata += 1;
				console.log(
					`○ ${id}: metadata only (${e.rights.decision}${e.ingest ? "" : ", ingest=false"})`,
				);
				continue;
			}

			if (e.backfill_from_regdoc) {
				if (supabase) {
					const { count, error: countErr } = await supabase
						.from("regdoc_chunks")
						.select("id", { count: "exact", head: true })
						.eq("regdoc_id", e.backfill_from_regdoc)
						.not("embedding", "is", null);
					if (countErr) throw new Error(countErr.message);
					const { error } = await supabase.rpc(
						"backfill_source_document_from_regdoc",
						{
							p_doc: docPayload(e),
							p_register_version: register.version,
							p_regdoc_id: e.backfill_from_regdoc,
							p_expected_count: count ?? 0,
							p_embedding_model: EMBEDDING_MODEL,
						},
					);
					if (error) throw new Error(error.message);
					summary.chunks += count ?? 0;
					console.log(
						`⇢ ${id}: backfilled ${count} chunk(s) from regdoc_chunks:${e.backfill_from_regdoc}`,
					);
				} else {
					console.log(
						`⇢ ${id}: would backfill from regdoc_chunks:${e.backfill_from_regdoc}`,
					);
				}
				summary.backfilled += 1;
				continue;
			}

			const path = cachePath(e);
			if (!existsSync(path))
				throw new Error("not downloaded — run scripts/sources/fetch.ts first");
			const bytes = new Uint8Array(await readFile(path));
			const sha = await pinnedChecksum(e, bytes);
			if (sha !== e.checksum_sha256) {
				throw new Error(
					e.format === "cnsc-json"
						? `cached page-data text hash ${sha.slice(0, 12)}… does not match pinned ${String(e.checksum_sha256).slice(0, 12)}… — if the CNSC parser changed, see sources:fetch --repin-cnsc`
						: `cached bytes ${sha.slice(0, 12)}… do not match pinned ${String(e.checksum_sha256).slice(0, 12)}…`,
				);
			}
			const parsed = await parseEntry(e, bytes);
			const { report, ok, failures } = buildReport(parsed);
			const chunks = chunkDocPaged(parsed.doc, stats, {
				minTokens: LEGAL_TEXT_FORMATS.has(e.format as string)
					? LEGAL_TEXT_MIN_TOKENS
					: undefined,
				splitOversized: true,
			});
			const base: DocReport = {
				id,
				register_version: register.version,
				outcome: "dry-run",
				sha256: sha,
				chunks: chunks.length,
				requirement_chunks: chunks.filter(
					(c) => c.requirement_type === "requirement",
				).length,
				chunks_with_page: chunks.filter((c) => c.page_start !== null).length,
				sections_sample: parsed.doc.sections
					.slice(0, 25)
					.map((s) => `${s.section_number} ${s.section_title}`.trim()),
				report,
			};
			if (
				!ok ||
				chunks.length === 0 ||
				chunks.length > MAX_CHUNKS_PER_DOCUMENT
			) {
				const why = [...failures];
				if (chunks.length === 0) why.push("no chunks");
				if (chunks.length > MAX_CHUNKS_PER_DOCUMENT)
					why.push(
						`${chunks.length} chunks exceeds ${MAX_CHUNKS_PER_DOCUMENT}`,
					);
				await writeReport({
					...base,
					outcome: "quality-blocked",
					failures: why,
				});
				summary.blocked += 1;
				console.log(`⊘ ${id}: QUALITY-BLOCKED — ${why.join("; ")}`);
				continue;
			}
			if (!supabase || !openai) {
				await writeReport(base);
				console.log(
					`· ${id}: ${chunks.length} chunks (dry run) word_like=${report.word_like_ratio}`,
				);
				continue;
			}
			// Unchanged edition: the re-parsed chunk rows are exactly what is
			// published (text, sections, pages, locators, requirement tags) under
			// the same embedding model — refresh metadata, re-embed nothing. The
			// comparison is on the parse OUTPUT, not on version strings, so an
			// adapter or chunker change that forgets a version bump still
			// republishes (and one that changes nothing costs nothing).
			const prior = publishedRows.get(id);
			if (
				!REEMBED &&
				prior &&
				prior.chunk_count === chunks.length &&
				prior.embedding_model === EMBEDDING_MODEL &&
				prior.embedding_dims === EMBEDDING_DIMENSIONS &&
				(await publishedFingerprint(supabase, prior.id)) ===
					(await chunkFingerprint(e, chunks))
			) {
				const { error } = await supabase.rpc("register_source_document", {
					p_doc: docPayload(e),
					p_register_version: register.version,
				});
				if (error) throw new Error(error.message);
				summary.unchanged += 1;
				console.log(
					`= ${id}: unchanged — metadata refreshed, ${prior.chunk_count} chunks kept`,
				);
				continue;
			}
			await stageAndPublish(
				supabase,
				openai,
				register,
				e,
				chunks,
				pipelineVersion(e.format as string),
			);
			await writeReport({
				...base,
				outcome: "published",
				published_at: new Date().toISOString(),
			});
			summary.published += 1;
			summary.chunks += chunks.length;
			console.log(`● ${id}: published ${chunks.length} chunks`);
		} catch (err) {
			summary.errors += 1;
			console.error(`✗ ${id}: ${(err as Error).message}`);
		}
	}
	freeEncoder();

	// Editions in the DB that the register no longer lists. Only on a full
	// run: with --only the rest of the register was not considered.
	let orphans = 0;
	if (supabase && only === null) {
		const listed = new Set(register.entries.map(entryId));
		const { data, error } = await supabase
			.from("source_documents")
			.select("document_key,version_key,chunk_count,register_version");
		if (error) throw new Error(error.message);
		// Prune only from a clean run on an up-to-date register. After a
		// failure, a re-keyed edition's old copy may be the only searchable one
		// left; and a stale checkout would delete editions a newer register
		// added.
		const newer = (data ?? []).filter(
			(d) => compareRegisterVersions(d.register_version, register.version) > 0,
		);
		const pruneBlocked =
			summary.errors + summary.blocked > 0
				? `this run had ${summary.errors} error(s) and ${summary.blocked} quality-blocked edition(s)`
				: newer.length > 0
					? `the database was published from register ${newer[0].register_version}, newer than this checkout's ${register.version} — pull first`
					: null;
		if (PRUNE && pruneBlocked) {
			console.error(`✗ --prune refused: ${pruneBlocked}. Nothing deleted.`);
		}
		for (const d of data ?? []) {
			const id = `${d.document_key}@${d.version_key}`;
			if (listed.has(id)) continue;
			if (PRUNE && !pruneBlocked) {
				const { error: delErr } = await supabase.rpc("delete_source_document", {
					p_document_key: d.document_key,
					p_version_key: d.version_key,
				});
				if (delErr) {
					summary.errors += 1;
					console.error(`✗ ${id}: prune failed: ${delErr.message}`);
				} else {
					console.log(
						`⊗ ${id}: deleted (not in the register; ${d.chunk_count} chunks)`,
					);
				}
			} else {
				orphans += 1;
				console.error(
					`✗ ${id}: in the database but not in the register (${d.chunk_count} chunks still searchable) — rerun with --prune to delete`,
				);
			}
		}
	}
	console.log(
		`\nunchanged ${summary.unchanged} · metadata-only ${summary.metadata} · backfilled ${summary.backfilled} · published ${summary.published} · quality-blocked ${summary.blocked} · errors ${summary.errors} · chunks ${summary.chunks}${orphans ? ` · unlisted ${orphans}` : ""}`,
	);
	if (summary.errors > 0 || orphans > 0) process.exit(1);
}

if (import.meta.main) await main();
