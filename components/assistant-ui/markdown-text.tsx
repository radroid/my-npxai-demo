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
} from "@/components/knowledge-hub/citation-sources";
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
// as pill chips instead of plain text.
const CITATION_RE = /\[REGDOC-\d+(?:\.\d+){1,3}(?:\s+§[\d.]+)?\]/g;

function CitationChip({ label }: { label: string }) {
	const sources = useCitationSources();
	const match = findCitationMatch(sources, label);
	const inner = label.slice(1, -1);
	const baseClass =
		"mx-0.5 inline-flex items-center rounded-full border border-requirement/40 bg-requirement/10 px-1.5 py-0 font-mono text-[0.7em] text-requirement leading-[1.4] align-baseline";
	const tooltip = match?.section_title
		? `${inner} — ${match.section_title}`
		: `CNSC citation: ${inner}`;

	if (match?.url) {
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

// Walks component children, splits any string node on the citation regex,
// and wraps matches in <CitationChip />. Non-string nodes pass through.
function renderWithCitations(children: ReactNode): ReactNode {
	const out: ReactNode[] = [];
	let chipKey = 0;
	Children.forEach(children, (child, idx) => {
		if (typeof child !== "string") {
			out.push(child);
			return;
		}
		const parts = child.split(CITATION_RE);
		const matches = child.match(CITATION_RE) ?? [];
		parts.forEach((segment, i) => {
			if (segment) out.push(segment);
			const m = matches[i];
			if (m) {
				// biome-ignore lint/suspicious/noArrayIndexKey: chips are generated in render order and the chip text itself is not unique within a single message
				out.push(<CitationChip key={`c-${idx}-${chipKey++}-${m}`} label={m} />);
			}
		});
	});
	return out;
}

const defaultComponents = memoizeMarkdownComponents({
	h1: ({ className, ...props }) => (
		<h1
			className={cn(
				"aui-md-h1 mb-2 scroll-m-20 font-semibold text-base first:mt-0 last:mb-0",
				className,
			)}
			{...props}
		/>
	),
	h2: ({ className, ...props }) => (
		<h2
			className={cn(
				"aui-md-h2 mt-3 mb-1.5 scroll-m-20 font-semibold text-sm first:mt-0 last:mb-0",
				className,
			)}
			{...props}
		/>
	),
	h3: ({ className, ...props }) => (
		<h3
			className={cn(
				"aui-md-h3 mt-2.5 mb-1 scroll-m-20 font-semibold text-sm first:mt-0 last:mb-0",
				className,
			)}
			{...props}
		/>
	),
	h4: ({ className, ...props }) => (
		<h4
			className={cn(
				"aui-md-h4 mt-2 mb-1 scroll-m-20 font-medium text-sm first:mt-0 last:mb-0",
				className,
			)}
			{...props}
		/>
	),
	h5: ({ className, ...props }) => (
		<h5
			className={cn(
				"aui-md-h5 mt-2 mb-1 font-medium text-sm first:mt-0 last:mb-0",
				className,
			)}
			{...props}
		/>
	),
	h6: ({ className, ...props }) => (
		<h6
			className={cn(
				"aui-md-h6 mt-2 mb-1 font-medium text-sm first:mt-0 last:mb-0",
				className,
			)}
			{...props}
		/>
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
	a: ({ className, ...props }) => (
		<a
			className={cn(
				"aui-md-a text-primary underline underline-offset-2 hover:text-primary/80",
				className,
			)}
			{...props}
		/>
	),
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
	th: ({ className, ...props }) => (
		<th
			className={cn(
				"aui-md-th bg-muted px-2 py-1 text-left font-medium first:rounded-tl-lg last:rounded-tr-lg [[align=center]]:text-center [[align=right]]:text-right",
				className,
			)}
			{...props}
		/>
	),
	td: ({ className, ...props }) => (
		<td
			className={cn(
				"aui-md-td border-muted-foreground/20 border-b border-l px-2 py-1 text-left last:border-r [[align=center]]:text-center [[align=right]]:text-right",
				className,
			)}
			{...props}
		/>
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
