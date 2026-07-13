"use client";

// Artifact workbench (item-1 slice 1.2): one regulatory question → one
// self-contained NPX-branded HTML explainer, rendered in a sandboxed iframe.
// Security invariants (spec docs/orchestration/specs/item-1-artifact-mode.md):
// - I1.1  artifact html renders ONLY via iframe srcDoc with EXACTLY
//         sandbox="allow-popups allow-popups-to-escape-sandbox" — never
//         allow-scripts, never allow-same-origin, never dangerouslySetInnerHTML.
// - I1.7  the html never becomes a blob:/object URL handed to window.open or
//         a navigable href — the Blob below exists only for the download-
//         attribute anchor (download-to-file), revoked immediately.
// - I1.3  all workbench chrome uses canonical token utilities (both themes).
// The iframe DOCUMENT is intentionally theme-fixed NPX-dark in all app themes
// — a framed document surface, like a PDF preview (deliberate, not a bug).

import { ArrowUpIcon, DownloadIcon, SquareIcon } from "lucide-react";
import { type FC, type ReactNode, useEffect, useRef, useState } from "react";
import { SourcesPanel } from "@/components/knowledge-hub/SourcesPanel";
import {
	type ArtifactError,
	type ArtifactResult,
	useArtifactStream,
} from "@/hooks/use-artifact-stream";

// Starter TOPICS tuned for explainer strength (deeper than the chat starters
// in components/assistant-ui/thread.tsx — an artifact spans more sections).
const STARTER_TOPICS: string[] = [
	"Explain the graded approach and how it applies across REGDOCs",
	"Defence in depth in reactor design (REGDOC-2.5.2) — levels and barriers",
	"Requirements vs guidance for radiation protection programs (REGDOC-2.7.1)",
	"How waste acceptance criteria work under REGDOC-2.11.1",
];

// Largest tier query cap (lib/validators.ts QUERY_CHAR_CAP.npx_circle) as a
// soft client bound; the server enforces the real per-tier cap.
const INPUT_MAX_LENGTH = 2500;

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
	return slug || "explainer";
}

function downloadFilename(artifact: ArtifactResult): string {
	const yyyymmdd = artifact.generatedAt.slice(0, 10).replaceAll("-", "");
	return `npx-artifact-${slugify(artifact.query)}-${yyyymmdd}.html`;
}

export interface ArtifactWorkbenchProps {
	// The shared ModeToggle, rendered above the input — same position as the
	// chat surface's composerHeader slot so the control never moves on screen.
	modeToggle: ReactNode;
}

export function ArtifactWorkbench({ modeToggle }: ArtifactWorkbenchProps) {
	const { status, error, tokens, artifact, generate, stop } =
		useArtifactStream();
	const [input, setInput] = useState("");
	const [submittedQuery, setSubmittedQuery] = useState("");
	const rootRef = useRef<HTMLDivElement | null>(null);

	const running = status === "retrieving" || status === "drafting";

	// Escape aborts the in-flight run. The textarea is disabled while running
	// (its own keydown can't fire), so listen at window level — but only while
	// the workbench surface is visible: toggling to Chat mid-run keeps the run
	// streaming hidden, and Escape pressed in chat must not abort it.
	// offsetParent is null whenever a `hidden` ancestor removes us from layout.
	useEffect(() => {
		if (!running) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			const el = rootRef.current;
			if (!el || el.offsetParent === null) return;
			stop();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [running, stop]);

	const submit = (raw: string) => {
		const query = raw.trim();
		if (!query || running) return;
		setSubmittedQuery(query);
		void generate(query);
	};

	const handleStarter = (topic: string) => {
		setInput(topic);
		submit(topic);
	};

	const handleDownload = () => {
		if (!artifact) return;
		// Download-to-file only (I1.7): the object URL lives just long enough
		// for the download-attribute click and is revoked synchronously after.
		const blob = new Blob([artifact.html], { type: "text/html" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = downloadFilename(artifact);
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		URL.revokeObjectURL(url);
	};

	return (
		<div ref={rootRef} className="flex h-full flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4">
				<div className="mx-auto flex h-full w-full max-w-[44rem] flex-col">
					{status === "error" && error ? (
						<ErrorState
							error={error}
							onRetry={() => submit(submittedQuery)}
							onStarter={handleStarter}
							disabled={running}
						/>
					) : running ? (
						<ProgressState status={status} tokens={tokens} />
					) : artifact ? (
						<ArtifactViewer artifact={artifact} onDownload={handleDownload} />
					) : (
						<EmptyState onStarter={handleStarter} disabled={running} />
					)}
				</div>
			</div>

			<div className="mx-auto flex w-full max-w-[44rem] flex-col gap-2 px-4 pt-3 pb-4 md:pb-6">
				{modeToggle}
				<form
					onSubmit={(e) => {
						e.preventDefault();
						submit(input);
					}}
					className="flex w-full flex-col gap-2 rounded-3xl border bg-background p-2.5 transition-shadow focus-within:border-ring/75 focus-within:ring-2 focus-within:ring-ring/20"
				>
					<textarea
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								submit(input);
							}
						}}
						placeholder="Describe the regulatory topic to explain..."
						aria-label="Artifact topic input"
						rows={1}
						maxLength={INPUT_MAX_LENGTH}
						disabled={running}
						className="max-h-32 min-h-10 w-full resize-none bg-transparent px-1.75 py-1 text-sm outline-none placeholder:text-muted-foreground/80 disabled:opacity-60"
					/>
					<div className="flex items-center justify-between">
						<span className="px-1.5 text-[11px] text-fg-muted">
							{running
								? "Generating — Esc or Stop to cancel."
								: "One question → one downloadable HTML explainer."}
						</span>
						{running ? (
							<button
								type="button"
								onClick={stop}
								aria-label="Stop generating"
								className="inline-flex size-8 items-center justify-center rounded-full bg-brand text-white transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							>
								<SquareIcon
									aria-hidden="true"
									className="size-3 fill-current"
								/>
							</button>
						) : (
							<button
								type="submit"
								disabled={!input.trim()}
								aria-label="Generate artifact"
								className="inline-flex size-8 items-center justify-center rounded-full bg-brand text-white transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50"
							>
								<ArrowUpIcon aria-hidden="true" className="size-4" />
							</button>
						)}
					</div>
				</form>
			</div>
		</div>
	);
}

const EmptyState: FC<{
	onStarter: (topic: string) => void;
	disabled: boolean;
}> = ({ onStarter, disabled }) => (
	<div className="flex grow flex-col justify-center pb-4">
		<h1 className="font-semibold text-2xl">Artifact mode</h1>
		<p className="mt-1 text-muted-foreground text-sm">
			Turn one regulatory question into a self-contained HTML explainer —
			diagrams, requirement-vs-guidance callouts, and CNSC citations — that you
			can download and share.
		</p>
		<StarterTopics onStarter={onStarter} disabled={disabled} />
	</div>
);

const StarterTopics: FC<{
	onStarter: (topic: string) => void;
	disabled: boolean;
}> = ({ onStarter, disabled }) => (
	<div className="mt-4 grid w-full gap-2 md:grid-cols-2">
		{STARTER_TOPICS.map((topic) => (
			<button
				key={topic}
				type="button"
				disabled={disabled}
				onClick={() => onStarter(topic)}
				className="h-auto w-full rounded-xl border bg-background px-4 py-3 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-60"
			>
				{topic}
			</button>
		))}
	</div>
);

// Phase labels reuse the thinking-pill visual language of the chat thread
// (components/assistant-ui/thread.tsx ThinkingPill).
const ProgressState: FC<{ status: string; tokens: number }> = ({
	status,
	tokens,
}) => (
	<div className="flex grow flex-col items-center justify-center gap-3 pb-4">
		<div
			role="status"
			aria-live="polite"
			className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-fg-muted text-xs"
		>
			<span
				aria-hidden="true"
				className="h-1.5 w-1.5 animate-breathe rounded-full bg-brand"
			/>
			<span>
				{status === "retrieving"
					? "Searching REGDOCs…"
					: tokens > 0
						? `Drafting explainer — ~${tokens} tokens…`
						: "Drafting explainer…"}
			</span>
		</div>
		<p className="text-fg-muted text-xs">
			A full explainer can take up to a minute.
		</p>
	</div>
);

const ArtifactViewer: FC<{
	artifact: ArtifactResult;
	onDownload: () => void;
}> = ({ artifact, onDownload }) => {
	const generatedLabel = new Date(artifact.generatedAt).toLocaleString([], {
		dateStyle: "medium",
		timeStyle: "short",
	});
	return (
		<div className="flex flex-col gap-3 pb-4">
			<div className="overflow-hidden rounded-xl border border-border bg-surface">
				<div className="flex items-center justify-between gap-2 border-border border-b px-3 py-2">
					<span
						className="min-w-0 truncate text-fg-muted text-xs"
						title={artifact.query}
					>
						{artifact.query}
					</span>
					<span className="shrink-0 text-[11px] text-fg-muted">
						{generatedLabel}
					</span>
				</div>
				{/*
				  I1.1 (LOAD-BEARING): sandbox is EXACTLY allow-popups +
				  allow-popups-to-escape-sandbox — popups only exist so the footer's
				  target="_blank" CNSC citation links open; with no allow-scripts
				  nothing executes inside. NEVER add allow-scripts or
				  allow-same-origin here.
				*/}
				<iframe
					title={`Generated explainer: ${artifact.query}`}
					sandbox="allow-popups allow-popups-to-escape-sandbox"
					srcDoc={artifact.html}
					className="block h-[65dvh] min-h-[60dvh] w-full"
				/>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					onClick={onDownload}
					className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 font-medium text-white text-xs transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				>
					<DownloadIcon aria-hidden="true" className="size-3.5" />
					Download .html
				</button>
				{artifact.cached ? (
					<span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-fg-muted">
						Cached result
					</span>
				) : null}
				{artifact.truncated ? (
					<span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] text-warning">
						Truncated — regenerate for the full explainer
					</span>
				) : null}
			</div>
			<SourcesPanel data={{ chunks: artifact.sources }} />
		</div>
	);
};

const ERROR_TITLES: Record<ArtifactError["kind"], string> = {
	validation: "That query can't be processed",
	rate_limit: "Rate limit reached",
	out_of_scope: "Outside the indexed corpus",
	output_guard: "Generation discarded",
	generation_failed: "Generation failed",
	server: "Something went wrong",
	network: "Connection problem",
};

const ErrorState: FC<{
	error: ArtifactError;
	onRetry: () => void;
	onStarter: (topic: string) => void;
	disabled: boolean;
}> = ({ error, onRetry, onStarter, disabled }) => (
	<div className="flex grow flex-col justify-center pb-4">
		<div
			role="alert"
			className="rounded-xl border border-danger/40 bg-danger/10 p-4"
		>
			<h2 className="font-semibold text-danger text-sm">
				{ERROR_TITLES[error.kind]}
			</h2>
			{/* Server messages render verbatim (validation caps, 429 upsell copy,
			    canonical out-of-scope sentence). */}
			<p className="mt-1 text-fg text-sm">{error.message}</p>
			<button
				type="button"
				onClick={onRetry}
				className="mt-3 inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 font-medium text-fg text-xs transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
			>
				Retry
			</button>
		</div>
		{error.kind === "out_of_scope" ? (
			<>
				<p className="mt-4 text-fg-muted text-sm">
					The explainer only covers the indexed CNSC corpus. Try one of these:
				</p>
				<StarterTopics onStarter={onStarter} disabled={disabled} />
			</>
		) : null}
	</div>
);
