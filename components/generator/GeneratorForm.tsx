"use client";

import { DownloadIcon, PlayIcon, Printer } from "lucide-react";
import { type FC, useCallback, useEffect, useState } from "react";
import {
	type ReadySource,
	ReportView,
} from "@/components/generator/ReportView";
import {
	type StreamingPhase,
	StreamingView,
} from "@/components/generator/StreamingView";
import { useGenerateStream } from "@/components/generator/use-generate-stream";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useGeneratorStore } from "@/lib/generator-store";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { SHIFTS, STATIONS, UNITS } from "@/lib/validators";

const OUTLINE_BUTTON =
	"inline-flex items-center justify-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

export const GeneratorForm: FC = () => {
	const [station, setStation] = useState<string>(STATIONS[0]);
	const [unit, setUnit] = useState<string>("Unit 3");
	const [shift, setShift] = useState<string>("Evening");
	const [signedIn, setSignedIn] = useState(false);
	const { status, error, meta, report, readySource, generate, loadExisting } =
		useGenerateStream();

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const supabase = getSupabaseBrowserClient();
				const {
					data: { session },
				} = await supabase.auth.getSession();
				if (!cancelled) setSignedIn(Boolean(session?.user));
			} catch {
				if (!cancelled) setSignedIn(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// Sidebar's RecentReports rail sets pendingLoad in the generator store when
	// a history row is clicked; we consume it here to drive the form + view.
	const pendingLoad = useGeneratorStore((s) => s.pendingLoad);
	const consumeLoad = useGeneratorStore((s) => s.consumeLoad);
	useEffect(() => {
		if (!pendingLoad) return;
		setStation(pendingLoad.station);
		setUnit(pendingLoad.unit);
		setShift(pendingLoad.shift);
		loadExisting({
			meta: {
				station: pendingLoad.station,
				unit: pendingLoad.unit,
				shift: pendingLoad.shift,
				generated_at: pendingLoad.generated_at,
				snapshot_hash: pendingLoad.snapshot_hash,
				signed_in: signedIn,
			},
			report: pendingLoad.report_markdown ?? "",
			source: "history" as ReadySource,
		});
		consumeLoad();
	}, [pendingLoad, consumeLoad, loadExisting, signedIn]);

	const handleSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault();
			generate({ station, unit, shift });
		},
		[generate, station, unit, shift],
	);

	const handleRegenerate = useCallback(() => {
		generate({ station, unit, shift }, { force: true });
	}, [generate, station, unit, shift]);

	const isLoading =
		status === "pulling" || status === "drafting" || status === "finalizing";

	return (
		<div className="h-full overflow-auto rounded-xl border border-border bg-surface">
			<div className="mx-auto grid w-full max-w-[1600px] gap-6 p-4 md:p-6 lg:grid-cols-[320px_minmax(0,1fr)]">
				<aside className="flex flex-col gap-4">
					<header>
						<h1 className="text-xl font-semibold text-fg">
							Shift Turnover Generator
						</h1>
						<p className="mt-1 text-xs text-fg-muted">
							CANDU shift turnover reports per CNSC REGDOC-2.3.4, generated from
							simulated Bruce Power plant data.
						</p>
					</header>
					<form
						onSubmit={handleSubmit}
						className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4"
					>
						<LabeledSelect
							label="Station"
							value={station}
							onChange={setStation}
							options={STATIONS as unknown as readonly string[]}
						/>
						<LabeledSelect
							label="Unit"
							value={unit}
							onChange={setUnit}
							options={UNITS as unknown as readonly string[]}
						/>
						<LabeledSelect
							label="Incoming shift"
							value={shift}
							onChange={setShift}
							options={SHIFTS as unknown as readonly string[]}
						/>
						<button
							type="submit"
							disabled={isLoading}
							className="mt-1 inline-flex items-center justify-center gap-2 rounded-md bg-brand px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-60"
						>
							{isLoading ? (
								<>
									<span
										aria-hidden="true"
										className="size-3 animate-breathe rounded-full bg-white"
									/>
									Generating…
								</>
							) : (
								<>
									<PlayIcon className="size-4" aria-hidden="true" />
									Generate report
								</>
							)}
						</button>
					</form>
					{status === "ready" && report ? (
						<div className="flex flex-wrap gap-2">
							<button
								type="button"
								onClick={() => copyToClipboard(report)}
								className={OUTLINE_BUTTON}
							>
								<DownloadIcon className="size-3" aria-hidden="true" />
								Copy Markdown
							</button>
							<button
								type="button"
								onClick={() => typeof window !== "undefined" && window.print()}
								className={OUTLINE_BUTTON}
							>
								<Printer className="size-3" aria-hidden="true" />
								Print / PDF
							</button>
						</div>
					) : null}
				</aside>

				<section
					aria-live="polite"
					className="min-h-[360px] rounded-md border border-border bg-surface p-4 md:p-6 print:border-0 print:p-0"
				>
					{status === "idle" && <EmptyState />}
					{isLoading && (
						<StreamingView
							phase={status as StreamingPhase}
							report={report}
							meta={meta}
						/>
					)}
					{status === "error" && (
						<div
							role="alert"
							className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger"
						>
							{error}
						</div>
					)}
					{status === "ready" && meta && (
						<ReportView
							meta={meta}
							report={report}
							source={readySource}
							onRegenerate={handleRegenerate}
						/>
					)}
				</section>
			</div>
		</div>
	);
};

function LabeledSelect({
	label,
	value,
	onChange,
	options,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	options: readonly string[];
}) {
	const id = `gen-${label.replace(/\s+/g, "-").toLowerCase()}`;
	return (
		<div className="flex flex-col gap-1">
			<label htmlFor={id} className="text-xs font-medium text-fg-muted">
				{label}
			</label>
			<Select value={value} onValueChange={onChange}>
				<SelectTrigger
					id={id}
					className="w-full border-border bg-bg text-sm text-fg"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{options.map((opt) => (
						<SelectItem key={opt} value={opt}>
							{opt}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

function EmptyState() {
	return (
		<div className="flex h-full min-h-[320px] flex-col items-center justify-center text-center">
			<p className="font-medium text-fg">No report yet</p>
			<p className="mt-1 max-w-md text-xs text-fg-muted">
				Pick a unit + shift and click{" "}
				<span className="font-medium text-fg">Generate report</span>. Unit 3
				Evening is the demo's richest dataset — outage in progress, 3 active
				clearances, multiple work orders.
			</p>
		</div>
	);
}

function copyToClipboard(text: string) {
	if (typeof navigator === "undefined" || !navigator.clipboard) return;
	navigator.clipboard.writeText(text).catch(() => {});
}
