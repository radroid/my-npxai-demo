"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Priority markers the D.4 prompt embeds inline: [CRITICAL] / [ATTENTION] / [ROUTINE].
// Rendered as colored badges inline; when a paragraph STARTS with a marker we also
// render it as a full-width severity block so operators can scan for attention items.
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

export function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
}

export function ReportBody({ report }: { report: string }) {
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
