"use client";

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useState } from "react";

// Matches the `data-sources` UIMessage part emitted by
// app/api/knowledge-hub/query/route.ts after the LLM stream completes.
// Keep this interface in lock-step with the handler's writer.write payload.
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

export interface SourcesPanelProps {
	data: { chunks: SourceChunk[] };
}

export function SourcesPanel({ data }: SourcesPanelProps) {
	const [open, setOpen] = useState(false);
	const chunks = data?.chunks ?? [];
	if (chunks.length === 0) return null;

	return (
		<div className="mx-auto mt-3 max-w-(--thread-max-width)">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				aria-controls="sources-panel-body"
				className="flex w-full items-center justify-between rounded-md border border-border bg-[var(--surface)] px-3 py-2 text-left text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
			>
				<span className="font-medium">
					Sources · {chunks.length} snippet{chunks.length === 1 ? "" : "s"}
				</span>
				{open ? (
					<ChevronUpIcon aria-hidden="true" className="size-4" />
				) : (
					<ChevronDownIcon aria-hidden="true" className="size-4" />
				)}
			</button>
			{open && (
				<ol
					id="sources-panel-body"
					className="mt-2 space-y-2 rounded-md border border-border bg-[var(--surface)] p-2"
				>
					{chunks.map((c, idx) => (
						<li
							key={c.id}
							className="rounded-md border border-border/60 bg-[var(--bg)] p-2 text-xs leading-snug"
						>
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-mono text-[10px] text-[var(--text-muted)]">
									S{idx + 1}
								</span>
								<SourceBadge chunk={c} />
								{c.section_number ? (
									<span className="text-[var(--text-muted)]">
										§{c.section_number}
										{c.section_title ? ` — ${c.section_title}` : ""}
									</span>
								) : null}
								<span className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">
									sim {c.similarity.toFixed(3)}
								</span>
							</div>
							<p className="mt-1 text-[var(--text-muted)]">{c.snippet}…</p>
							{c.url ? (
								<a
									href={c.url}
									target="_blank"
									rel="noopener noreferrer"
									className="mt-1 inline-block text-[var(--accent-brand)] underline underline-offset-2 hover:text-[var(--text)]"
								>
									View on cnsc-ccsn.gc.ca →
								</a>
							) : null}
						</li>
					))}
				</ol>
			)}
		</div>
	);
}

function SourceBadge({ chunk }: { chunk: SourceChunk }) {
	const isReq = chunk.requirement_type === "requirement";
	return (
		<span
			className={
				isReq
					? "rounded-full border border-[var(--requirement)]/40 bg-[var(--requirement)]/10 px-2 py-0.5 font-medium text-[10px] text-[var(--requirement)]"
					: "rounded-full border border-[var(--guidance)]/40 bg-[var(--guidance)]/10 px-2 py-0.5 font-medium text-[10px] text-[var(--guidance)]"
			}
			title={isReq ? "Regulatory requirement" : "Guidance"}
		>
			{chunk.regdoc_id}
		</span>
	);
}
