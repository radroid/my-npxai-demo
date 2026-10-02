// Versioned source register (PLAN.md Phase 12, publication rule 1).
//
// corpus/register.json is the committed record of every document the
// Knowledge Hub knows about — searchable or not. Nothing reaches the text
// pipeline without an entry here, and an entry only becomes text if its
// rights decision says so. This module owns the schema and the cross-field
// rules; scripts/sources/* and the app both go through validateRegister()
// so a bad register fails loudly at the first touch, not in production.

import { z } from "zod";
import {
	COLLECTION_IDS,
	COLLECTIONS,
	type CollectionId,
	DOCUMENT_KINDS,
	DOCUMENT_STATUSES,
	type DocumentKind,
	isAllowedSourceUrl,
	JURISDICTION_LABELS,
	LEGAL_FORCES,
	type LegalForce,
} from "./catalog";

const DATE_RE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[a-z0-9][a-z0-9.-]{1,79}$/;
const VERSION_RE = /^[a-z0-9][a-z0-9.-]{0,59}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const httpsUrl = z
	.string()
	.max(2048)
	.refine((u) => {
		try {
			return new URL(u).protocol === "https:";
		} catch {
			return false;
		}
	}, "must be an https URL");

export const RIGHTS_DECISIONS = ["full_text", "metadata_only"] as const;
export type RightsDecision = (typeof RIGHTS_DECISIONS)[number];

// How fetch_url's bytes are parsed (scripts/sources/adapters/*):
//   pdf        — pdf.js line extraction with page locators
//   cnsc-json  — CNSC Gatsby page-data JSON (HTML body with section anchors)
//   ecfr-xml   — eCFR versioner XML for one 10 CFR section/appendix
//   eu-xhtml   — EU Publications Office XHTML manifestation of a CELEX act
//   docx       — Word document (ONR Technical Assessment Guides)
export const SOURCE_FORMATS = [
	"pdf",
	"cnsc-json",
	"ecfr-xml",
	"eu-xhtml",
	"docx",
] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

const rightsSchema = z.object({
	decision: z.enum(RIGHTS_DECISIONS),
	basis: z.string().min(10).max(600),
	evidence_url: httpsUrl,
	evidence_quote: z.string().min(1).max(2000),
	reviewed_on: z.string().regex(DAY_RE),
	attribution: z.string().max(400).nullable(),
	third_party_notice: z.string().max(1200).nullable(),
	// Documented permission for a publisher whose default terms do not allow
	// corpus storage (IAEA). Required before such an entry may be full_text.
	permission_evidence: httpsUrl.nullable().optional(),
});

export const registerEntrySchema = z.object({
	document_key: z.string().regex(KEY_RE),
	version_key: z.string().regex(VERSION_RE),
	// Short reference the user might type and the model sees as `document`
	// ("REGDOC-2.3.4", "RG 1.21", "10 CFR 20.1201"). Used for mention boosts.
	doc_ref: z.string().min(2).max(80),
	// Citation label shown on chips ("NRC RG 1.21, Rev. 3").
	label: z.string().min(2).max(120),
	title: z.string().min(3).max(400),
	edition: z.string().min(1).max(160),
	publisher: z.string().min(2).max(80),
	jurisdiction: z.string().refine((j) => j in JURISDICTION_LABELS),
	collection: z.enum(COLLECTION_IDS),
	document_kind: z.enum(DOCUMENT_KINDS),
	legal_force: z.enum(LEGAL_FORCES),
	status: z.enum(DOCUMENT_STATUSES),
	language: z.literal("en"),
	canonical_url: httpsUrl,
	fetch_url: httpsUrl.nullable(),
	format: z.enum(SOURCE_FORMATS).nullable(),
	published_date: z.string().regex(DATE_RE).nullable(),
	effective_date: z.string().regex(DATE_RE).nullable(),
	// When the edition/status facts above were last checked against the
	// publisher. Shown to users as the source's "as of" date.
	as_of: z.string().regex(DAY_RE),
	checksum_sha256: z.string().regex(SHA256_RE).nullable(),
	content_length: z.number().int().positive().nullable(),
	// Text comes from the legacy regdoc_chunks rows for this regdoc_id,
	// copied with their embeddings (scripts/sources/backfill-cnsc.ts) instead
	// of being fetched and re-embedded. Only for editions the legacy corpus
	// already holds verbatim.
	backfill_from_regdoc: z.string().min(2).max(40).nullable(),
	rights: rightsSchema,
	ingest: z.boolean(),
	notes: z.string().max(2000).nullable(),
});
export type RegisterEntry = z.infer<typeof registerEntrySchema>;

export const registerSchema = z.object({
	// Bumped whenever an entry changes; part of the answer-cache key.
	version: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/),
	// Rights and revision facts go stale. Every entry must be re-reviewed
	// within this many days of its reviewed_on (scripts/sources/audit.ts).
	recheck_cadence_days: z.number().int().min(30).max(730),
	entries: z.array(registerEntrySchema).min(1),
});
export type SourceRegister = z.infer<typeof registerSchema>;

// Legal force follows document kind. Kinds absent from both sets
// (safety_code) are publisher-specific and must be stated per entry.
const BINDING_KINDS = new Set<DocumentKind>([
	"statute",
	"regulation",
	"directive",
]);
const NONBINDING_KINDS = new Set<DocumentKind>([
	"regulatory_guide",
	"staff_report",
	"safety_assessment_principles",
	"technical_assessment_guide",
	"reference_levels",
	"handbook",
	"safety_guide",
	"safety_standard",
	"investigation_report",
	"operator_report",
	"review_mission_report",
	"national_report",
	"regulatory_requirements_outline",
]);

function expectedLegalForce(kind: DocumentKind): LegalForce | null {
	if (BINDING_KINDS.has(kind)) return "binding";
	if (NONBINDING_KINDS.has(kind)) return "nonbinding";
	if (kind === "regulatory_document") return "mixed";
	return null;
}

export interface RegisterIssue {
	document_key: string;
	message: string;
}

/**
 * Cross-field rules the zod shape cannot express. Returns every violation,
 * not just the first, so a reviewer sees the whole picture in one run.
 */
export function registerIssues(register: SourceRegister): RegisterIssue[] {
	const issues: RegisterIssue[] = [];
	const seen = new Set<string>();
	const currentPerKey = new Map<string, number>();

	for (const e of register.entries) {
		const issue = (message: string) =>
			issues.push({ document_key: e.document_key, message });
		const id = `${e.document_key}@${e.version_key}`;
		if (seen.has(id)) issue(`duplicate document_key+version_key ${id}`);
		seen.add(id);
		if (e.status === "current") {
			currentPerKey.set(
				e.document_key,
				(currentPerKey.get(e.document_key) ?? 0) + 1,
			);
		}

		if (!isAllowedSourceUrl(e.canonical_url)) {
			issue(`canonical_url host is not on the source allowlist`);
		}
		if (e.fetch_url !== null && !isAllowedSourceUrl(e.fetch_url)) {
			issue(`fetch_url host is not on the source allowlist`);
		}

		const expected = expectedLegalForce(e.document_kind);
		if (expected && expected !== e.legal_force) {
			issue(
				`legal_force "${e.legal_force}" contradicts document_kind "${e.document_kind}" (expected "${expected}")`,
			);
		}

		const iaea = e.collection === "iaea" || /\bIAEA\b/.test(e.publisher);
		if (
			iaea &&
			e.rights.decision === "full_text" &&
			!e.rights.permission_evidence
		) {
			issue(
				"IAEA publications are metadata-only unless documented permission is recorded (rights.permission_evidence)",
			);
		}

		if (e.ingest) {
			if (e.rights.decision !== "full_text") {
				issue("ingest=true requires rights.decision=full_text");
			}
			if (!COLLECTIONS[e.collection].searchable) {
				issue(`collection "${e.collection}" is reference-only`);
			}
			if (e.status === "draft" || e.status === "withdrawn") {
				issue(`a ${e.status} edition cannot be ingested`);
			}
			if (e.backfill_from_regdoc) {
				if (e.collection !== "cnsc") {
					issue("backfill_from_regdoc is only for legacy CNSC editions");
				}
				if (e.fetch_url || e.format) {
					issue("a backfilled entry must not also have fetch_url/format");
				}
			} else {
				if (!e.fetch_url || !e.format) {
					issue(
						"ingest=true requires fetch_url and format (or backfill_from_regdoc)",
					);
				}
				// CNSC page-data is pinned by its extracted text (its bytes change
				// on every site build) — scripts/sources/content-hash.ts.
				if (!e.checksum_sha256) {
					issue(
						"ingest=true requires a pinned checksum_sha256 (run scripts/sources/fetch.ts --pin)",
					);
				}
			}
		}

		const reviewed = Date.parse(e.rights.reviewed_on);
		const asOf = Date.parse(e.as_of);
		if (Number.isNaN(reviewed) || Number.isNaN(asOf)) {
			issue("reviewed_on / as_of must be valid dates");
		}
	}

	for (const [key, n] of currentPerKey) {
		if (n > 1) {
			issues.push({
				document_key: key,
				message: `${n} entries marked current — at most one edition of a document can be current`,
			});
		}
	}
	return issues;
}

export function parseRegister(raw: unknown): SourceRegister {
	const register = registerSchema.parse(raw);
	const issues = registerIssues(register);
	if (issues.length > 0) {
		const lines = issues.map((i) => `  ${i.document_key}: ${i.message}`);
		throw new Error(`Invalid source register:\n${lines.join("\n")}`);
	}
	return register;
}

/** Entries whose text the pipeline may store, embed and serve. */
export function textEntries(register: SourceRegister): RegisterEntry[] {
	return register.entries.filter(
		(e) => e.ingest && e.rights.decision === "full_text",
	);
}

/** Days since an entry's rights review — feeds the recheck audit. */
export function daysSinceReview(entry: RegisterEntry, today: Date): number {
	return Math.floor(
		(today.getTime() - Date.parse(entry.rights.reviewed_on)) / 86_400_000,
	);
}

export interface CollectionSummary {
	id: CollectionId;
	textDocuments: number;
	referenceOnlyDocuments: number;
	/** Most recent as_of across the collection's text documents. */
	asOf: string | null;
}

export function summarizeCollections(
	register: SourceRegister,
): Record<CollectionId, CollectionSummary> {
	const out = {} as Record<CollectionId, CollectionSummary>;
	for (const id of COLLECTION_IDS) {
		out[id] = { id, textDocuments: 0, referenceOnlyDocuments: 0, asOf: null };
	}
	for (const e of register.entries) {
		if (e.status !== "current") continue;
		const s = out[e.collection];
		if (e.ingest && e.rights.decision === "full_text") {
			s.textDocuments += 1;
			if (!s.asOf || e.as_of > s.asOf) s.asOf = e.as_of;
		} else {
			s.referenceOnlyDocuments += 1;
		}
	}
	return out;
}
