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

export function detectJailbreakMarkers(text: string): string[] {
	return JAILBREAK_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
}

export function knowledgeHubQuerySchema(tier: Tier) {
	return z.object({
		query: z
			.string()
			.transform(sanitizeQueryText)
			.pipe(
				z
					.string()
					.min(1, "Query cannot be empty")
					.max(
						QUERY_CHAR_CAP[tier],
						`Query exceeds ${QUERY_CHAR_CAP[tier]} character limit for your tier`,
					),
			),
	});
}

export const STATIONS = ["Bruce A"] as const;
export const UNITS = ["Unit 0", "Unit 1", "Unit 2", "Unit 3", "Unit 4"] as const;
export const SHIFTS = ["Day", "Evening", "Night"] as const;

export const generatorInputSchema = z.object({
	station: z.enum(STATIONS),
	unit: z.enum(UNITS),
	shift: z.enum(SHIFTS),
});

export type GeneratorInput = z.infer<typeof generatorInputSchema>;
