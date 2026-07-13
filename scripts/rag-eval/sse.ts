// RAG eval framework — AI SDK v6 SSE parser (item-2 slice 2.1, R8).
//
// Extends the scripts/eval-kb.ts:147-165 text-only parser to ALSO capture
// the `data-sources` frame the route emits (route.ts data-sources write).
// The frame is ABSENT on jailbreak-guard / OOS-gate refusals (Edge case 4) —
// callers must tolerate `sources === null`.

export interface SourceChunk {
	id: number;
	regdoc_id: string;
	section_number: string | null;
	section_title: string | null;
	url: string | null;
	similarity: number;
	requirement_type: "requirement" | "guidance" | null;
	snippet: string;
}

export interface ParsedStream {
	text: string;
	sources: SourceChunk[] | null;
}

export function parseStream(raw: string): ParsedStream {
	const lines = raw.split("\n");
	let accumulated = "";
	let sources: SourceChunk[] | null = null;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			const obj = JSON.parse(payload);
			if (obj?.type === "text-delta" && typeof obj.delta === "string") {
				accumulated += obj.delta;
			} else if (
				obj?.type === "data-sources" &&
				Array.isArray(obj.data?.chunks)
			) {
				sources = obj.data.chunks as SourceChunk[];
			}
		} catch {
			// Non-JSON data frames (start/end markers) — ignore.
		}
	}
	return { text: accumulated, sources };
}
