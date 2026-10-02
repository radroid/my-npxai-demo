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
//
// A mention is either the question's REGIME (routes Auto, declines a pin,
// makes an explicit comparison) or INCIDENTAL (a cue at most):
//   res          — regime mentions: a regulator, its documents;
//   countries    — the regulator's country: a regime unless the question is
//                  about trade or movement, compares nothing, and the
//                  country is not its subject ("import a source from a US
//                  supplier", "export to a customer in Japan");
//   incidental   — always incidental: an event ("post-Fukushima");
//   incidentalPhrases — phrases removed before `res` is tested: CNSC's own
//                  use of an IAEA scheme ("IAEA Category 1", "IAEA
//                  safeguards", "report to the IAEA").
// A comparison SLOT ("differ from the IAEA", "lower than the US") makes any
// mention a regime.
const MENTION_RULES: Array<{
	collection: CollectionId;
	res: RegExp[];
	countries?: RegExp[];
	incidental?: RegExp[];
	incidentalPhrases?: RegExp[];
}> = [
	{
		collection: "cnsc",
		res: [
			/\bCNSC\b/i,
			/\bREGDOCs?\b/i,
			/\bNSCA\b/i,
			/Nuclear Safety and Control Act/i,
			/Canadian Nuclear Safety Commission/i,
			// CNSC is the default collection: "Canada" is always its regime.
			/\bCanad(?:a|ian)\b(?!-)/i,
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
		],
		// Not in a compound: "US-designed reactors" is a design.
		countries: [/\bUnited States\b/i, /\bU\.S\.(?:A\.)?(?!-)/, /\bUSA?\b(?!-)/],
	},
	{
		collection: "onr",
		res: [
			/\bONR\b/,
			/\bOffice for Nuclear Regulation\b/i,
			/\bSafety Assessment Principles\b/i,
			/\bSAPs\b/,
			/\bNS-TAST-GD-\d+/i,
		],
		countries: [/\bUnited Kingdom\b/i, /\bUK\b(?!-)/, /\bGreat Britain\b/i],
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
		res: [/\bAERB\b/i, /\bAtomic Energy Regulatory Board\b/i],
		countries: [/\bIndia\b(?!-)/i],
	},
	{
		collection: "fukushima",
		incidental: [/\bFukushima\b/i, /\bDaiichi\b/i],
		res: [
			/\bTEPCO\b/i,
			/\bNAIIC\b/i,
			/\bNRA\b/,
			/\bNuclear Regulation Authority\b/i,
		],
		countries: [/\bJapan(?:ese)?\b(?!-)/i],
	},
	{
		collection: "iaea",
		// The IAEA as the SUBJECT: a safety standard named, or the IAEA's own
		// requirements, limits, recommendations or position. Any other
		// mention is CNSC's own use of an IAEA scheme — transport packages
		// and certificates (the PTNSR adopts the IAEA Regulations),
		// safeguards (Additional Protocol, seals, cameras), source categories
		// and D-values — and is incidental.
		res: [
			/\b(?:SSR|GSR|SSG|GSG|NS-G)[-\s]?\d/i,
			/\bGSR\s+Part\s+\d/i,
			/\bSF-1\b/i,
			/\bIRRS\b/i,
			/\bINFCIRC\b/i,
			/\b(?:Nuclear Security Series|Safety (?:Standards|Reports?) Series)\b/i,
			/\b(?:IAEA|International Atomic Energy Agency)(?:['’]s\b|\s+(?:[\w-]+\s+){0,2}?(?:requirements?|limits?|standards?|recommendations?|recommends?|requires?|approach|position|view|guidance|principles?|definitions?|defines?|says?|states?|expects?|Code of Conduct)\b)/i,
			/\b(?:does|do|did|would)\s+(?:the\s+)?IAEA\b/i,
			/\baccording to (?:the\s+)?IAEA\b/i,
		],
		incidental: [/\bIAEA\b/i, /\bInternational Atomic Energy Agency\b/i],
		// Stripped before `res` is tested: "the IAEA safeguards requirements"
		// is a CNSC safeguards question.
		incidentalPhrases: [
			/\b(?:the\s+)?IAEA\s+(?:source\s+)?(?:categor\w*|Category\s+\d|scheme|classification)/gi,
			/\b(?:the\s+)?IAEA\s+(?:safeguards?|inspect\w*)/gi,
			/\b(?:safeguards?|inspect\w*|report\w*|submit\w*|notif\w*|declar\w*|agreements?)\b[^.?!]{0,40}?\b(?:to|with|by)\s+the\s+IAEA\b/gi,
		],
	},
];

// Regulators/jurisdictions with no collection at all. Country names and
// regulator acronyms only — never language adjectives ("in French" is an
// ordinary question about a bilingual CNSC document). Acronyms match
// case-sensitively like MENTION_RULES; country names in any case.
const UNINDEXED_ACRONYMS =
	"Rostechnadzor|ASN|NSSC|KINS|STUK|ENSI|FANC|SNRIU|PNRA|FANR|ARPANSA";
const UNINDEXED_REGULATOR_RE = new RegExp(`\\b(?:${UNINDEXED_ACRONYMS})\\b`);
const COUNTRIES =
	"Russia|France|China|Korea|Finland|Sweden|Germany|Switzerland|Spain|Belgium|Ukraine|South Africa|Pakistan|UAE|Australia|Argentina|Brazil";
const UNINDEXED_COUNTRY_RE = new RegExp(`\\b(?:${COUNTRIES})\\b(?!-)`, "i");

// Words that make a phrase about a jurisdiction's RULES: right after the
// country ("France requires", "Spain requirements"), or governing it
// ("regulated in Sweden", "mandatory in Finland"). Nouns that are also
// permits/licences ("an export permit for China") are not among them.
const ADJACENT_RULE_WORDS =
	"requirements?|regulations?|regulators?|rules|limits?|standards?|laws?|requires?|regulates?|mandates?|allows?|permits?|prohibits?";
const GOVERNING_RULE_WORDS =
	"requirements?|regulat\\w*|licensing|rules|limits?|standards?|laws?|legal|required|mandatory|allowed|permitted|prohibited|banned";
// Trade and movement words: a country after them is a destination or an
// origin, not the regime ("requirements for exporting to a customer in
// Korea", "sources from France and China"). TRADE_RE (without "from",
// which also introduces comparisons) marks a trade QUESTION.
// ("transport" is not among them: it is a regulatory topic — the PTNSR.)
const TRADE_CORE =
	"export\\w*|import\\w*|ship\\w*|transfer\\w*|supplier\\w*|customer\\w*|vendor\\w*|client\\w*|buyer\\w*|destin\\w*|cross-border|border";
const TRADE_WORDS = `${TRADE_CORE}|bound|from`;
const TRADE_RE = new RegExp(`\\b(?:${TRADE_CORE})\\b`, "i");
// A country as the SUBJECT of the question — its own rules: "Finland's",
// "France requires", "Spain requirements" (adjacent), or a rules word
// governing the place: "regulated in Sweden", "mandatory in Finland", "the
// dose limit for workers in Finland". Never a country as a place alone:
// "export tritium to a customer in Korea", "a supplier in France", "an
// APR1400 operating in Korea", "the Chernobyl accident in Ukraine", "a
// pump manufactured in China" are ordinary questions for the indexed
// regulator (with the UNINDEXED REGULATOR cue).
function countrySubjectRe(countries: string): RegExp {
	const c = `(?:${countries})(?![\\w-])`;
	return new RegExp(
		`\\b${c}(?:['’]s\\b|\\s+(?:${ADJACENT_RULE_WORDS})\\b)|\\b(?:${GOVERNING_RULE_WORDS})\\b(?:(?!\\b(?:${TRADE_WORDS})\\b)[^,.?!;:]){0,40}?(?<!\\b(?:built|made|manufactured|fabricated|produced|sourced|supplied|designed|certified|licensed)\\s)\\b(?:in|for|of|within)\\s+(?:the\\s+)?(?:Republic\\s+of\\s+)?\\b${c}`,
		"i",
	);
}
const COUNTRY_AS_SUBJECT_RE = countrySubjectRe(COUNTRIES);
// The same test for an indexed regulator's country (MENTION_RULES
// `countries`): is "the US" the subject, or a trade partner?
const INDEXED_COUNTRY_NAMES: Partial<Record<CollectionId, string>> = {
	cnsc: "Canada|Canadian",
	nrc: "United States|U\\.S\\.A?\\.?|USA?",
	onr: "United Kingdom|UK|Great Britain",
	aerb: "India",
	fukushima: "Japan|Japanese",
};
const INDEXED_COUNTRY_SUBJECT = Object.fromEntries(
	Object.entries(INDEXED_COUNTRY_NAMES).map(([id, names]) => [
		id,
		countrySubjectRe(names as string),
	]),
) as Partial<Record<CollectionId, RegExp>>;

// The names that put a collection's regime into a comparison slot (below).
// `regulators` always count. `countries` count in a "between/both/compare
// X and R" pair only when the question also has a comparison or rules word
// ("transfers between Canada and Korea" is trade; "do both Canada and the
// US require a PSA?" compares). The *Cs lists are case-sensitive short
// acronyms, as in MENTION_RULES ("us", "eu" are words).
interface RegimeNames {
	regulators?: string;
	regulatorsCs?: string;
	countries?: string;
	countriesCs?: string;
}
const REGIME_NAMES: Record<CollectionId, RegimeNames> = {
	cnsc: {
		regulators: "CNSC|Canadian Nuclear Safety Commission",
		countries: "Canada",
	},
	nrc: {
		regulators:
			"(?:U\\.?S\\.?\\s+)?NRC|Nuclear Regulatory Commission|10\\s*C\\.?F\\.?R\\.?|NUREG[-\\s]?\\d+|Regulatory Guides?\\s+\\d+(?:\\.\\d+)?",
		regulatorsCs: "RG\\s?\\d{1,2}(?:\\.\\d{1,3})?",
		countries: "United States|U\\.S\\.A?\\.?",
		countriesCs: "USA?",
	},
	onr: {
		regulators:
			"ONR|Office for Nuclear Regulation|Safety Assessment Principles|NS-TAST-GD-\\d+",
		regulatorsCs: "SAPs",
		countries: "United Kingdom|Great Britain",
		countriesCs: "UK",
	},
	eu: {
		regulators:
			"Euratom|European Union|WENRA|ENSREG|Directive\\s+\\d{4}\\/\\d+(?:\\/\\w+)?",
		regulatorsCs: "EU",
	},
	aerb: {
		regulators: "AERB|Atomic Energy Regulatory Board",
		countries: "India",
	},
	fukushima: {
		regulators: "Nuclear Regulation Authority",
		regulatorsCs: "NRA",
		countries: "Japan",
	},
	iaea: {
		regulators:
			// "IAEA" alone or before a regime noun — not "the IAEA A2 value",
			// "the IAEA D-value", "IAEA Category 1" (CNSC's own quantities).
			"(?:IAEA|International Atomic Energy Agency)(?=\\s*(?:[?.,;:!)]|$)|\\s+(?:on|in|for|and|or|does|do|did|BSS|(?:basic\\s+)?safety\\s+standards?|standards?|requirements?|requires?|limits?|recommendations?|recommends?|guidance|approach(?:es)?|position|says?)\\b|['’]s)|(?:IAEA\\s+)?(?:(?:SSR|GSR|SSG|GSG|NS-G)[-\\s]?\\d+(?:[./-]\\d+)*|GSR\\s+Part\\s+\\d+|SF-1)",
	},
};
const UNINDEXED_NAMES: RegimeNames = {
	regulatorsCs: UNINDEXED_ACRONYMS,
	countries: COUNTRIES,
};

// Comparison words besides a pair's own "between"/"both"/"and".
const COMPARISON_WORDS =
	"differ\\w*|similar\\w*|compar\\w*|contrast\\w*|versus|vs|stricter|stronger|weaker|higher|lower|more (?:stringent|conservative|prescriptive|restrictive)|less (?:stringent|conservative|prescriptive|restrictive)";
const COMPARISON_CONTEXT_RE = new RegExp(`\\b(?:${COMPARISON_WORDS})\\b`, "i");
// "…both Canada and the US require…" (a rules verb right after a pair) or
// "required in both Canada and the UK" (a rules word right before it).
const PAIR_VERB_RE = new RegExp(
	`\\band\\s+(?:the\\s+)?\\S+(?:\\s+\\S+)?\\s+(?:require|mandate|allow|permit|prohibit|regulate|set|limit)s?\\b|\\b(?:${GOVERNING_RULE_WORDS})\\s+(?:in|for|by|under)\\s+both\\b`,
	"i",
);
// A pair or joined pair of COUNTRIES compares only with a comparison word
// or a rules verb at the pair ("transfers between Canada and Korea" does
// not; the slot itself skips pairs a trade word governs).
const countryPairContext = (q: string) =>
	COMPARISON_CONTEXT_RE.test(q) || (PAIR_VERB_RE.test(q) && !TRADE_RE.test(q));
const joinedContext = (q: string) => COMPARISON_CONTEXT_RE.test(q);
const countryJoinedContext = joinedContext;
// Any regime, indexed or not, as the OTHER side of an "X and R" pair.
const ANY_REGIME =
	"CNSC|Canadian Nuclear Safety Commission|Canada|Canadian|REGDOC[-\\s]?\\d[\\d.]*|NRC|United States|U\\.S\\.|US|ONR|UK|United Kingdom|EU|Euratom|European Union|AERB|India|NRA|Japan|IAEA";

// A regime R in a comparison slot, with "the", "those in/of", "that of" or
// "in (the)" allowed before it:
//   pair:   "between X and R", "between R and X", "both X and R",
//           "compare X and R" — not across a trade word ("between sources
//           from France and China");
//   joined: "CNSC and US dose limits: what is the difference?" — only with
//           a comparison word elsewhere in the question;
//   direct: "differ(s) from R", "similar to R", "compared with R",
//           "compare X with R", "than R" (not "other than" / "rather
//           than"), "X vs R".
// R never counts as part of a compound ("US-designed", "Korea-made").
// "The difference between Category 1 and 2 … in the IAEA categorisation"
// has no regime in a slot, so it is an ordinary question. Written with
// [Xx] classes so the same source compiles case-sensitively for acronyms.
const LEAD =
	"(?:[Tt]he\\s+|[Tt]hose\\s+(?:in|of)\\s+(?:the\\s+)?|[Tt]hat\\s+of\\s+(?:the\\s+)?|in\\s+(?:the\\s+)?)?";
function slotSources(
	names: string,
	tradeGuard: boolean,
): {
	pair: string;
	joined: string;
	direct: string;
} {
	const r = `\\b(?:${names})(?:['’]s)?(?![A-Za-z0-9-])`;
	// For countries: not a pair a trade word governs ("shipments between
	// Canada and the US", "for shipments to the US and France").
	const notTraded = tradeGuard
		? `(?<!\\b(?:${TRADE_CORE})(?:\\s+[\\w-]+){0,2}\\s+(?:(?:to|from|into|via|for)\\s+)?(?:the\\s+)?)`
		: "";
	const pairLead = `${notTraded}\\b(?:[Bb]etween|[Bb]oth|[Cc]ompar(?:e[ds]?|ing))\\s+`;
	const gap = `(?:(?!\\b(?:${TRADE_WORDS})\\b)[^,.?;:]){0,60}?`;
	const x = `${notTraded}\\b(?:${ANY_REGIME})(?:['’]s)?(?![A-Za-z0-9-])`;
	return {
		pair: [
			`${pairLead}${gap}\\band\\s+${LEAD}${r}`,
			`${pairLead}${LEAD}${r}${gap}\\band\\b`,
		].join("|"),
		joined: [
			`${x}\\s+(?:and|or|&)\\s+${LEAD}${r}`,
			`${r}\\s+(?:and|or|&)\\s+${LEAD}${x}`,
		].join("|"),
		direct: [
			`\\b(?:[Dd]iffer(?:s|ed|ent|ence|ences)?|[Ss]imilar(?:ity|ities)?|[Cc]ompared?|[Cc]omparison|[Cc]ontrast(?:s|ed)?)\\s+(?:from|to|with|between)\\s+${LEAD}${r}`,
			`\\b[Cc]ompar(?:e[ds]?|ing)\\b[^,.?;:]{0,60}?\\b(?:with|to|against)\\s+${LEAD}${r}`,
			`(?<!\\b(?:[Oo]ther|[Rr]ather)\\s)\\b[Tt]han\\s+${LEAD}${r}`,
			`\\b(?:vs\\.?|versus)\\s+${LEAD}${r}`,
			`${r}\\s+(?:vs\\b|versus\\b)`,
		].join("|"),
	};
}

function slotMatcher(n: RegimeNames): (query: string) => boolean {
	const res: Array<{ re: RegExp; context: ((q: string) => boolean) | null }> =
		[];
	const add = (names: string | undefined, flags: string, country: boolean) => {
		if (!names) return;
		const src = slotSources(names, country);
		res.push({ re: new RegExp(src.direct, flags), context: null });
		res.push({
			re: new RegExp(src.pair, flags),
			context: country ? countryPairContext : null,
		});
		res.push({
			re: new RegExp(src.joined, flags),
			context: country ? countryJoinedContext : joinedContext,
		});
	};
	add(n.regulators, "i", false);
	add(n.regulatorsCs, "", false);
	add(n.countries, "i", true);
	add(n.countriesCs, "", true);
	return (query) =>
		res.some(
			({ re, context }) => re.test(query) && (!context || context(query)),
		);
}

const COLLECTION_SLOT = Object.fromEntries(
	COLLECTION_IDS.map((id) => [id, slotMatcher(REGIME_NAMES[id])]),
) as Record<CollectionId, (query: string) => boolean>;
const UNINDEXED_SLOT = slotMatcher(UNINDEXED_NAMES);

/** Collections whose regime sits in a comparison slot of the question. */
export function slottedCollections(
	query: string,
	candidates: readonly CollectionId[],
): CollectionId[] {
	return candidates.filter((id) => COLLECTION_SLOT[id](query));
}

/** An unindexed regulator or country sits in a comparison slot. */
export function slotsUnindexed(query: string): boolean {
	return UNINDEXED_SLOT(query);
}

const COMPARE_RE =
	/\b(?:compare[ds]?|comparing|comparison|versus|vs\.?|differ(?:s|ent|ence|ences)?|contrast(?:s|ing)?|similar(?:ity|ities)?|both|between|stricter|higher|lower|(?:more|less) (?:stringent|conservative|prescriptive|restrictive))\b/i;
// The looser cue words above ("difference", "both", "between", "similar")
// are everyday words in single-regulator questions ("the difference between
// Category 1 and 2", "an AP1000 built in China"). They are enough to compare
// two SEARCHABLE regulators the question names, but a hard decline needs an
// explicit comparison.
const EXPLICIT_COMPARE_RE =
	/\b(?:compare[ds]?|comparing|comparison|versus|vs\.?|contrast(?:s|ing)?)\b/i;

export interface Mentions {
	collections: CollectionId[];
	/**
	 * Collections named as a regime, not only incidentally (MENTION_RULES
	 * `incidental`): what a pin, the Auto default and an explicit
	 * comparison go by.
	 */
	nonEvent: CollectionId[];
	/** Any mention of a regulator/country with no collection. */
	notIndexed: boolean;
	/**
	 * An unindexed regulator's acronym, or a country as the question's
	 * subject (COUNTRY_AS_SUBJECT_RE). A country in passing does not count.
	 */
	unindexedRegime: boolean;
}

export function detectMentions(query: string): Mentions {
	const collections: CollectionId[] = [];
	const nonEvent: CollectionId[] = [];
	// A trade question that compares nothing: its countries are partners.
	const trade =
		TRADE_RE.test(query) &&
		!COMPARISON_CONTEXT_RE.test(query) &&
		!EXPLICIT_COMPARE_RE.test(query);
	for (const rule of MENTION_RULES) {
		const stripped = (rule.incidentalPhrases ?? []).reduce(
			(q, re) => q.replace(re, " "),
			query,
		);
		const country = rule.countries?.some((re) => re.test(query)) === true;
		const regime =
			rule.res.some((re) => re.test(stripped)) ||
			(country &&
				(!trade ||
					INDEXED_COUNTRY_SUBJECT[rule.collection]?.test(query) === true));
		if (
			regime ||
			country ||
			rule.res.some((re) => re.test(query)) ||
			rule.incidental?.some((re) => re.test(query))
		)
			collections.push(rule.collection);
		if (regime) nonEvent.push(rule.collection);
	}
	const regulator = UNINDEXED_REGULATOR_RE.test(query);
	return {
		collections,
		nonEvent,
		notIndexed: regulator || UNINDEXED_COUNTRY_RE.test(query),
		unindexedRegime: regulator || COUNTRY_AS_SUBJECT_RE.test(query),
	};
}

export function hasComparisonIntent(query: string): boolean {
	return COMPARE_RE.test(query);
}

export function hasExplicitComparison(query: string): boolean {
	return EXPLICIT_COMPARE_RE.test(query);
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
		// An event ("after Fukushima") is a subject, not another regime: a
		// CNSC-pinned question about post-Fukushima requirements stays here.
		// Another regime as the subject, or in a comparison slot even when
		// only incidentally named ("How do dose limits compare with the
		// IAEA?").
		const others = [
			...new Set([
				...mentions.nonEvent,
				...slottedCollections(query, mentions.collections),
			]),
		].filter((id) => id !== pinned);
		const namesPinned = mentions.collections.includes(pinned);
		if (!namesPinned && (others.length > 0 || mentions.unindexedRegime)) {
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
	// Routing goes by REGIME mentions: "import a source from a US supplier"
	// is a CNSC question, not an NRC one.
	const indexed = mentions.nonEvent.filter(
		(id) => COLLECTIONS[id].searchable && isEnabled(id),
	);
	// A comparison against a regime we cannot search must say so, not
	// quietly answer one side of it — checked first, whatever else is named:
	//   • a slot ("differ from the IAEA", "between the NRC and ASN", "both
	//     the NRC and the IAEA", "lower than the NRC's") — even for an
	//     incidental mention, and even when nothing indexed is named;
	//   • an explicit "compare"/"versus" naming the regime.
	// A loose word alone ("difference", "both", "between") is not enough:
	// "the difference between Category 1 and 2 in the IAEA categorisation",
	// "pre- and post-Fukushima", "both CANDU and US-designed reactors" and
	// "transfers between Canada and Korea" are ordinary questions; the
	// envelope's cues cover the incidental mention.
	const unsearchable = mentions.collections.filter(
		(id) => !isEnabled(id) || !COLLECTIONS[id].searchable,
	);
	const comparing = hasComparisonIntent(query);
	const explicit = hasExplicitComparison(query);
	const unsearchableNamed = unsearchable.filter((id) =>
		mentions.nonEvent.includes(id),
	);
	const slotted = slottedCollections(query, unsearchable);
	if ((explicit && unsearchableNamed.length > 0) || slotted.length > 0) {
		const against = slotted.length > 0 ? slotted : unsearchableNamed;
		return {
			kind: "notice",
			reason: against.includes("iaea") ? "reference_only" : "not_enabled",
			message: `I can't compare against ${listLabels(against)} — those sources are not searchable here, so that comparison is ${SCOPE_NOTICE_MARKER}. ${availableSentence(enabled)}`,
			suggestions: indexed.length > 0 ? indexed : enabled.slice(0, 3),
		};
	}
	// "Compare CNSC and Finland …": the other side has no collection at all.
	if (
		mentions.notIndexed &&
		(slotsUnindexed(query) || (explicit && mentions.unindexedRegime))
	) {
		return {
			kind: "notice",
			reason: "not_indexed",
			message: `I can't compare against that regulator — its documents are not indexed, so that comparison is ${SCOPE_NOTICE_MARKER}. ${availableSentence(enabled)}`,
			suggestions: indexed.length > 0 ? indexed : enabled.slice(0, 3),
		};
	}

	if (indexed.length === 0) {
		// A country in passing ("shipments to France"), an event or CNSC's
		// own use of an IAEA scheme is an ordinary question for the default
		// collection; a regime named as the subject is not.
		if (mentions.nonEvent.length === 0 && !mentions.unindexedRegime) {
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
		if (mentions.nonEvent.includes("iaea")) {
			return {
				kind: "notice",
				reason: "reference_only",
				message: `IAEA safety standards are catalogued as reference links only — their text is not stored here, so quoting them is ${SCOPE_NOTICE_MARKER}. ${availableSentence(enabled)}`,
				suggestions: enabled.slice(0, 3),
			};
		}
		const disabled = mentions.nonEvent.filter(
			(id) => COLLECTIONS[id].searchable && !isEnabled(id),
		);
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
