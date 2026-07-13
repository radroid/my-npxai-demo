import { z } from "zod";

export type Tier = "anon" | "signed_in" | "npx_circle";

export const QUERY_CHAR_CAP: Record<Tier, number> = {
	anon: 1000,
	signed_in: 1500,
	npx_circle: 2500,
};

export const OUTPUT_MAX_TOKENS: Record<Tier, number> = {
	anon: 800,
	signed_in: 1000,
	npx_circle: 1500,
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

// Zero-width / invisible chars used to smuggle jailbreak markers past the
// regex scan ("ig<ZWSP>nore previous"). ZWSP, ZWNJ, ZWJ, word joiner, BOM.
const ZERO_WIDTH_CHARS = /[\u200B-\u200D\u2060\uFEFF]/g;

// Absolute input ceiling, enforced before the per-tier char cap. Above any
// current or future tier cap — a long wall-of-noise + needle attack must
// never reach the model even if a tier's cap is later raised.
export const HARD_INPUT_CEILING = 8000;

export const JAILBREAK_PATTERNS: RegExp[] = [
	/ignore (all )?previous/i,
	/disregard (the )?above/i,
	/you are now/i,
	/system:\s/i,
	/\bDAN\b/,
	/pretend (you|to be)/i,
	/repeat (the|your) (words|instructions|prompt)/i,
	/translate (your|the|these) instructions/i,
	/(last|first) sentence of (your|the) (system )?prompt/i,
	/in a (fictional|hypothetical) scenario/i,
	/(developer|debug|audit) mode/i,
	/system prompt/i,
	/i('?m| am) an? (npx|engineer|auditor|recruiter)/i,
	// French — Canada is bilingual and this is a CNSC bot, so a French
	// jailbreak is a realistic vector, not an exotic one.
	/ignorez (toutes )?(les )?instructions/i,
	/oubliez (toutes )?(les )?(vos )?instructions/i,
	/révélez (votre|le|moi|nous)/i,
];

// Leetspeak fold: map common digit/symbol substitutions back to letters so
// obfuscated text ("1gn0r3 4ll pr3v10u5") still matches the patterns. Applied
// ONLY to the scan copy — the query sent downstream is untouched, so
// regulatory tokens like "REGDOC-2.7.1" are never corrupted.
const LEET_MAP: Record<string, string> = {
	"0": "o",
	"1": "i",
	"3": "e",
	"4": "a",
	"5": "s",
	"7": "t",
	"@": "a",
	$: "s",
};
function leetFold(text: string): string {
	return text.replace(/[013457@$]/g, (c) => LEET_MAP[c] ?? c);
}

// NFKC folds compatibility variants (full-width chars, ligatures) back to
// their canonical form so obfuscated jailbreak text matches the patterns;
// then strip zero-width smuggling chars and control chars.
export function sanitizeQueryText(raw: string): string {
	return raw
		.normalize("NFKC")
		.replace(ZERO_WIDTH_CHARS, "")
		.replace(CONTROL_CHARS, "")
		.trim();
}

// Find long base64 runs in the text, decode them, and return the
// concatenated decoded text (NFKC-normalized) for a second jailbreak scan.
// The 40-char floor keeps ordinary tokens out; returns null when nothing
// decodes — callers treat null as "no probe".
export function decodeBase64Probe(text: string): string | null {
	const runs = text.match(/[A-Za-z0-9+/]{40,}={0,2}/g);
	if (!runs) return null;
	const decoded: string[] = [];
	for (const run of runs) {
		try {
			const out = atob(run);
			if (out) decoded.push(out.normalize("NFKC"));
		} catch {
			// Not valid base64 — skip.
		}
	}
	return decoded.length > 0 ? decoded.join(" ") : null;
}

// Strip HTML tags + JS function-call leftovers from user input before
// embedding + LLM dispatch. Matches the defence-in-depth posture for chunk
// text (Appendix D.2) — user queries like `<script>alert('x')</script>`
// would otherwise (a) pollute the embedding so retrieval quality drops,
// and (b) read as "an attack" to the LLM which then refuses the benign
// portion of the question ("What is shift turnover?" here).
//
// The second regex targets `word('…')` / `word("…")` — JS function calls
// with quoted-string arguments — while leaving regulatory parentheticals
// like "(Appendix D.1.1)" or "(see §3.1)" untouched since they don't
// contain quoted strings.
export function stripHtmlTags(raw: string): string {
	return raw
		.replace(/<[^>]*>/g, " ")
		.replace(/\b\w+\s*\(\s*['"][^)]*['"][^)]*\)/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// Scan both the raw text and a leetspeak-folded copy so digit/symbol
// substitution can't slip a jailbreak phrase past the patterns.
export function detectJailbreakMarkers(text: string): string[] {
	const folded = leetFold(text);
	const hits = new Set<string>();
	for (const re of JAILBREAK_PATTERNS) {
		if (re.test(text) || re.test(folded)) hits.add(re.source);
	}
	return [...hits];
}

export const STATIONS = ["Bruce A"] as const;
export const UNITS = [
	"Unit 0",
	"Unit 1",
	"Unit 2",
	"Unit 3",
	"Unit 4",
] as const;
export const SHIFTS = ["Day", "Evening", "Night"] as const;

export const generatorInputSchema = z.object({
	station: z.enum(STATIONS),
	unit: z.enum(UNITS),
	shift: z.enum(SHIFTS),
});

// Artifact mode takes a single question, not a UIMessage[] thread. Length /
// emptiness are enforced by the route AFTER sanitizeQueryText + stripHtmlTags
// (mirroring the chat route), so the schema only pins the shape.
export const artifactInputSchema = z.object({
	query: z.string(),
});
