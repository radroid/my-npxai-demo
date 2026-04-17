"use client";

import { useEffect, useRef, useState } from "react";
import { ReportBody } from "@/components/generator/report-markdown";

export type StreamingPhase = "pulling" | "drafting" | "finalizing";

type GeneratorMeta = {
	station: string;
	unit: string;
	shift: string;
	generated_at: string;
	snapshot_hash: string;
	signed_in: boolean;
};

const SKELETON_WIDTHS = [82, 68, 95, 73, 60, 88] as const;

const PHASE_LABELS: Record<StreamingPhase, string> = {
	pulling: "Pulling plant snapshot",
	drafting: "Drafting turnover",
	finalizing: "Finalizing",
};

const PHASES: StreamingPhase[] = ["pulling", "drafting", "finalizing"];

// Reveal incoming streaming text at a steady, readable pace (~80 chars/sec),
// accelerating when the display falls too far behind the buffer so we catch
// up before the stream closes. Gives the Generator an elegant typewriter
// feel without pretending the data isn't already buffered server-side.
function useDrainedText(
	source: string,
	{
		baseCharsPerSec = 80,
		maxBehind = 400,
	}: { baseCharsPerSec?: number; maxBehind?: number } = {},
): string {
	const [displayed, setDisplayed] = useState("");
	const sourceRef = useRef(source);
	sourceRef.current = source;

	useEffect(() => {
		let rafId: number | null = null;
		let last =
			typeof performance !== "undefined" ? performance.now() : Date.now();
		function tick(now: number) {
			const dt = now - last;
			last = now;
			setDisplayed((prev) => {
				const src = sourceRef.current;
				if (prev.length > src.length) return src; // source reset / shortened
				if (prev.length === src.length) return prev;
				const behind = src.length - prev.length;
				const perMs =
					behind > maxBehind ? behind / 500 : baseCharsPerSec / 1000;
				const step = Math.max(1, Math.round(perMs * dt));
				return src.slice(0, Math.min(src.length, prev.length + step));
			});
			rafId = requestAnimationFrame(tick);
		}
		rafId = requestAnimationFrame(tick);
		return () => {
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
	}, [baseCharsPerSec, maxBehind]);

	// When the source shortens (e.g. new generation resets), snap the
	// displayed text back so we don't render stale characters.
	useEffect(() => {
		setDisplayed((prev) => (prev.length > source.length ? source : prev));
	}, [source]);

	return displayed;
}

export function StreamingView({
	phase,
	report,
	meta,
}: {
	phase: StreamingPhase;
	report: string;
	meta: GeneratorMeta | null;
}) {
	const activeIdx = PHASES.indexOf(phase);
	const drained = useDrainedText(report);

	return (
		<div className="flex flex-col gap-4">
			<div
				className="flex items-center gap-2 text-xs text-[var(--text-muted)]"
				aria-live="polite"
			>
				<span
					aria-hidden="true"
					className="size-2 animate-breathe rounded-full bg-[var(--accent-brand)]"
				/>
				{PHASE_LABELS[phase]}…
			</div>
			<ol className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
				{PHASES.map((p, i) => (
					<li key={p} className="flex items-center gap-1.5">
						<span
							className={`inline-block size-1.5 rounded-full ${
								i <= activeIdx
									? "bg-[var(--accent-brand)]"
									: "bg-[var(--border)]"
							}`}
							aria-hidden="true"
						/>
						<span
							className={i === activeIdx ? "text-[var(--text)]" : undefined}
						>
							{PHASE_LABELS[p]}
						</span>
						{i < PHASES.length - 1 ? (
							<span aria-hidden="true" className="mx-1 text-[var(--border)]">
								›
							</span>
						) : null}
					</li>
				))}
			</ol>
			{drained ? (
				<div className="generator-stream">
					<ReportBody report={drained} />
					<span
						aria-hidden="true"
						className="generator-caret inline-block h-3 w-[2px] translate-y-0.5 bg-[var(--accent-brand)]"
					/>
				</div>
			) : (
				<div className="space-y-2" aria-hidden="true">
					{SKELETON_WIDTHS.map((w) => (
						<div
							key={`sk-w${w}`}
							className="h-3 w-full animate-breathe rounded bg-[var(--border)]/60"
							style={{ width: `${w}%` }}
						/>
					))}
				</div>
			)}
			{meta ? (
				<div className="mt-2 text-[11px] text-[var(--text-muted)]">
					{meta.station} · {meta.unit} · {meta.shift} shift
				</div>
			) : null}
		</div>
	);
}
