"use client";

import { RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { ReportBody, slugify } from "@/components/generator/report-markdown";
import { relativeTime } from "@/lib/report-store";

type GeneratorMeta = {
	station: string;
	unit: string;
	shift: string;
	generated_at: string;
	snapshot_hash: string;
	signed_in: boolean;
};

export type ReadySource = "stream" | "cached" | "history";

const SECTION_JUMP_LABELS = [
	"Plant Status",
	"Safety Systems",
	"Work & Clearances",
	"Key Events",
	"Watch Items",
	"Recommended Actions",
];

export function ReportView({
	meta,
	report,
	source,
	onRegenerate,
}: {
	meta: GeneratorMeta;
	report: string;
	source: ReadySource;
	onRegenerate: () => void;
}) {
	const generated = new Date(meta.generated_at);
	const showCachedBanner = source === "cached" || source === "history";

	// Extract section h2's from the markdown to build the jump rail.
	const presentSections = useMemo(() => {
		const headings = Array.from(
			report.matchAll(/^##\s+(?:\d+\.\s+)?(.+)$/gm),
		).map((m) => m[1].trim());
		return SECTION_JUMP_LABELS.filter((label) =>
			headings.some((h) => h.toLowerCase().includes(label.toLowerCase())),
		);
	}, [report]);

	return (
		<div className="grid gap-6 lg:grid-cols-[1fr_180px]">
			<article className="print-area prose-report min-w-0 text-fg">
				<header className="mb-4 flex flex-col gap-2 border-b border-border pb-3">
					<div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted font-mono">
						<span>
							{meta.station} · {meta.unit}
						</span>
						<span aria-hidden>·</span>
						<span>{meta.shift} shift</span>
						<span aria-hidden>·</span>
						<span>{generated.toLocaleString()}</span>
					</div>
					{showCachedBanner ? (
						<div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-fg-muted print:hidden">
							<span>
								{source === "cached"
									? "Cached — plant snapshot hasn't changed since last generation."
									: `Viewing a saved report · ${relativeTime(meta.generated_at)}.`}
							</span>
							<button
								type="button"
								onClick={onRegenerate}
								className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-fg transition-colors hover:bg-brand hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							>
								<RefreshCw className="size-3" aria-hidden />
								Regenerate
							</button>
						</div>
					) : null}
				</header>
				<ReportBody report={report} />
			</article>
			{presentSections.length > 0 ? (
				<aside
					aria-label="Section quick jump"
					className="order-first hidden self-start rounded-md border border-border bg-surface-2 p-3 text-xs lg:sticky lg:top-4 lg:order-last lg:block print:hidden"
				>
					<p className="mb-2 font-medium text-fg">Jump to</p>
					<ul className="flex flex-col gap-1">
						{presentSections.map((label) => (
							<li key={label}>
								<a
									href={`#${slugify(label)}`}
									className="block rounded px-2 py-1 text-fg-muted transition-colors hover:bg-surface hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
								>
									{label}
								</a>
							</li>
						))}
					</ul>
				</aside>
			) : null}
		</div>
	);
}
