"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { createElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Priority markers the D.4 prompt embeds inline: [CRITICAL] / [ATTENTION] / [ROUTINE].
// Rendered as colored badges inline; when a paragraph STARTS with a marker we also
// render it as a full-width severity block so operators can scan for attention items.
const PRIORITY_RE = /\[(CRITICAL|ATTENTION|ROUTINE)\]/g;
const LEADING_PRIORITY_RE = /^\s*\[(CRITICAL|ATTENTION|ROUTINE)\]\s*/;

type SeverityLevel = "CRITICAL" | "ATTENTION" | "ROUTINE";
type SeverityTone = { container: string; icon: ReactNode; accent: string };

const CALLOUT_BASE = "border-l-4 px-3 py-2 rounded-r-md";
const PRIORITY_CHIP_BASE =
	"mx-0.5 inline-flex items-center rounded-full border px-1.5 py-0 font-mono text-[0.72em] leading-[1.4] align-baseline";

const SEVERITY_TONES: Record<SeverityLevel, SeverityTone> = {
	CRITICAL: {
		container: `${CALLOUT_BASE} border-danger bg-danger/10`,
		icon: <AlertTriangle className="size-4 text-danger" aria-hidden />,
		accent: "text-danger",
	},
	ATTENTION: {
		container: `${CALLOUT_BASE} border-guidance bg-guidance/10`,
		icon: <AlertTriangle className="size-4 text-guidance" aria-hidden />,
		accent: "text-guidance",
	},
	ROUTINE: {
		container: `${CALLOUT_BASE} border-border-strong bg-surface-2`,
		icon: <CheckCircle2 className="size-4 text-fg-muted" aria-hidden />,
		accent: "text-fg-muted",
	},
};

const PRIORITY_CHIP_CLS: Record<string, string> = {
	CRITICAL: "border-danger/40 bg-danger/10 text-danger",
	ATTENTION: "border-guidance/40 bg-guidance/10 text-guidance",
};
const PRIORITY_CHIP_DEFAULT = "border-border bg-surface text-fg-muted";

function PriorityBadge({ level }: { level: string }) {
	return (
		<span
			className={`${PRIORITY_CHIP_BASE} ${PRIORITY_CHIP_CLS[level] ?? PRIORITY_CHIP_DEFAULT}`}
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
	if (!Array.isArray(children)) return renderWithPriorities(children);
	return children.map((c, i) =>
		typeof c === "string" ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: children order is stable within a markdown node
			<span key={`seg-${i}-${c.length}`}>{renderWithPriorities(c)}</span>
		) : (
			c
		),
	);
}

function childrenToText(children: ReactNode): string {
	if (Array.isArray(children))
		return children.map((c) => (typeof c === "string" ? c : "")).join("");
	return typeof children === "string" ? children : "";
}

function extractLeadingSeverity(
	children: ReactNode,
): { level: SeverityLevel; rest: ReactNode } | null {
	const first = Array.isArray(children) ? children[0] : children;
	if (typeof first !== "string") return null;
	const match = first.match(LEADING_PRIORITY_RE);
	if (!match) return null;
	const level = match[1] as SeverityLevel;
	const trimmed = first.slice(match[0].length);
	const rest = Array.isArray(children)
		? [trimmed, ...children.slice(1)]
		: trimmed;
	return { level, rest };
}

function SeverityInner({
	level,
	rest,
}: {
	level: SeverityLevel;
	rest: ReactNode;
}) {
	const tone = SEVERITY_TONES[level];
	return (
		<div className="flex items-start gap-2">
			<span className="mt-[3px] shrink-0">{tone.icon}</span>
			<div className="min-w-0">
				<span
					className={`mr-2 font-mono text-[0.72em] tracking-wide ${tone.accent}`}
				>
					[{level}]
				</span>
				{processChildren(rest)}
			</div>
		</div>
	);
}

export function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
}

const TEXT_BODY = "text-sm leading-relaxed text-fg";

const styled =
	(tag: string, className: string) =>
	// biome-ignore lint/suspicious/noExplicitAny: generic factory over react-markdown's per-tag prop types
	({ node, ...props }: any) =>
		createElement(tag, { ...props, className });

export function ReportBody({ report }: { report: string }) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			components={{
				h1: styled("h1", "mt-0 mb-2 font-semibold text-fg text-lg"),
				h2: ({ node, children, ...props }) => (
					<h2
						{...props}
						id={slugify(
							childrenToText(children)
								.replace(/^\d+\.\s+/, "")
								.trim(),
						)}
						className="mt-5 mb-2 font-semibold text-fg text-base scroll-mt-4"
					>
						{children}
					</h2>
				),
				h3: styled("h3", "mt-3 mb-1 font-medium text-fg text-sm"),
				p: ({ node, children, ...props }) => {
					const sev = extractLeadingSeverity(children);
					if (sev) {
						return (
							<div
								className={`my-2 ${TEXT_BODY} ${SEVERITY_TONES[sev.level].container}`}
								role="note"
							>
								<SeverityInner level={sev.level} rest={sev.rest} />
							</div>
						);
					}
					return (
						<p {...props} className={`my-2 ${TEXT_BODY}`}>
							{processChildren(children)}
						</p>
					);
				},
				li: ({ node, children, ...props }) => {
					const sev = extractLeadingSeverity(children);
					if (sev) {
						return (
							<li
								{...props}
								className={`my-2 list-none ${TEXT_BODY} ${SEVERITY_TONES[sev.level].container}`}
							>
								<SeverityInner level={sev.level} rest={sev.rest} />
							</li>
						);
					}
					return (
						<li {...props} className={`my-1 ${TEXT_BODY}`}>
							{processChildren(children)}
						</li>
					);
				},
				ul: styled("ul", "my-2 ml-5 list-disc space-y-1"),
				ol: styled("ol", "my-2 ml-5 list-decimal space-y-1"),
				strong: styled("strong", "font-semibold text-fg"),
				table: styled("table", "my-3 w-full border-collapse text-xs"),
				th: styled(
					"th",
					"border border-border bg-surface-2 px-2 py-1 text-left font-medium",
				),
				td: styled("td", "border border-border px-2 py-1"),
			}}
		>
			{report}
		</ReactMarkdown>
	);
}
