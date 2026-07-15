"use client";

import { createContext, useContext } from "react";
import type { SourceChunk } from "@/components/knowledge-hub/SourcesPanel";

// Context bridging the current assistant message's `data-sources` part
// down to inline CitationChip renders. Populated by AssistantMessage via
// useAuiState(); consumed by MarkdownText's CitationChip so each
// [REGDOC-X.X.X §Y.Z] chip resolves to the real CNSC URL.
export type CitationSource = Pick<
	SourceChunk,
	"regdoc_id" | "section_number" | "section_title" | "url"
>;

const CitationSourcesContext = createContext<CitationSource[] | null>(null);

export function CitationSourcesProvider({
	sources,
	children,
}: {
	sources: CitationSource[];
	children: React.ReactNode;
}) {
	return (
		<CitationSourcesContext.Provider value={sources}>
			{children}
		</CitationSourcesContext.Provider>
	);
}

export function useCitationSources(): CitationSource[] {
	return useContext(CitationSourcesContext) ?? [];
}

export function findCitationMatch(
	sources: CitationSource[],
	label: string,
): CitationSource | null {
	// label is "[REGDOC-X.X.X]" or "[REGDOC-X.X.X §Y.Z]" (optionally -VolN)
	const inner = label.replace(/^\[|\]$/g, "").trim();
	const match = inner.match(
		/^(REGDOC-[\d.]+(?:-Vol[IVX]+)?)(?:\s+§([\d.]+))?$/,
	);
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
