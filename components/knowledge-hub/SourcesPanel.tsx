"use client";

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useId, useState } from "react";
import {
	COLLECTIONS,
	DOCUMENT_KIND_LABELS,
	displayHost,
	isAllowedSourceUrl,
	JURISDICTION_LABELS,
} from "@/lib/sources/catalog";
import type { SourceRecord } from "@/lib/sources/citations";
import {
	isSourcesPayloadV2,
	type SourcesPayloadV2,
} from "@/lib/sources/payload";

// Matches the legacy `data-sources` payload ({ chunks }) emitted by the
// CNSC-only path and still present in saved threads. v2 messages carry
// { version: 2, scope, sources } (lib/sources/payload.ts) and render below.
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
	data: { chunks: SourceChunk[] } | SourcesPayloadV2;
}

export function SourcesPanel({ data }: SourcesPanelProps) {
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	const v2 = isSourcesPayloadV2(data) ? data : null;
	const count = v2
		? v2.sources.length
		: ((data as { chunks?: SourceChunk[] })?.chunks?.length ?? 0);
	if (count === 0) return null;

	return (
		<div className="mx-auto mt-3 max-w-(--thread-max-width)">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				aria-controls={bodyId}
				className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-left text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
			>
				<span className="font-medium">
					Sources · {count} snippet{count === 1 ? "" : "s"}
					{v2 ? <ScopeLine payload={v2} /> : null}
				</span>
				{open ? (
					<ChevronUpIcon aria-hidden="true" className="size-4 shrink-0" />
				) : (
					<ChevronDownIcon aria-hidden="true" className="size-4 shrink-0" />
				)}
			</button>
			{open && (
				<ol
					id={bodyId}
					className="mt-2 space-y-2 rounded-md border border-border bg-surface p-2"
				>
					{v2
						? v2.sources.map((s) => <SourceItemV2 key={s.sid} source={s} />)
						: (data as { chunks: SourceChunk[] }).chunks.map((c, idx) => (
								<LegacySourceItem key={c.id} chunk={c} index={idx} />
							))}
				</ol>
			)}
			{open && v2 ? <Attributions sources={v2.sources} /> : null}
		</div>
	);
}

function ScopeLine({ payload }: { payload: SourcesPayloadV2 }) {
	const { scope } = payload;
	const labels = scope.collections.map((id) => COLLECTIONS[id]?.label ?? id);
	const missing = scope.missing.map((id) => COLLECTIONS[id]?.label ?? id);
	return (
		<span className="font-normal">
			{" · "}
			{scope.kind === "compare"
				? `compared ${labels.join(" vs ")}`
				: `searched ${labels[0] ?? ""}${scope.via === "pinned" ? " (pinned)" : ""}`}
			{scope.historical ? " incl. superseded editions" : ""}
			{missing.length > 0
				? ` · no relevant ${missing.join(", ")} snippets`
				: ""}
		</span>
	);
}

// Badge colour follows LEGAL FORCE, not wording: requirement colour only for
// a requirement snippet from a binding or mixed-force document; everything
// from guides, principles and reports reads as guidance.
function isRequirement(s: SourceRecord): boolean {
	return (
		s.requirement_type === "requirement" &&
		(s.legal_force === "binding" || s.legal_force === "mixed")
	);
}

function SourceItemV2({ source: s }: { source: SourceRecord }) {
	const req = isRequirement(s);
	const kind = DOCUMENT_KIND_LABELS[s.document_kind] ?? s.document_kind;
	const jurisdiction = JURISDICTION_LABELS[s.jurisdiction] ?? s.jurisdiction;
	const link = isAllowedSourceUrl(s.url) ? s.url : null;
	return (
		<li className="rounded-md border border-border/60 bg-bg p-2 text-xs leading-snug">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-[10px] text-fg-muted">{s.sid}</span>
				<span
					className={
						req
							? "rounded-full border border-requirement/40 bg-requirement/10 px-2 py-0.5 font-medium text-[10px] text-requirement"
							: "rounded-full border border-guidance/40 bg-guidance/10 px-2 py-0.5 font-medium text-[10px] text-guidance"
					}
					title={
						req
							? "Requirement in a binding or licensing-basis document"
							: s.legal_force === "nonbinding"
								? `Not binding — ${kind}`
								: "Guidance"
					}
				>
					{s.chip}
				</span>
				{s.status !== "current" ? (
					<span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] text-warning">
						{s.status} edition
					</span>
				) : null}
				<span className="ml-auto font-mono text-[10px] text-fg-muted">
					sim {s.similarity.toFixed(3)}
				</span>
			</div>
			<p className="mt-1 text-fg">
				{s.title}
				{s.section_title ? (
					<span className="text-fg-muted"> — {s.section_title}</span>
				) : null}
			</p>
			<p className="mt-0.5 text-[11px] text-fg-muted">
				{s.publisher} · {jurisdiction} · {kind}
				{s.edition ? ` · ${s.edition}` : ""}
				{s.as_of ? ` · checked ${s.as_of}` : ""}
			</p>
			<p className="mt-1 text-fg-muted">{s.snippet}…</p>
			{link ? (
				<a
					href={link}
					target="_blank"
					rel="noopener noreferrer"
					className="mt-1 inline-block text-brand underline underline-offset-2 hover:text-fg"
				>
					View on {displayHost(link)} →
				</a>
			) : null}
		</li>
	);
}

function Attributions({ sources }: { sources: SourceRecord[] }) {
	const lines = [
		...new Set(
			sources.map((s) => s.attribution).filter((a): a is string => !!a),
		),
	];
	if (lines.length === 0) return null;
	return (
		<div className="mt-2 space-y-1 px-1 text-[10px] text-fg-muted leading-snug">
			{lines.map((l) => (
				<p key={l}>{l}</p>
			))}
		</div>
	);
}

function LegacySourceItem({
	chunk: c,
	index,
}: {
	chunk: SourceChunk;
	index: number;
}) {
	const isReq = c.requirement_type === "requirement";
	return (
		<li className="rounded-md border border-border/60 bg-bg p-2 text-xs leading-snug">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-[10px] text-fg-muted">
					S{index + 1}
				</span>
				<span
					className={
						isReq
							? "rounded-full border border-requirement/40 bg-requirement/10 px-2 py-0.5 font-medium text-[10px] text-requirement"
							: "rounded-full border border-guidance/40 bg-guidance/10 px-2 py-0.5 font-medium text-[10px] text-guidance"
					}
					title={isReq ? "Regulatory requirement" : "Guidance"}
				>
					{c.regdoc_id}
				</span>
				{c.section_number ? (
					<span className="text-fg-muted">
						§{c.section_number}
						{c.section_title ? ` — ${c.section_title}` : ""}
					</span>
				) : null}
				<span className="ml-auto font-mono text-[10px] text-fg-muted">
					sim {c.similarity.toFixed(3)}
				</span>
			</div>
			<p className="mt-1 text-fg-muted">{c.snippet}…</p>
			{isAllowedSourceUrl(c.url) ? (
				<a
					href={c.url}
					target="_blank"
					rel="noopener noreferrer"
					className="mt-1 inline-block text-brand underline underline-offset-2 hover:text-fg"
				>
					View on cnsc-ccsn.gc.ca →
				</a>
			) : null}
		</li>
	);
}
