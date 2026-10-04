// Source catalogue for the multi-source Knowledge Hub (PLAN.md Phase 12).
// Pure data + pure helpers, no I/O — imported by the routes, the UI, the
// ingestion scripts, and the offline tests alike, so every layer agrees on
// what a collection is, what a document kind means legally, and which hosts
// an outbound link may point at.

// A collection is one regulator's (or one topic's) corpus. It is the unit the
// user scopes a question to and the unit we roll out one at a time.
export const COLLECTION_IDS = [
	"cnsc",
	"nrc",
	"onr",
	"eu",
	"aerb",
	"fukushima",
	"iaea",
] as const;
export type CollectionId = (typeof COLLECTION_IDS)[number];

export interface CollectionInfo {
	id: CollectionId;
	/** Short label for chips and the scope picker ("NRC"). */
	label: string;
	/** Where its authority applies ("United States"). */
	region: string;
	/** One line for the scope picker. */
	description: string;
	/**
	 * false = the collection can never be searched: its entries are
	 * reference-only (title, edition, link) because no text-use permission is
	 * recorded. The IAEA safety standards are the case today.
	 */
	searchable: boolean;
}

export const COLLECTIONS: Record<CollectionId, CollectionInfo> = {
	cnsc: {
		id: "cnsc",
		label: "CNSC",
		region: "Canada",
		description: "REGDOCs and the Nuclear Safety and Control Act",
		searchable: true,
	},
	nrc: {
		id: "nrc",
		label: "NRC",
		region: "United States",
		description: "10 CFR provisions, regulatory guides, NUREG reports",
		searchable: true,
	},
	onr: {
		id: "onr",
		label: "ONR",
		region: "United Kingdom",
		description: "Safety Assessment Principles and Technical Assessment Guides",
		searchable: true,
	},
	eu: {
		id: "eu",
		label: "EU / Euratom",
		region: "European Union",
		description: "Euratom nuclear safety and waste directives",
		searchable: true,
	},
	aerb: {
		id: "aerb",
		label: "AERB",
		region: "India",
		description: "AERB safety codes and guides",
		searchable: true,
	},
	fukushima: {
		id: "fukushima",
		label: "Fukushima",
		region: "Japan · lessons learned",
		description:
			"Accident investigations, reviews and post-accident regulatory changes",
		searchable: true,
	},
	iaea: {
		id: "iaea",
		label: "IAEA",
		region: "International",
		description: "Safety standards — reference links only",
		searchable: false,
	},
};

export function isCollectionId(value: unknown): value is CollectionId {
	return (
		typeof value === "string" &&
		(COLLECTION_IDS as readonly string[]).includes(value)
	);
}

// What kind of document a source is. Drives the legal-force wording in the
// prompt and the label shown to the user. Kept deliberately coarse: the point
// is to stop a guide, a report or a principle from being presented as law.
export const DOCUMENT_KINDS = [
	"statute",
	"regulation",
	"directive",
	"regulatory_document",
	"regulatory_guide",
	"staff_report",
	"safety_assessment_principles",
	"technical_assessment_guide",
	"reference_levels",
	"handbook",
	"safety_code",
	"safety_guide",
	"safety_standard",
	"investigation_report",
	"operator_report",
	"review_mission_report",
	"national_report",
	"regulatory_requirements_outline",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
	statute: "statute",
	regulation: "regulation",
	directive: "directive",
	regulatory_document: "regulatory document",
	regulatory_guide: "regulatory guide",
	staff_report: "staff report",
	safety_assessment_principles: "safety assessment principles",
	technical_assessment_guide: "technical assessment guide",
	reference_levels: "safety reference levels",
	handbook: "handbook",
	safety_code: "safety code",
	safety_guide: "safety guide",
	safety_standard: "safety standard",
	investigation_report: "investigation report",
	operator_report: "operator report",
	review_mission_report: "review mission report",
	national_report: "national report",
	regulatory_requirements_outline: "regulatory requirements outline",
};

// Legal force is a property of the DOCUMENT, never of its wording: a "shall"
// in an NRC guide or an accident report binds nobody.
//   binding    — law in its jurisdiction (statute, regulation, directive)
//   mixed      — requirements bind via licences/licence conditions, guidance
//                does not (CNSC REGDOCs); requirement_type decides per snippet
//   nonbinding — guides, principles, reports, reviews, reference levels
export const LEGAL_FORCES = ["binding", "mixed", "nonbinding"] as const;
export type LegalForce = (typeof LEGAL_FORCES)[number];

export const DOCUMENT_STATUSES = [
	"current",
	"superseded",
	"draft",
	"withdrawn",
	"historical",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const JURISDICTION_LABELS: Record<string, string> = {
	CA: "Canada",
	US: "United States",
	UK: "United Kingdom",
	EU: "European Union",
	IN: "India",
	JP: "Japan",
	INT: "International",
};

// Hosts an outbound source link may point at. A URL reaches a rendered <a>
// only if (1) it was stored by the ingestion pipeline from the register and
// (2) it passes this check again at render time — https, no credentials, no
// non-default port, host on this list. Everything else renders as plain text.
export const ALLOWED_SOURCE_HOSTS = new Set([
	"www.cnsc-ccsn.gc.ca",
	"laws-lois.justice.gc.ca",
	"www.nrc.gov",
	"www.ecfr.gov",
	"www.onr.org.uk",
	"eur-lex.europa.eu",
	// EU Publications Office resolver: the non-browser route to the same
	// CELEX texts (EUR-Lex HTML is behind a JavaScript challenge).
	"publications.europa.eu",
	"www.ensreg.eu",
	"www.wenra.eu",
	"wenra.eu",
	"www.aerb.gov.in",
	"aerb.gov.in",
	"www.nra.go.jp",
	"www.iaea.org",
	"www-pub.iaea.org",
	"warp.da.ndl.go.jp",
	"warp.ndl.go.jp",
	"www.cas.go.jp",
	"www.tepco.co.jp",
	"www.japan.kantei.go.jp",
]);

export function isAllowedSourceUrl(raw: unknown): raw is string {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
		return false;
	}
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	return (
		url.protocol === "https:" &&
		url.username === "" &&
		url.password === "" &&
		url.port === "" &&
		ALLOWED_SOURCE_HOSTS.has(url.hostname.toLowerCase())
	);
}

/** "nrc.gov" for display next to a link — derived, never user-supplied. */
export function displayHost(url: string): string {
	try {
		return new URL(url).hostname
			.replace(/^www\d?\./, "")
			.replace(/^www-pub\./, "");
	} catch {
		return "source";
	}
}
