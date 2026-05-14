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
	const attrs =
		` id="S${index + 1}"` +
		attr("regdoc", chunk.regdoc_id) +
		attr("section", chunk.section_number) +
		attr("section_title", chunk.section_title) +
		attr("requirement_type", chunk.requirement_type ?? "guidance") +
		attr("url", chunk.url);
	return `<context_snippet${attrs}>\n${htmlEscape(chunk.chunk_text)}\n</context_snippet>`;
}

export function buildContextEnvelope(
	chunks: RetrievedChunk[],
	userQuery: string,
	requiredCites: readonly string[] = [],
): string {
	// Pre-envelope cue: when the route identifies two or more docs as
	// in-scope for this question (explicit REGDOC/NSCA mentions or concept
	// hints), list them so the model treats multi-doc citation as a hard
	// instruction rather than a soft prompt rule. Empirically, GPT-4o-mini
	// is inconsistent about citing both definitional and domain-specific
	// docs without this nudge (see #28 in evals/knowledge-hub.jsonl).
	const multiDocCue =
		requiredCites.length >= 2
			? `\n\nMULTI-DOC SCOPE: The user's question spans ${requiredCites.join(", ")}. Your response MUST cite at least one snippet from EACH of these documents.`
			: "";
	// Spotlight the user query: wrap it in a delimited block and HTML-escape
	// the body, mirroring the <context_snippet> treatment. The system prompt
	// names <user_query> as untrusted data, so the boundary is enforced from
	// both sides (OpenAI / MS-Research spotlighting pattern).
	return `${chunks.map(wrapChunk).join("\n")}${multiDocCue}\n\n<user_query>\n${htmlEscape(userQuery)}\n</user_query>`;
}
