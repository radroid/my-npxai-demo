"use client";

import { createContext, useContext } from "react";
import type { SourceChunk } from "@/components/knowledge-hub/SourcesPanel";
import type { SourceRecord } from "@/lib/sources/citations";

// Context bridging the current assistant message's `data-sources` part
// down to inline citation renders in MarkdownText. Populated by
// AssistantMessage from the message parts.
//   legacy — saved CNSC-only answers: [REGDOC-X.X.X §Y.Z] chips resolve by
//            document + section against these chunks.
//   v2     — multi-source answers: [[S1]] chips resolve by snippet id
//            against these records (null when the message has no v2
//            payload, e.g. every pre-Phase-12 thread).
export type CitationSource = Pick<
	SourceChunk,
	"regdoc_id" | "section_number" | "section_title" | "url"
>;

export interface CitationSourcesValue {
	legacy: CitationSource[];
	v2: SourceRecord[] | null;
}

const EMPTY: CitationSourcesValue = { legacy: [], v2: null };
const CitationSourcesContext = createContext<CitationSourcesValue>(EMPTY);

export function CitationSourcesProvider({
	value,
	children,
}: {
	value: CitationSourcesValue;
	children: React.ReactNode;
}) {
	return (
		<CitationSourcesContext.Provider value={value}>
			{children}
		</CitationSourcesContext.Provider>
	);
}

export function useCitationSources(): CitationSource[] {
	return useContext(CitationSourcesContext).legacy;
}

export function useSnippetSources(): SourceRecord[] | null {
	return useContext(CitationSourcesContext).v2;
}

export function findCitationMatch(
	sources: CitationSource[],
	label: string,
): CitationSource | null {
	// label is "[REGDOC-X.X.X]" or "[REGDOC-X.X.X §Y.Z]"
	const inner = label.replace(/^\[|\]$/g, "").trim();
	const match = inner.match(/^(REGDOC-[\d.]+)(?:\s+§([\d.]+))?$/);
	if (!match) return null;
	const regdocId = match[1];
	const section = match[2] ?? null;

	if (section) {
		const exact = sources.find(
			(s) =>
				s.regdoc_id === regdocId &&
				(s.section_number === section ||
					// Tolerate section prefixes: citation "§3.2" matches chunk "§3.2.3".
					s.section_number?.startsWith(`${section}.`) ||
					section.startsWith(`${s.section_number}.`)),
		);
		if (exact) return exact;
	}
	return sources.find((s) => s.regdoc_id === regdocId) ?? null;
}
