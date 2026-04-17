"use client";

import { DownloadIcon, PlayIcon } from "lucide-react";
import { type FC, type ReactNode, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SHIFTS, STATIONS, UNITS } from "@/lib/validators";

interface GeneratorResponse {
	station: string;
	unit: string;
	shift: string;
	report: string;
	generated_at: string;
}

type Status = "idle" | "loading" | "ready" | "error";

// Priority markers the D.4 prompt embeds inline: [CRITICAL] / [ATTENTION] / [ROUTINE].
// Rendered as colored badges; the plain text stays in place so copy-paste works.
const PRIORITY_RE = /\[(CRITICAL|ATTENTION|ROUTINE)\]/g;

function PriorityBadge({ level }: { level: string }) {
	const cls =
		level === "CRITICAL"
			? "border-red-500/40 bg-red-500/10 text-red-400"
			: level === "ATTENTION"
				? "border-[--guidance]/40 bg-[--guidance]/10 text-[--guidance]"
				: "border-[--border] bg-[--surface] text-[--text-muted]";
	return (
		<span
			className={`mx-0.5 inline-flex items-center rounded-full border px-1.5 py-0 font-mono text-[0.72em] leading-[1.4] align-baseline ${cls}`}
		>
			{level}
		</span>
	);
}

function renderWithPriorities(children: ReactNode): ReactNode {
	if (typeof children !== "string") return children;
	const out: ReactNode[] = [];
	let last = 0;
	let chipKey = 0;
	for (const m of children.matchAll(PRIORITY_RE)) {
		const idx = m.index ?? 0;
		if (idx > last) out.push(children.slice(last, idx));
		out.push(<PriorityBadge key={chipKey++} level={m[1]} />);
		last = idx + m[0].length;
	}
	if (last < children.length) out.push(children.slice(last));
	return out.length > 0 ? out : children;
}

function processChildren(children: ReactNode): ReactNode {
	if (Array.isArray(children)) {
		return children.map((c, i) =>
			typeof c === "string" ? (
				<span key={i}>{renderWithPriorities(c)}</span>
			) : (
				c
			),
		);
	}
	return renderWithPriorities(children);
}

export const GeneratorForm: FC = () => {
	const [station, setStation] = useState<string>(STATIONS[0]);
	const [unit, setUnit] = useState<string>("Unit 3");
	const [shift, setShift] = useState<string>("Evening");
	const [status, setStatus] = useState<Status>("idle");
	const [error, setError] = useState<string | null>(null);
	const [data, setData] = useState<GeneratorResponse | null>(null);

	async function generate(e: React.FormEvent) {
		e.preventDefault();
		setStatus("loading");
		setError(null);
		setData(null);
		try {
			const res = await fetch("/api/generator/turnover", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ station, unit, shift }),
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				setError(body?.message ?? `Request failed (${res.status}).`);
				setStatus("error");
				return;
			}
			setData(body as GeneratorResponse);
			setStatus("ready");
		} catch (err) {
			console.error(err);
			setError("Network error — please retry.");
			setStatus("error");
		}
	}

	return (
		<div className="mx-auto grid w-full max-w-5xl gap-6 p-4 md:p-6 lg:grid-cols-[320px_1fr]">
			<aside className="flex flex-col gap-4">
				<header>
					<h1 className="text-xl font-semibold text-[--text]">
						Shift Turnover Generator
					</h1>
					<p className="mt-1 text-xs text-[--text-muted]">
						CANDU shift turnover reports per CNSC REGDOC-2.3.4, generated from
						simulated Bruce Power plant data.
					</p>
				</header>
				<form
					onSubmit={generate}
					className="flex flex-col gap-3 rounded-md border border-[--border] bg-[--surface] p-4"
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
						disabled={status === "loading"}
						className="mt-1 inline-flex items-center justify-center gap-2 rounded-md bg-[--accent-brand] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[--accent-brand-hover] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] disabled:cursor-not-allowed disabled:opacity-60"
					>
						{status === "loading" ? (
							<>
								<span
									aria-hidden="true"
									className="size-3 animate-pulse rounded-full bg-white"
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
				{data ? (
					<button
						type="button"
						onClick={() => copyToClipboard(data.report)}
						className="inline-flex items-center justify-center gap-2 rounded-md border border-[--border] bg-[--surface] px-3 py-2 text-xs text-[--text-muted] transition-colors hover:text-[--text] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]"
					>
						<DownloadIcon className="size-3" aria-hidden="true" />
						Copy Markdown
					</button>
				) : null}
				<p className="text-[10px] text-[--text-muted]">
					Simulated data. Not a reflection of any real operating plant.
				</p>
			</aside>

			<section
				aria-live="polite"
				className="min-h-[360px] rounded-md border border-[--border] bg-[--surface] p-4 md:p-6"
			>
				{status === "idle" && <EmptyState />}
				{status === "loading" && <LoadingState />}
				{status === "error" && (
					<div
						role="alert"
						className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300"
					>
						{error}
					</div>
				)}
				{status === "ready" && data && (
					<ReportView data={data} processChildren={processChildren} />
				)}
			</section>
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
		<label htmlFor={id} className="flex flex-col gap-1">
			<span className="text-xs font-medium text-[--text-muted]">{label}</span>
			<select
				id={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="rounded-md border border-[--border] bg-[--bg] px-2 py-1.5 text-sm text-[--text] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]"
			>
				{options.map((opt) => (
					<option key={opt} value={opt}>
						{opt}
					</option>
				))}
			</select>
		</label>
	);
}

function EmptyState() {
	return (
		<div className="flex h-full min-h-[320px] flex-col items-center justify-center text-center">
			<p className="font-medium text-[--text]">No report yet</p>
			<p className="mt-1 max-w-md text-xs text-[--text-muted]">
				Pick a unit + shift and click{" "}
				<span className="font-medium text-[--text]">Generate report</span>. Unit
				3 Evening is the demo's richest dataset — outage in progress, 3 active
				clearances, multiple work orders.
			</p>
		</div>
	);
}

function LoadingState() {
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2 text-xs text-[--text-muted]">
				<span
					aria-hidden="true"
					className="size-2 animate-pulse rounded-full bg-[--accent-brand]"
				/>
				Pulling plant snapshot, streaming the turnover report…
			</div>
			<div className="space-y-2">
				{[...Array(6)].map((_, i) => (
					<div
						key={i}
						className="h-3 w-full animate-pulse rounded bg-[--border]/50"
						style={{ width: `${60 + ((i * 13) % 35)}%` }}
					/>
				))}
			</div>
		</div>
	);
}

function ReportView({
	data,
	processChildren,
}: {
	data: GeneratorResponse;
	processChildren: (c: ReactNode) => ReactNode;
}) {
	const generated = new Date(data.generated_at);
	return (
		<article className="prose-report text-[--text]">
			<header className="mb-4 border-b border-[--border] pb-3">
				<div className="flex flex-wrap items-center gap-2 text-xs text-[--text-muted]">
					<span className="font-mono">
						{data.station} · {data.unit}
					</span>
					<span>·</span>
					<span>{data.shift} shift</span>
					<span>·</span>
					<span>{generated.toLocaleString()}</span>
				</div>
			</header>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					h1: ({ node, ...props }) => (
						<h1
							{...props}
							className="mt-0 mb-2 font-semibold text-[--text] text-lg"
						/>
					),
					h2: ({ node, ...props }) => (
						<h2
							{...props}
							className="mt-4 mb-1.5 font-semibold text-[--text] text-base"
						/>
					),
					h3: ({ node, ...props }) => (
						<h3
							{...props}
							className="mt-3 mb-1 font-medium text-[--text] text-sm"
						/>
					),
					p: ({ node, children, ...props }) => (
						<p
							{...props}
							className="my-2 text-sm leading-relaxed text-[--text]"
						>
							{processChildren(children)}
						</p>
					),
					li: ({ node, children, ...props }) => (
						<li
							{...props}
							className="my-1 text-sm leading-relaxed text-[--text]"
						>
							{processChildren(children)}
						</li>
					),
					ul: ({ node, ...props }) => (
						<ul {...props} className="my-2 ml-5 list-disc space-y-1" />
					),
					ol: ({ node, ...props }) => (
						<ol {...props} className="my-2 ml-5 list-decimal space-y-1" />
					),
					strong: ({ node, ...props }) => (
						<strong {...props} className="font-semibold text-[--text]" />
					),
					table: ({ node, ...props }) => (
						<table {...props} className="my-3 w-full border-collapse text-xs" />
					),
					th: ({ node, ...props }) => (
						<th
							{...props}
							className="border border-[--border] bg-[--bg] px-2 py-1 text-left font-medium"
						/>
					),
					td: ({ node, ...props }) => (
						<td {...props} className="border border-[--border] px-2 py-1" />
					),
				}}
			>
				{data.report}
			</ReactMarkdown>
		</article>
	);
}

function copyToClipboard(text: string) {
	if (typeof navigator === "undefined" || !navigator.clipboard) return;
	navigator.clipboard.writeText(text).catch(() => {});
}
