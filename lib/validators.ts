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

export const JAILBREAK_PATTERNS: RegExp[] = [
	/ignore (all )?previous/i,
	/disregard (the )?above/i,
	/you are now/i,
	/system:\s/i,
];

export function sanitizeQueryText(raw: string): string {
	return raw.replace(CONTROL_CHARS, "").trim();
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

export function detectJailbreakMarkers(text: string): string[] {
	return JAILBREAK_PATTERNS.filter((re) => re.test(text)).map(
		(re) => re.source,
	);
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
