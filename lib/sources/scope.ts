// Source scope resolution (PLAN.md Phase 12, "auto and pinned scopes").
//
// The user picks a scope the way they would pick a model: "Auto" (default) or
// one pinned collection. resolveScope() turns that choice plus the question
// into exactly one of three outcomes:
//
//   single   — search one collection
//   compare  — search several, side by side (only on explicit comparison
//              intent in Auto mode)
//   notice   — answer deterministically WITHOUT retrieval or a model call:
//              the question targets something outside the selected/enabled
//              sources, or names several regimes without asking to compare.
//
// Rules (the plan's, verbatim in spirit):
//   • Auto + no jurisdiction named          → the default collection (CNSC)
//   • Auto + exactly one indexed collection → that collection
//   • Auto + several + comparison intent    → compare
//   • Auto + several, no comparison intent  → ask which one (never mix
//                                             regimes silently)
//   • Pinned                                → stays pinned; a question that
//     names ONLY other regimes gets a notice telling the user to switch
//     rather than an answer built from the wrong regulator.
//
// Pure and deterministic: no I/O, no user text echoed into notices (labels
// come from the catalogue), so it is safe to unit-test exhaustively and safe
// to stream verbatim.

import { z } from "zod";
import { SCOPE_NOTICE_MARKER_TEXT } from "../prompts";
import { COLLECTION_IDS, COLLECTIONS, type CollectionId } from "./catalog";

export const scopeRequestSchema = z.discriminatedUnion("mode", [
	z.object({
		mode: z.literal("auto"),
		historical: z.boolean().optional(),
	}),
	z.object({
		mode: z.literal("pinned"),
		collection: z.enum(COLLECTION_IDS),
		historical: z.boolean().optional(),
	}),
]);
export type ScopeRequest = z.infer<typeof scopeRequestSchema>;

export const AUTO_SCOPE: ScopeRequest = { mode: "auto" };

export type NoticeReason =
	| "pinned_mismatch"
	| "ambiguous"
	| "reference_only"
	| "not_indexed"
	| "not_enabled";

export type ResolvedScope =
	| {
			kind: "single";
			collection: CollectionId;
			via: "pinned" | "auto_default" | "auto_detected";
			historical: boolean;
	  }
	| {
			kind: "compare";
			collections: CollectionId[];
			historical: boolean;
	  }
	| {
			kind: "notice";
			reason: NoticeReason;
			message: string;
			/** Collections the UI can offer as one-click switches. */
			suggestions: CollectionId[];
	  };

// Jurisdiction signals. Short acronyms that collide with ordinary words are
// matched case-SENSITIVELY ("US" not "us", "EU", "UK", "NRA"); names and
// distinctive acronyms are case-insensitive. Adjectives are deliberately
// absent: "British" (British Columbia), "Indian" (Indian Point, a US plant),
// "American" (ASME codes cited by CNSC) and "European" (the EPR design) all
// appear in ordinary single-regulator questions.
const MENTION_RULES: Array<{ collection: CollectionId; res: RegExp[] }> = [
	{
		collection: "cnsc",
		res: [
			/\bCNSC\b/i,
			/\bREGDOCs?\b/i,
			/\bNSCA\b/i,
			/Nuclear Safety and Control Act/i,
			/Canadian Nuclear Safety Commission/i,
			/\bCanad(?:a|ian)\b/i,
		],
	},
	{
		collection: "nrc",
		res: [
			/\bNRC\b/i,
			/\bNuclear Regulatory Commission\b/i,
			/\b10\s*C\.?F\.?R\.?\b/i,
			/\bNUREG\b/i,
			/\bRegulatory Guides? \d/i,
			/\bRG\s?\d{1,2}\.\d{1,3}\b/,
			/\bUnited States\b/i,
			/\bU\.S\.(?:A\.)?/,
			/\bUSA?\b/,
		],
	},
	{
		collection: "onr",
		res: [
			/\bONR\b/,
			/\bOffice for Nuclear Regulation\b/i,
			/\bSafety Assessment Principles\b/i,
			/\bSAPs\b/,
			/\bNS-TAST-GD-\d+/i,
			/\bUnited Kingdom\b/i,
			/\bUK\b/,
			/\bGreat Britain\b/i,
		],
	},
	{
		collection: "eu",
		res: [
			/\bEuratom\b/i,
			/\bEU\b/,
			/\bEuropean Union\b/i,
			/\bWENRA\b/i,
			/\bENSREG\b/i,
			/\bDirective\s+\d{4}\/\d+/i,
		],
	},
	{
		collection: "aerb",
		res: [/\bAERB\b/i, /\bAtomic Energy Regulatory Board\b/i, /\bIndia\b/i],
	},
	{
		collection: "fukushima",
		res: [
			/\bFukushima\b/i,
			/\bDaiichi\b/i,
			/\bTEPCO\b/i,
			/\bNAIIC\b/i,
			/\bNRA\b/,
			/\bNuclear Regulation Authority\b/i,
			/\bJapan(?:ese)?\b/i,
		],
	},
	{
		collection: "iaea",
		res: [
			/\bIAEA\b/i,
			/\bInternational Atomic Energy Agency\b/i,
			/\b(?:SSR|GSR|SSG|GSG|NS-G)[-\s]?\d/i,
			/\bSF-1\b/i,
			/\bINFCIRC\b/i,
			/\bIRRS\b/i,
		],
	},
];

// Regulators/jurisdictions with no collection at all. Country names and
// regulator acronyms only — never language adjectives ("in French" is an
// ordinary question about a bilingual CNSC document).
const NOT_INDEXED_RE =
	/\b(?:Rostechnadzor|Russia|France|ASN|China|Korea|NSSC|KINS|Finland|STUK|Sweden|Germany|Switzerland|ENSI|Spain|Belgium|FANC|Ukraine|SNRIU|South Africa|Pakistan|PNRA|UAE|FANR|Australia|ARPANSA|Argentina|Brazil)\b/;

const COMPARE_RE =
	/\b(?:compare[ds]?|comparing|comparison|versus|vs\.?|differ(?:s|ent|ence|ences)?|contrast(?:s|ing)?|similar(?:ity|ities)?|both|between)\b/i;

export interface Mentions {
	collections: CollectionId[];
	notIndexed: boolean;
}

export function detectMentions(query: string): Mentions {
	const collections: CollectionId[] = [];
	for (const rule of MENTION_RULES) {
		if (rule.res.some((re) => re.test(query)))
			collections.push(rule.collection);
	}
	return { collections, notIndexed: NOT_INDEXED_RE.test(query) };
}

export function hasComparisonIntent(query: string): boolean {
	return COMPARE_RE.test(query);
}

function labelOf(id: CollectionId): string {
	const c = COLLECTIONS[id];
	return `${c.label} (${c.region})`;
}

function listLabels(ids: CollectionId[]): string {
	const labels = ids.map(labelOf);
	if (labels.length <= 1) return labels.join("");
	return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function availableSentence(enabled: CollectionId[]): string {
	return `This assistant currently answers from: ${listLabels(enabled)}.`;
}

// Every notice carries this sentence so evals (and humans skimming logs) can
// recognise a deliberate scope decline by what the app actually emitted.
export const SCOPE_NOTICE_MARKER = SCOPE_NOTICE_MARKER_TEXT;

export interface ResolveScopeInput {
	request: ScopeRequest;
	query: string;
	/** Collections this deployment serves, in display order. */
	enabled: CollectionId[];
	/** Collection used for unqualified Auto questions. */
	defaultCollection: CollectionId;
}

export function resolveScope(input: ResolveScopeInput): ResolvedScope {
	const { request, query, enabled, defaultCollection } = input;
	const historical = request.historical === true;
	const mentions = detectMentions(query);
	const isEnabled = (id: CollectionId) => enabled.includes(id);
	const searchableMentions = mentions.collections.filter(
		(id) => COLLECTIONS[id].searchable,
	);

	// Nothing to search at all (misconfigured deployment) — decline rather
	// than resolve to an undefined collection. config.ts also keeps the app
	// in legacy mode in this state; this is the second line.
	if (enabled.length === 0) {
		return {
			kind: "notice",
			reason: "not_enabled",
			message: `No regulatory sources are available right now, so this is ${SCOPE_NOTICE_MARKER}.`,
			suggestions: [],
		};
	}

	if (request.mode === "pinned") {
		const pinned = request.collection;
		// Pinned to something this deployment does not serve (stale client
		// state, or a crafted request) — never silently fall back elsewhere.
		if (!isEnabled(pinned) || !COLLECTIONS[pinned].searchable) {
			return {
				kind: "notice",
				reason: "not_enabled",
				message: `${labelOf(pinned)} sources are not available, so this is ${SCOPE_NOTICE_MARKER}. ${availableSentence(enabled)}`,
				suggestions: enabled.slice(0, 3),
			};
		}
		const others = mentions.collections.filter((id) => id !== pinned);
		const namesPinned = mentions.collections.includes(pinned);
		if (!namesPinned && (others.length > 0 || mentions.notIndexed)) {
			const suggestions = others.filter(
				(id) => isEnabled(id) && COLLECTIONS[id].searchable,
			);
			const what = others.length > 0 ? listLabels(others) : "another regulator";
			const switchHint =
				suggestions.length > 0
					? `Switch the source selector to ${COLLECTIONS[suggestions[0]].label} or Auto to search it.`
					: availableSentence(enabled);
			return {
				kind: "notice",
				reason: "pinned_mismatch",
				message: `Sources are pinned to ${labelOf(pinned)}, but your question asks about ${what} — ${SCOPE_NOTICE_MARKER}. ${switchHint}`,
				suggestions,
			};
		}
		return { kind: "single", collection: pinned, via: "pinned", historical };
	}

	// ---- Auto ----
	const indexed = searchableMentions.filter(isEnabled);

	if (indexed.length === 0) {
		if (mentions.collections.length === 0 && !mentions.notIndexed) {
			const fallback = isEnabled(defaultCollection)
				? defaultCollection
				: enabled[0];
			return {
				kind: "single",
				collection: fallback,
				via: "auto_default",
				historical,
			};
		}
		if (mentions.collections.includes("iaea")) {
			return {
				kind: "notice",
				reason: "reference_only",
				message: `IAEA safety standards are catalogued as reference links only — their text is not stored here, so quoting them is ${SCOPE_NOTICE_MARKER}. ${availableSentence(enabled)}`,
				suggestions: enabled.slice(0, 3),
			};
		}
		const disabled = searchableMentions.filter((id) => !isEnabled(id));
		if (disabled.length > 0) {
			return {
				kind: "notice",
				reason: "not_enabled",
				message: `${listLabels(disabled)} sources are not available yet, so this is ${SCOPE_NOTICE_MARKER}. ${availableSentence(enabled)}`,
				suggestions: enabled.slice(0, 3),
			};
		}
		return {
			kind: "notice",
			reason: "not_indexed",
			message: `That regulator's documents are not indexed, so this is ${SCOPE_NOTICE_MARKER}. ${availableSentence(enabled)}`,
			suggestions: enabled.slice(0, 3),
		};
	}

	// A comparison that names a regime we cannot search must say so, not
	// quietly answer one side of it.
	const unsearchable = mentions.collections.filter(
		(id) => !isEnabled(id) || !COLLECTIONS[id].searchable,
	);
	const comparing = hasComparisonIntent(query);
	if (comparing && unsearchable.length > 0) {
		return {
			kind: "notice",
			reason: unsearchable.includes("iaea") ? "reference_only" : "not_enabled",
			message: `I can't compare against ${listLabels(unsearchable)} — those sources are not searchable here, so that comparison is ${SCOPE_NOTICE_MARKER}. ${availableSentence(enabled)}`,
			suggestions: indexed,
		};
	}
	// "Compare CNSC and Finland …": the other side has no collection at all.
	if (comparing && mentions.notIndexed) {
		return {
			kind: "notice",
			reason: "not_indexed",
			message: `I can't compare against that regulator — its documents are not indexed, so that comparison is ${SCOPE_NOTICE_MARKER}. ${availableSentence(enabled)}`,
			suggestions: indexed,
		};
	}

	if (indexed.length === 1) {
		return {
			kind: "single",
			collection: indexed[0],
			via: "auto_detected",
			historical,
		};
	}

	if (comparing) {
		return { kind: "compare", collections: indexed.slice(0, 3), historical };
	}
	return {
		kind: "notice",
		reason: "ambiguous",
		message: `Your question mentions ${listLabels(indexed)}. Pick one in the source selector, or ask me to compare them (for example "Compare ${COLLECTIONS[indexed[0]].label} and ${COLLECTIONS[indexed[1]].label} on …"). Answering from a mix of regimes without that would be ${SCOPE_NOTICE_MARKER}.`,
		suggestions: indexed,
	};
}

/** Stable cache/log key for a resolved (non-notice) scope. */
export function scopeKey(scope: ResolvedScope): string {
	if (scope.kind === "single") {
		return `single:${scope.collection}${scope.historical ? ":hist" : ""}`;
	}
	if (scope.kind === "compare") {
		return `compare:${[...scope.collections].sort().join("+")}${scope.historical ? ":hist" : ""}`;
	}
	return `notice:${scope.reason}`;
}

/** The collections a resolved scope searches (empty for notices). */
export function scopeCollections(scope: ResolvedScope): CollectionId[] {
	if (scope.kind === "single") return [scope.collection];
	if (scope.kind === "compare") return scope.collections;
	return [];
}
