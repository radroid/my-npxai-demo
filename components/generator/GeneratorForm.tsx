"use client";

import {
	AlertTriangle,
	CheckCircle2,
	DownloadIcon,
	PlayIcon,
	Printer,
	RefreshCw,
} from "lucide-react";
import {
	type FC,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
	type RecentReport,
	RecentReports,
} from "@/components/generator/RecentReports";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { relativeTime, saveAnonReport } from "@/lib/report-store";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { SHIFTS, STATIONS, UNITS } from "@/lib/validators";

interface GeneratorMeta {
	station: string;
	unit: string;
	shift: string;
	generated_at: string;
	snapshot_hash: string;
	signed_in: boolean;
}

type Status =
	| "idle"
	| "pulling"
	| "drafting"
	| "finalizing"
	| "ready"
	| "error";

type ReadySource = "stream" | "cached" | "history";

// Priority markers the D.4 prompt embeds inline: [CRITICAL] / [ATTENTION] / [ROUTINE].
// Rendered as colored badges inline; when a paragraph STARTS with a marker we also
// render it as a full-width severity block so operators can scan for attention items.
const SKELETON_WIDTHS = [82, 68, 95, 73, 60, 88] as const;
const PRIORITY_RE = /\[(CRITICAL|ATTENTION|ROUTINE)\]/g;
const LEADING_PRIORITY_RE = /^\s*\[(CRITICAL|ATTENTION|ROUTINE)\]\s*/;

type SeverityTone = {
	container: string;
	icon: ReactNode;
	label: string;
	labelClass: string;
};

const SEVERITY_TONES: Record<string, SeverityTone> = {
	CRITICAL: {
		container:
			"border-l-4 border-[var(--danger)] bg-[var(--danger)]/10 pl-3 pr-3 py-2 rounded-r-md",
		icon: <AlertTriangle className="size-4 text-[var(--danger)]" aria-hidden />,
		label: "CRITICAL",
		labelClass: "text-[var(--danger)]",
	},
	ATTENTION: {
		container:
			"border-l-4 border-[var(--guidance)] bg-[var(--guidance)]/10 pl-3 pr-3 py-2 rounded-r-md",
		icon: (
			<AlertTriangle className="size-4 text-[var(--guidance)]" aria-hidden />
		),
		label: "ATTENTION",
		labelClass: "text-[var(--guidance)]",
	},
	ROUTINE: {
		container:
			"border-l-4 border-[var(--border-strong)] bg-[var(--surface-2)] pl-3 pr-3 py-2 rounded-r-md",
		icon: (
			<CheckCircle2 className="size-4 text-[var(--text-muted)]" aria-hidden />
		),
		label: "ROUTINE",
		labelClass: "text-[var(--text-muted)]",
	},
};

function PriorityBadge({ level }: { level: string }) {
	const cls =
		level === "CRITICAL"
			? "border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger)]"
			: level === "ATTENTION"
				? "border-[var(--guidance)]/40 bg-[var(--guidance)]/10 text-[var(--guidance)]"
				: "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]";
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
				// biome-ignore lint/suspicious/noArrayIndexKey: children order is stable within a markdown node
				<span key={`seg-${i}-${c.length}`}>{renderWithPriorities(c)}</span>
			) : (
				c
			),
		);
	}
	return renderWithPriorities(children);
}

function extractLeadingSeverity(
	children: ReactNode,
): { level: keyof typeof SEVERITY_TONES; rest: ReactNode } | null {
	const first = Array.isArray(children) ? children[0] : children;
	if (typeof first !== "string") return null;
	const match = first.match(LEADING_PRIORITY_RE);
	if (!match) return null;
	const level = match[1] as keyof typeof SEVERITY_TONES;
	const trimmed = first.slice(match[0].length);
	const rest = Array.isArray(children)
		? [trimmed, ...children.slice(1)]
		: trimmed;
	return { level, rest };
}

export const GeneratorForm: FC = () => {
	const [station, setStation] = useState<string>(STATIONS[0]);
	const [unit, setUnit] = useState<string>("Unit 3");
	const [shift, setShift] = useState<string>("Evening");
	const [status, setStatus] = useState<Status>("idle");
	const [error, setError] = useState<string | null>(null);
	const [meta, setMeta] = useState<GeneratorMeta | null>(null);
	const [report, setReport] = useState<string>("");
	const [readySource, setReadySource] = useState<ReadySource>("stream");
	const [signedIn, setSignedIn] = useState(false);
	const [recentRefreshKey, setRecentRefreshKey] = useState(0);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => () => abortRef.current?.abort(), []);

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

	const generate = useCallback(
		async (opts: { force?: boolean } = {}) => {
			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;

			setStatus("pulling");
			setError(null);
			setMeta(null);
			setReport("");
			setReadySource("stream");

			try {
				const qs = opts.force ? "?force=true" : "";
				const res = await fetch(`/api/generator/turnover${qs}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ station, unit, shift }),
					signal: controller.signal,
				});

				if (!res.ok) {
					const body = await res.json().catch(() => null);
					setError(body?.message ?? `Request failed (${res.status}).`);
					setStatus("error");
					return;
				}

				const reader = res.body?.getReader();
				if (!reader) {
					setError("Stream not available.");
					setStatus("error");
					return;
				}

				const decoder = new TextDecoder();
				let buffer = "";
				let accumulated = "";
				let currentMeta: GeneratorMeta | null = null;
				let cachedHit = false;

				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });

					const frames = buffer.split("\n\n");
					buffer = frames.pop() ?? "";

					for (const frame of frames) {
						if (!frame.trim()) continue;
						const lines = frame.split("\n");
						const eventLine = lines.find((l) => l.startsWith("event: "));
						const dataLine = lines.find((l) => l.startsWith("data: "));
						if (!eventLine || !dataLine) continue;
						const event = eventLine.slice("event: ".length).trim();
						const raw = dataLine.slice("data: ".length);
						let data: unknown;
						try {
							data = JSON.parse(raw);
						} catch {
							continue;
						}

						if (event === "meta") {
							currentMeta = data as GeneratorMeta;
							setMeta(currentMeta);
							setStatus("drafting");
						} else if (event === "token") {
							accumulated += data as string;
							setReport(accumulated);
						} else if (event === "cached") {
							const payload = data as {
								id: string;
								report: string;
								generated_at: string;
							};
							cachedHit = true;
							accumulated = payload.report;
							setReport(payload.report);
							if (currentMeta) {
								setMeta({ ...currentMeta, generated_at: payload.generated_at });
							}
							setReadySource("cached");
						} else if (event === "done") {
							setStatus("finalizing");
						} else if (event === "error") {
							setError(
								(data as { message?: string })?.message ?? "Stream error.",
							);
							setStatus("error");
							return;
						}
					}
				}

				// Stream completed cleanly — persist for anon users, refresh the rail.
				if (
					!cachedHit &&
					currentMeta &&
					accumulated &&
					!currentMeta.signed_in
				) {
					saveAnonReport({
						station: currentMeta.station,
						unit: currentMeta.unit,
						shift: currentMeta.shift,
						snapshot_hash: currentMeta.snapshot_hash,
						generated_at: currentMeta.generated_at,
						report_markdown: accumulated,
					});
				}
				setRecentRefreshKey((k) => k + 1);
				setStatus("ready");
			} catch (err) {
				if ((err as Error)?.name === "AbortError") return;
				console.error(err);
				setError("Network error — please retry.");
				setStatus("error");
			}
		},
		[station, unit, shift],
	);

	const handleSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault();
			generate();
		},
		[generate],
	);

	const handleRegenerate = useCallback(() => {
		generate({ force: true });
	}, [generate]);

	const handleLoadRecent = useCallback(
		(r: RecentReport) => {
			abortRef.current?.abort();
			setStatus("ready");
			setError(null);
			setReport(r.report_markdown ?? "");
			setMeta({
				station: r.station,
				unit: r.unit,
				shift: r.shift,
				generated_at: r.generated_at,
				snapshot_hash: r.snapshot_hash,
				signed_in: signedIn,
			});
			setStation(r.station);
			setUnit(r.unit);
			setShift(r.shift);
			setReadySource("history");
		},
		[signedIn],
	);

	const isLoading =
		status === "pulling" || status === "drafting" || status === "finalizing";

	return (
		<div className="h-full overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
			<div className="mx-auto grid w-full max-w-5xl gap-6 p-4 md:p-6 lg:grid-cols-[320px_1fr]">
				<aside className="flex flex-col gap-4">
					<header>
						<h1 className="text-xl font-semibold text-[var(--text)]">
							Shift Turnover Generator
						</h1>
						<p className="mt-1 text-xs text-[var(--text-muted)]">
							CANDU shift turnover reports per CNSC REGDOC-2.3.4, generated from
							simulated Bruce Power plant data.
						</p>
					</header>
					<form
						onSubmit={handleSubmit}
						className="flex flex-col gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-4"
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
							className="mt-1 inline-flex items-center justify-center gap-2 rounded-md bg-[var(--accent-brand)] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-brand-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)] disabled:cursor-not-allowed disabled:opacity-60"
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
								className="inline-flex items-center justify-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
							>
								<DownloadIcon className="size-3" aria-hidden="true" />
								Copy Markdown
							</button>
							<button
								type="button"
								onClick={() => typeof window !== "undefined" && window.print()}
								className="inline-flex items-center justify-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
							>
								<Printer className="size-3" aria-hidden="true" />
								Print / PDF
							</button>
						</div>
					) : null}
					<RecentReports
						signedIn={signedIn}
						refreshKey={recentRefreshKey}
						onLoad={handleLoadRecent}
					/>
				</aside>

				<section
					aria-live="polite"
					className="min-h-[360px] rounded-md border border-[var(--border)] bg-[var(--surface)] p-4 md:p-6 print:border-0 print:p-0"
				>
					{status === "idle" && <EmptyState />}
					{isLoading && (
						<StreamingView phase={status} report={report} meta={meta} />
					)}
					{status === "error" && (
						<div
							role="alert"
							className="rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-3 text-sm text-[var(--danger)]"
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
			<label
				htmlFor={id}
				className="text-xs font-medium text-[var(--text-muted)]"
			>
				{label}
			</label>
			<Select value={value} onValueChange={onChange}>
				<SelectTrigger
					id={id}
					className="w-full border-[var(--border)] bg-[var(--bg)] text-sm text-[var(--text)]"
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
			<p className="font-medium text-[var(--text)]">No report yet</p>
			<p className="mt-1 max-w-md text-xs text-[var(--text-muted)]">
				Pick a unit + shift and click{" "}
				<span className="font-medium text-[var(--text)]">Generate report</span>.
				Unit 3 Evening is the demo's richest dataset — outage in progress, 3
				active clearances, multiple work orders.
			</p>
		</div>
	);
}

const PHASE_LABELS: Record<
	Exclude<Status, "idle" | "ready" | "error">,
	string
> = {
	pulling: "Pulling plant snapshot",
	drafting: "Drafting turnover",
	finalizing: "Finalizing",
};

function StreamingView({
	phase,
	report,
	meta,
}: {
	phase: Status;
	report: string;
	meta: GeneratorMeta | null;
}) {
	const phaseKey = (
		phase === "idle" || phase === "ready" || phase === "error"
			? "pulling"
			: phase
	) as keyof typeof PHASE_LABELS;
	const phases: (keyof typeof PHASE_LABELS)[] = [
		"pulling",
		"drafting",
		"finalizing",
	];
	const activeIdx = phases.indexOf(phaseKey);
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
				{PHASE_LABELS[phaseKey]}…
			</div>
			<ol className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
				{phases.map((p, i) => (
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
						{i < phases.length - 1 ? (
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

const SECTION_JUMP_LABELS = [
	"Plant Status",
	"Safety Systems",
	"Work & Clearances",
	"Key Events",
	"Watch Items",
	"Recommended Actions",
];

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

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
}

function ReportView({
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
			<article className="prose-report min-w-0 text-[var(--text)]">
				<header className="mb-4 flex flex-col gap-2 border-b border-[var(--border)] pb-3">
					<div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)] font-mono">
						<span>
							{meta.station} · {meta.unit}
						</span>
						<span aria-hidden>·</span>
						<span>{meta.shift} shift</span>
						<span aria-hidden>·</span>
						<span>{generated.toLocaleString()}</span>
					</div>
					{showCachedBanner ? (
						<div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] print:hidden">
							<span>
								{source === "cached"
									? "Cached — plant snapshot hasn't changed since last generation."
									: `Viewing a saved report · ${relativeTime(meta.generated_at)}.`}
							</span>
							<button
								type="button"
								onClick={onRegenerate}
								className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[var(--text)] transition-colors hover:bg-[var(--accent-brand)] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
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
					className="order-first hidden self-start rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs lg:sticky lg:top-4 lg:order-last lg:block print:hidden"
				>
					<p className="mb-2 font-medium text-[var(--text)]">Jump to</p>
					<ul className="flex flex-col gap-1">
						{presentSections.map((label) => (
							<li key={label}>
								<a
									href={`#${slugify(label)}`}
									className="block rounded px-2 py-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
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

function ReportBody({ report }: { report: string }) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			components={{
				h1: ({ node, ...props }) => (
					<h1
						{...props}
						className="mt-0 mb-2 font-semibold text-[var(--text)] text-lg"
					/>
				),
				h2: ({ node, children, ...props }) => {
					const text = String(
						Array.isArray(children)
							? children.map((c) => (typeof c === "string" ? c : "")).join("")
							: (children ?? ""),
					)
						.replace(/^\d+\.\s+/, "")
						.trim();
					const id = slugify(text);
					return (
						<h2
							{...props}
							id={id}
							className="mt-5 mb-2 font-semibold text-[var(--text)] text-base scroll-mt-4"
						>
							{children}
						</h2>
					);
				},
				h3: ({ node, ...props }) => (
					<h3
						{...props}
						className="mt-3 mb-1 font-medium text-[var(--text)] text-sm"
					/>
				),
				p: ({ node, children, ...props }) => {
					const severity = extractLeadingSeverity(children);
					if (severity) {
						const tone = SEVERITY_TONES[severity.level];
						return (
							<div className={`my-2 ${tone.container}`} role="note">
								<div className="flex items-start gap-2">
									<span className="mt-[3px] shrink-0">{tone.icon}</span>
									<div className="min-w-0 text-sm leading-relaxed text-[var(--text)]">
										<span
											className={`mr-2 font-mono text-[0.72em] tracking-wide ${tone.labelClass}`}
										>
											[{tone.label}]
										</span>
										{processChildren(severity.rest)}
									</div>
								</div>
							</div>
						);
					}
					return (
						<p
							{...props}
							className="my-2 text-sm leading-relaxed text-[var(--text)]"
						>
							{processChildren(children)}
						</p>
					);
				},
				li: ({ node, children, ...props }) => {
					const severity = extractLeadingSeverity(children);
					if (severity) {
						const tone = SEVERITY_TONES[severity.level];
						return (
							<li
								{...props}
								className={`my-2 list-none text-sm leading-relaxed text-[var(--text)] ${tone.container}`}
							>
								<div className="flex items-start gap-2">
									<span className="mt-[3px] shrink-0">{tone.icon}</span>
									<div className="min-w-0">
										<span
											className={`mr-2 font-mono text-[0.72em] tracking-wide ${tone.labelClass}`}
										>
											[{tone.label}]
										</span>
										{processChildren(severity.rest)}
									</div>
								</div>
							</li>
						);
					}
					return (
						<li
							{...props}
							className="my-1 text-sm leading-relaxed text-[var(--text)]"
						>
							{processChildren(children)}
						</li>
					);
				},
				ul: ({ node, ...props }) => (
					<ul {...props} className="my-2 ml-5 list-disc space-y-1" />
				),
				ol: ({ node, ...props }) => (
					<ol {...props} className="my-2 ml-5 list-decimal space-y-1" />
				),
				strong: ({ node, ...props }) => (
					<strong {...props} className="font-semibold text-[var(--text)]" />
				),
				table: ({ node, ...props }) => (
					<table {...props} className="my-3 w-full border-collapse text-xs" />
				),
				th: ({ node, ...props }) => (
					<th
						{...props}
						className="border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-left font-medium"
					/>
				),
				td: ({ node, ...props }) => (
					<td {...props} className="border border-[var(--border)] px-2 py-1" />
				),
			}}
		>
			{report}
		</ReactMarkdown>
	);
}

function copyToClipboard(text: string) {
	if (typeof navigator === "undefined" || !navigator.clipboard) return;
	navigator.clipboard.writeText(text).catch(() => {});
}
