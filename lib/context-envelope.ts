// Wraps retrieved RAG chunks in <context_snippet> tags with HTML-escaped
// body text. See Appendix D.2 — the XML-like boundary is defense-in-depth
// against indirect prompt injection coming from scraped REGDOC content.

export interface RetrievedChunk {
	id: number;
	regdoc_id: string;
	section_number: string | null;
	section_title: string | null;
	chunk_text: string;
	url: string | null;
	requirement_type: "requirement" | "guidance" | null;
	similarity: number;
}

function htmlEscape(raw: string): string {
	return raw
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function attr(key: string, value: string | null | undefined): string {
	if (value === null || value === undefined || value === "") return "";
	return ` ${key}="${htmlEscape(value)}"`;
}

export function wrapChunk(chunk: RetrievedChunk, index: number): string {
	const id = `S${index + 1}`;
	const attrs = [
		` id="${id}"`,
		attr("regdoc", chunk.regdoc_id),
		attr("section", chunk.section_number),
		attr("section_title", chunk.section_title),
		attr("requirement_type", chunk.requirement_type ?? "guidance"),
		attr("url", chunk.url),
	].join("");
	return `<context_snippet${attrs}>\n${htmlEscape(chunk.chunk_text)}\n</context_snippet>`;
}

export function buildContextEnvelope(
	chunks: RetrievedChunk[],
	userQuery: string,
): string {
	const wrapped = chunks.map((c, i) => wrapChunk(c, i)).join("\n");
	return `${wrapped}\n\nUSER QUESTION:\n${userQuery}`;
}
