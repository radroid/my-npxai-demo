"use client";

import "@assistant-ui/react-markdown/styles/dot.css";

import {
	type CodeHeaderProps,
	MarkdownTextPrimitive,
	unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
	useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Children, type FC, memo, type ReactNode, useState } from "react";
import remarkGfm from "remark-gfm";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import {
	findCitationMatch,
	useCitationSources,
	useSnippetSources,
} from "@/components/knowledge-hub/citation-sources";
import {
	DOCUMENT_KIND_LABELS,
	isAllowedSourceUrl,
} from "@/lib/sources/catalog";
import type { SourceRecord } from "@/lib/sources/citations";
import { cn } from "@/lib/utils";

const MarkdownTextImpl = () => {
	return (
		<MarkdownTextPrimitive
			remarkPlugins={[remarkGfm]}
			className="aui-md"
			components={defaultComponents}
		/>
	);
};

export const MarkdownText = memo(MarkdownTextImpl);

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
	const { isCopied, copyToClipboard } = useCopyToClipboard();
	const onCopy = () => {
		if (!code || isCopied) return;
		copyToClipboard(code);
	};

	return (
		<div className="aui-code-header-root mt-2.5 flex items-center justify-between rounded-t-lg border border-border/50 border-b-0 bg-muted/50 px-3 py-1.5 text-xs">
			<span className="aui-code-header-language font-medium text-muted-foreground lowercase">
				{language}
			</span>
			<TooltipIconButton tooltip="Copy" onClick={onCopy}>
				{!isCopied && <CopyIcon />}
				{isCopied && <CheckIcon />}
			</TooltipIconButton>
		</div>
	);
};

const useCopyToClipboard = ({
	copiedDuration = 3000,
}: {
	copiedDuration?: number;
} = {}) => {
	const [isCopied, setIsCopied] = useState<boolean>(false);

	const copyToClipboard = (value: string) => {
		if (!value) return;

		navigator.clipboard.writeText(value).then(() => {
			setIsCopied(true);
			setTimeout(() => setIsCopied(false), copiedDuration);
		});
	};

	return { isCopied, copyToClipboard };
};

// Matches Appendix D.5 citation regex. Used to find inline [REGDOC-X.X.X]
// or [REGDOC-X.X.X §Y.Z] patterns in the streamed markdown and render them
// as pill chips instead of plain text. Kept for saved (pre-Phase-12) threads.
const CITATION_RE = /\[REGDOC-\d+(?:\.\d+){1,3}(?:\s+§[\d.]+)?\]/g;
// v2 snippet-id citations — the grammar of lib/sources/citations.ts
// SNIPPET_CITATION_RE ([[S1]], [[S1, S3]], and the [S1] slip).
const SNIPPET_RE =
	/\[\[\s*(S\d{1,2}(?:\s*[,;]\s*S\d{1,2})*)\s*\]\]|\[(S\d{1,2})\]/g;
// Any other [[…]] (lib/sources/citations.ts MALFORMED_CITATION_RE): a
// citation-looking slip such as "[[8 CFR 20.1201]]" renders as unverified.
const MALFORMED_RE =
	/\[\[(?!\s*(?:S\d{1,2}\s*(?:[,;]\s*S\d{1,2}\s*)*\]\]|REGDOC))([^[\]\n<>]{1,80})\]\]/g;
const ANY_CITATION_RE = new RegExp(
	`${SNIPPET_RE.source}|${MALFORMED_RE.source}|${CITATION_RE.source}`,
	"g",
);

const CHIP_BASE =
	"mx-0.5 inline-flex items-center rounded-full border px-1.5 py-0 font-mono text-[0.7em] leading-[1.4] align-baseline";
const CHIP_REQUIREMENT =
	"border-requirement/40 bg-requirement/10 text-requirement";
const CHIP_GUIDANCE = "border-guidance/40 bg-guidance/10 text-guidance";

function CitationChip({ label }: { label: string }) {
	const sources = useCitationSources();
	const match = findCitationMatch(sources, label);
	const inner = label.slice(1, -1);
	const baseClass = `${CHIP_BASE} ${CHIP_REQUIREMENT}`;
	const tooltip = match?.section_title
		? `${inner} — ${match.section_title}`
		: `CNSC citation: ${inner}`;

	if (match?.url && isAllowedSourceUrl(match.url)) {
		return (
			<a
				href={match.url}
				target="_blank"
				rel="noopener noreferrer"
				data-citation="true"
				className={`${baseClass} cursor-pointer no-underline transition-colors hover:bg-requirement/20 hover:text-requirement focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-requirement`}
				title={tooltip}
			>
				{inner}
			</a>
		);
	}

	return (
		<span data-citation="true" className={baseClass} title={tooltip}>
			{inner}
		</span>
	);
}

function snippetTooltip(s: SourceRecord): string {
	const kind = DOCUMENT_KIND_LABELS[s.document_kind] ?? s.document_kind;
	const parts = [
		s.title + (s.section_title ? ` — ${s.section_title}` : ""),
		[s.publisher, kind, s.edition].filter(Boolean).join(" · "),
	];
	if (s.status !== "current") parts.push(`${s.status} edition`);
	if (s.legal_force === "nonbinding") parts.push("Not binding");
	return parts.join("\n");
}

// One [[S…]] group → one chip per id. Everything shown comes from the
// server's data-sources payload; an id it did not hand out renders as an
// explicit "unverified" marker, never as a guess.
function SnippetCitation({ ids, raw }: { ids: string[]; raw: string }) {
	const sources = useSnippetSources();
	// A message without a v2 payload (every pre-Phase-12 thread) has no ids to
	// resolve against — show the text as written, not an "unverified" chip.
	if (!sources) return <>{raw}</>;
	return (
		<>
			{ids.map((sid, i) => {
				const key = `${sid}-${i}`;
				const s = sources?.find((x) => x.sid === sid);
				if (!s) {
					return (
						<span
							key={key}
							data-citation="unresolved"
							className={`${CHIP_BASE} border-dashed border-border text-fg-muted`}
							title="This citation does not match a retrieved source"
						>
							unverified
						</span>
					);
				}
				const requirement =
					s.requirement_type === "requirement" &&
					s.legal_force !== "nonbinding";
				const cls = `${CHIP_BASE} ${requirement ? CHIP_REQUIREMENT : CHIP_GUIDANCE}`;
				if (isAllowedSourceUrl(s.url)) {
					return (
						<a
							key={key}
							href={s.url}
							target="_blank"
							rel="noopener noreferrer"
							data-citation="true"
							className={`${cls} cursor-pointer no-underline transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
							title={snippetTooltip(s)}
						>
							{s.chip}
						</a>
					);
				}
				return (
					<span
						key={key}
						data-citation="true"
						className={cls}
						title={snippetTooltip(s)}
					>
						{s.chip}
					</span>
				);
			})}
		</>
	);
}

// Walks component children, splits any string node on the citation
// grammars, and wraps matches in chips. Non-string nodes pass through.
function renderWithCitations(children: ReactNode): ReactNode {
	const out: ReactNode[] = [];
	let chipKey = 0;
	Children.forEach(children, (child, idx) => {
		if (typeof child !== "string") {
			out.push(child);
			return;
		}
		let last = 0;
		for (const m of child.matchAll(ANY_CITATION_RE)) {
			const at = m.index ?? 0;
			if (at > last) out.push(child.slice(last, at));
			const group = m[1] ?? m[2];
			const key = `c-${idx}-${chipKey++}`;
			if (group) {
				const ids = group
					.split(/[,;]/)
					.map((x) => x.trim())
					.filter(Boolean);
				out.push(<SnippetCitation key={key} ids={ids} raw={m[0]} />);
			} else if (m[3] !== undefined) {
				// Never an id the server handed out: "unverified" on a v2
				// message, the text as written on a legacy one.
				out.push(<SnippetCitation key={key} ids={[m[3].trim()]} raw={m[0]} />);
			} else {
				out.push(<CitationChip key={key} label={m[0]} />);
			}
			last = at + m[0].length;
		}
		if (last < child.length) out.push(child.slice(last));
	});
	return out;
}

const defaultComponents = memoizeMarkdownComponents({
	h1: ({ className, children, ...props }) => (
		<h1
			className={cn(
				"aui-md-h1 mb-2 scroll-m-20 font-semibold text-base first:mt-0 last:mb-0",
				className,
			)}
			{...props}
		>
			{renderWithCitations(children)}
		</h1>
	),
	h2: ({ className, children, ...props }) => (
		<h2
			className={cn(
				"aui-md-h2 mt-3 mb-1.5 scroll-m-20 font-semibold text-sm first:mt-0 last:mb-0",
				className,
			)}
			{...props}
		>
			{renderWithCitations(children)}
		</h2>
	),
	h3: ({ className, children, ...props }) => (
		<h3
			className={cn(
				"aui-md-h3 mt-2.5 mb-1 scroll-m-20 font-semibold text-sm first:mt-0 last:mb-0",
				className,
			)}
			{...props}
		>
			{renderWithCitations(children)}
		</h3>
	),
	h4: ({ className, children, ...props }) => (
		<h4
			className={cn(
				"aui-md-h4 mt-2 mb-1 scroll-m-20 font-medium text-sm first:mt-0 last:mb-0",
				className,
			)}
			{...props}
		>
			{renderWithCitations(children)}
		</h4>
	),
	h5: ({ className, children, ...props }) => (
		<h5
			className={cn(
				"aui-md-h5 mt-2 mb-1 font-medium text-sm first:mt-0 last:mb-0",
				className,
			)}
			{...props}
		>
			{renderWithCitations(children)}
		</h5>
	),
	h6: ({ className, children, ...props }) => (
		<h6
			className={cn(
				"aui-md-h6 mt-2 mb-1 font-medium text-sm first:mt-0 last:mb-0",
				className,
			)}
			{...props}
		>
			{renderWithCitations(children)}
		</h6>
	),
	p: ({ className, children, ...props }) => (
		<p
			className={cn(
				"aui-md-p my-2.5 leading-normal first:mt-0 last:mb-0",
				className,
			)}
			{...props}
		>
			{renderWithCitations(children)}
		</p>
	),
	// Model-written links (markdown links and GFM-autolinked bare URLs) are
	// live only for the official-source allowlist — the same rule as chips,
	// the Sources panel and artifacts. Retrieved text can carry third-party
	// or injected URLs ("download the updated guide at …"); those render as
	// their label text only. A bare URL's label IS the URL, so it stays
	// readable; a labelled link's target is not shown. In-page anchors (GFM
	// footnotes) stay links.
	a: ({ className, href, children, ...props }) =>
		href?.startsWith("#") ? (
			<a
				className={cn("aui-md-a text-primary underline", className)}
				{...props}
				href={href}
			>
				{children}
			</a>
		) : isAllowedSourceUrl(href) ? (
			<a
				className={cn(
					"aui-md-a text-primary underline underline-offset-2 hover:text-primary/80",
					className,
				)}
				{...props}
				href={href}
				target="_blank"
				rel="noopener noreferrer"
			>
				{children}
			</a>
		) : (
			<span
				className="aui-md-a-blocked break-all"
				title="Link not opened: only official source links are clickable"
			>
				{children}
			</span>
		),
	// Never load a model-written image: an injected ![](https://…) would be
	// fetched with no click (the same exfiltration channel the link gate
	// closes). The alt text is shown instead.
	img: ({ alt }) =>
		alt ? <span className="aui-md-img-blocked italic">{alt}</span> : null,
	blockquote: ({ className, ...props }) => (
		<blockquote
			className={cn(
				"aui-md-blockquote my-2.5 border-muted-foreground/30 border-l-2 pl-3 text-muted-foreground italic",
				className,
			)}
			{...props}
		/>
	),
	ul: ({ className, ...props }) => (
		<ul
			className={cn(
				"aui-md-ul my-2 ml-4 list-disc marker:text-muted-foreground [&>li]:mt-1",
				className,
			)}
			{...props}
		/>
	),
	ol: ({ className, ...props }) => (
		<ol
			className={cn(
				"aui-md-ol my-2 ml-4 list-decimal marker:text-muted-foreground [&>li]:mt-1",
				className,
			)}
			{...props}
		/>
	),
	hr: ({ className, ...props }) => (
		<hr
			className={cn("aui-md-hr my-2 border-muted-foreground/20", className)}
			{...props}
		/>
	),
	table: ({ className, ...props }) => (
		<table
			className={cn(
				"aui-md-table my-2 w-full border-separate border-spacing-0 overflow-y-auto",
				className,
			)}
			{...props}
		/>
	),
	th: ({ className, children, ...props }) => (
		<th
			className={cn(
				"aui-md-th bg-muted px-2 py-1 text-left font-medium first:rounded-tl-lg last:rounded-tr-lg [[align=center]]:text-center [[align=right]]:text-right",
				className,
			)}
			{...props}
		>
			{renderWithCitations(children)}
		</th>
	),
	td: ({ className, children, ...props }) => (
		<td
			className={cn(
				"aui-md-td border-muted-foreground/20 border-b border-l px-2 py-1 text-left last:border-r [[align=center]]:text-center [[align=right]]:text-right",
				className,
			)}
			{...props}
		>
			{renderWithCitations(children)}
		</td>
	),
	strong: ({ children, ...props }) => (
		<strong {...props}>{renderWithCitations(children)}</strong>
	),
	em: ({ children, ...props }) => (
		<em {...props}>{renderWithCitations(children)}</em>
	),
	tr: ({ className, ...props }) => (
		<tr
			className={cn(
				"aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-bl-lg [&:last-child>td:last-child]:rounded-br-lg",
				className,
			)}
			{...props}
		/>
	),
	li: ({ className, children, ...props }) => (
		<li className={cn("aui-md-li leading-normal", className)} {...props}>
			{renderWithCitations(children)}
		</li>
	),
	sup: ({ className, ...props }) => (
		<sup
			className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
			{...props}
		/>
	),
	pre: ({ className, ...props }) => (
		<pre
			className={cn(
				"aui-md-pre overflow-x-auto rounded-t-none rounded-b-lg border border-border/50 border-t-0 bg-muted/30 p-3 text-xs leading-relaxed",
				className,
			)}
			{...props}
		/>
	),
	code: function Code({ className, ...props }) {
		const isCodeBlock = useIsMarkdownCodeBlock();
		return (
			<code
				className={cn(
					!isCodeBlock &&
						"aui-md-inline-code rounded-md border border-border/50 bg-muted/50 px-1.5 py-0.5 font-mono text-[0.85em]",
					className,
				)}
				{...props}
			/>
		);
	},
	CodeHeader,
});
