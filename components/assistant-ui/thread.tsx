import {
	ActionBarMorePrimitive,
	ActionBarPrimitive,
	AuiIf,
	ComposerPrimitive,
	ErrorPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
	useAuiState,
} from "@assistant-ui/react";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	CheckIcon,
	CopyIcon,
	DownloadIcon,
	MoreHorizontalIcon,
	PencilIcon,
	SquareIcon,
} from "lucide-react";
import { type FC, type ReactNode, useEffect, useMemo, useState } from "react";
import {
	ComposerAddAttachment,
	ComposerAttachments,
	UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { Reasoning } from "@/components/assistant-ui/reasoning";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import {
	type CitationSource,
	CitationSourcesProvider,
} from "@/components/knowledge-hub/citation-sources";
import { Button } from "@/components/ui/button";

// `composerHeader` is an additive slot rendered immediately above the
// composer (item-1 slice 1.2 — the Knowledge Hub mode toggle). Default
// undefined renders markup identical to the prop-less Thread.
export const Thread: FC<{ composerHeader?: ReactNode }> = ({
	composerHeader,
}) => (
	<ThreadPrimitive.Root
		className="aui-root aui-thread-root @container flex h-full flex-col bg-background"
		style={{
			["--thread-max-width" as string]: "44rem",
			["--composer-radius" as string]: "24px",
			["--composer-padding" as string]: "10px",
		}}
	>
		<ThreadPrimitive.Viewport
			turnAnchor="top"
			role="log"
			aria-live="polite"
			aria-label="Conversation transcript"
			className="aui-thread-viewport relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth px-4 pt-4"
		>
			<AuiIf condition={(s) => s.thread.isEmpty}>
				<ThreadWelcome />
			</AuiIf>

			<ThreadPrimitive.Messages>
				{() => <ThreadMessage />}
			</ThreadPrimitive.Messages>

			<ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 overflow-visible rounded-t-(--composer-radius) bg-background pb-4 md:pb-6">
				<ThreadScrollToBottom />
				{composerHeader}
				<Composer />
			</ThreadPrimitive.ViewportFooter>
		</ThreadPrimitive.Viewport>
	</ThreadPrimitive.Root>
);

const ThreadMessage: FC = () => {
	const role = useAuiState((s) => s.message.role);
	const isEditing = useAuiState((s) => s.message.composer.isEditing);
	if (isEditing) return <EditComposer />;
	if (role === "user") return <UserMessage />;
	return <AssistantMessage />;
};

const ThreadScrollToBottom: FC = () => (
	<ThreadPrimitive.ScrollToBottom asChild>
		<TooltipIconButton
			tooltip="Scroll to bottom"
			variant="outline"
			className="aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible dark:border-border dark:bg-background dark:hover:bg-accent"
		>
			<ArrowDownIcon />
		</TooltipIconButton>
	</ThreadPrimitive.ScrollToBottom>
);

// Appendix E Q1–5 — canonical starter questions (see PLAN.md Appendix E.1).
// Surfaced on the empty state so first-time visitors (including the NPX
// evaluators) have a clear demonstration of the Knowledge Hub's capability
// without thinking of a regulatory question on the spot.
const STARTER_QUESTIONS: Array<{ title: string; prompt: string }> = [
	{
		title: "Shift turnover requirements",
		prompt:
			"What are the CNSC requirements for shift turnover at a reactor facility?",
	},
	{
		title: "Minimum staff complement",
		prompt: "What is the minimum staff complement for a nuclear power plant?",
	},
	{
		title: "Personnel training (REGDOC-2.2.2)",
		prompt: "What does REGDOC-2.2.2 say about personnel training programs?",
	},
	{
		title: "Aging management (REGDOC-2.6.3)",
		prompt:
			"What does REGDOC-2.6.3 require for aging management of structures, systems and components?",
	},
	{
		title: "Accident management",
		prompt:
			"How should an accident management program be structured at a nuclear facility?",
	},
];

const ThreadWelcome: FC = () => (
	<div className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col">
		<div className="aui-thread-welcome-center flex w-full grow flex-col items-center justify-center">
			<div className="aui-thread-welcome-message flex size-full flex-col justify-center px-4">
				<h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both font-semibold text-2xl duration-200">
					CNSC Knowledge Hub
				</h1>
				<p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-muted-foreground text-xl delay-75 duration-200">
					Ask a regulatory question — answers cite REGDOC + section.
				</p>
				<p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 mt-3 animate-in fill-mode-both text-muted-foreground text-sm delay-100 duration-200">
					Or start with one of these:
				</p>
			</div>
		</div>
		<StarterQuestions />
	</div>
);

const StarterQuestions: FC = () => (
	// ThreadPrimitive.Suggestion handles the race guard internally: its trigger
	// checks `thread.isRunning` at click time and no-ops if a run is in flight,
	// replacing our old launchedRef + setLaunched state. It also calls
	// `thread.append()` directly instead of stuffing the composer and calling
	// send, so the text never flashes in the input box.
	<div className="aui-thread-welcome-suggestions grid w-full @md:grid-cols-2 gap-2 pb-4">
		{STARTER_QUESTIONS.map((s) => (
			<ThreadPrimitive.Suggestion key={s.prompt} prompt={s.prompt} send asChild>
				<button
					type="button"
					className="fade-in slide-in-from-bottom-2 animate-in fill-mode-both h-auto w-full rounded-xl border bg-background px-4 py-3 text-left text-sm transition-colors duration-200 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-60"
				>
					<span className="block font-medium">{s.title}</span>
					<span className="mt-0.5 block text-muted-foreground text-xs">
						{s.prompt}
					</span>
				</button>
			</ThreadPrimitive.Suggestion>
		))}
	</div>
);

const Composer: FC = () => (
	<ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
		<ComposerPrimitive.AttachmentDropzone asChild>
			<div
				data-slot="composer-shell"
				className="flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-background p-(--composer-padding) transition-shadow focus-within:border-ring/75 focus-within:ring-2 focus-within:ring-ring/20 data-[dragging=true]:border-ring data-[dragging=true]:border-dashed data-[dragging=true]:bg-accent/50"
			>
				<ComposerAttachments />
				<ComposerPrimitive.Input
					placeholder="Send a message..."
					className="aui-composer-input max-h-32 min-h-10 w-full resize-none bg-transparent px-1.75 py-1 text-sm outline-none placeholder:text-muted-foreground/80"
					rows={1}
					autoFocus
					aria-label="Message input"
				/>
				<ComposerAction />
			</div>
		</ComposerPrimitive.AttachmentDropzone>
	</ComposerPrimitive.Root>
);

const ComposerAction: FC = () => (
	<div className="aui-composer-action-wrapper relative flex items-center justify-between">
		<ComposerAddAttachment />
		<AuiIf condition={(s) => !s.thread.isRunning}>
			<ComposerPrimitive.Send asChild>
				<TooltipIconButton
					tooltip="Send message"
					side="bottom"
					type="button"
					variant="default"
					size="icon"
					className="aui-composer-send size-8 rounded-full"
					aria-label="Send message"
				>
					<ArrowUpIcon className="aui-composer-send-icon size-4" />
				</TooltipIconButton>
			</ComposerPrimitive.Send>
		</AuiIf>
		<AuiIf condition={(s) => s.thread.isRunning}>
			<ComposerPrimitive.Cancel asChild>
				<Button
					type="button"
					variant="default"
					size="icon"
					className="aui-composer-cancel size-8 rounded-full"
					aria-label="Stop generating"
				>
					<SquareIcon className="aui-composer-cancel-icon size-3 fill-current" />
				</Button>
			</ComposerPrimitive.Cancel>
		</AuiIf>
	</div>
);

const MessageError: FC = () => (
	<MessagePrimitive.Error>
		<ErrorPrimitive.Root className="aui-message-error-root mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive text-sm dark:bg-destructive/5 dark:text-red-200">
			<ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
		</ErrorPrimitive.Root>
	</MessagePrimitive.Error>
);

const EMPTY_CITATION_SOURCES: CitationSource[] = [];

// Thinking verbs shown while the model is processing but before the first
// token arrives. Regulatory-flavored to match the Knowledge Hub tone —
// matches what the pipeline is actually doing in each phase.
const THINKING_VERBS = [
	"Searching REGDOCs",
	"Retrieving citations",
	"Cross-referencing sections",
	"Grounding answer",
	"Drafting",
	"Synthesizing",
];

const ThinkingPill: FC = () => {
	const status = useAuiState((s) => s.message.status);
	const parts = useAuiState((s) => s.message.parts);
	const [idx, setIdx] = useState(0);

	const isRunning = status?.type === "running";
	const hasText = useMemo(() => {
		const ps = parts as unknown as Array<{ type?: string; text?: string }>;
		return Boolean(
			ps?.some((p) => p?.type === "text" && p.text && p.text.length > 0),
		);
	}, [parts]);

	useEffect(() => {
		if (!isRunning || hasText) return;
		const id = setInterval(
			() => setIdx((i) => (i + 1) % THINKING_VERBS.length),
			1200,
		);
		return () => clearInterval(id);
	}, [isRunning, hasText]);

	if (!isRunning || hasText) return null;

	return (
		<div
			role="status"
			aria-live="polite"
			className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-xs text-fg-muted"
		>
			<span
				aria-hidden="true"
				className="h-1.5 w-1.5 animate-breathe rounded-full bg-brand"
			/>
			<span>{THINKING_VERBS[idx]}…</span>
		</div>
	);
};

// Blinking caret appended to the tail of the currently streaming assistant
// message. Gated on thread.isRunning so a completed message can never keep
// the caret around — message.status alone occasionally lagged behind the
// final stream event and left a stray blinker after text was fully rendered.
const StreamingCaret: FC = () => {
	const threadRunning = useAuiState((s) => s.thread.isRunning);
	const status = useAuiState((s) => s.message.status);
	const parts = useAuiState((s) => s.message.parts);
	const hasText = useMemo(() => {
		const ps = parts as unknown as Array<{ type?: string; text?: string }>;
		return Boolean(
			ps?.some((p) => p?.type === "text" && p.text && p.text.length > 0),
		);
	}, [parts]);
	if (!threadRunning || status?.type !== "running" || !hasText) return null;
	return (
		<span
			aria-hidden="true"
			className="generator-caret inline-block h-[1em] w-[2px] translate-y-[2px] bg-brand align-baseline"
		/>
	);
};

const AssistantMessage: FC = () => {
	// Subscribe to the stable `parts` reference only; deriving citationSources
	// inside a selector closure returns a new [] literal on every call and
	// throws `getSnapshot should be cached` → maximum update depth exceeded.
	// Derive in useMemo instead so the memoized array identity is stable.
	const messageParts = useAuiState((s) => s.message.parts);
	const citationSources = useMemo<CitationSource[]>(() => {
		const parts = messageParts as unknown as Array<{
			type?: string;
			data?: { chunks?: CitationSource[] };
		}>;
		const sources = parts?.find(
			(p) => p?.type === "data-sources" && Array.isArray(p.data?.chunks),
		)?.data?.chunks;
		return sources ?? EMPTY_CITATION_SOURCES;
	}, [messageParts]);

	return (
		<CitationSourcesProvider sources={citationSources}>
			<MessagePrimitive.Root
				className="aui-assistant-message-root fade-in slide-in-from-bottom-1 relative mx-auto w-full max-w-(--thread-max-width) animate-in py-3 duration-150"
				data-role="assistant"
			>
				<div className="aui-assistant-message-content wrap-break-word px-2 text-foreground leading-relaxed">
					<ThinkingPill />
					<MessagePrimitive.Parts>
						{({ part }) => {
							if (part.type === "text") return <MarkdownText />;
							if (part.type === "reasoning") return <Reasoning {...part} />;
							if (part.type === "tool-call")
								return part.toolUI ?? <ToolFallback {...part} />;
							// `data` parts (including our data-sources payload) are
							// handled via makeAssistantDataUI in KnowledgeHubShell.
							return null;
						}}
					</MessagePrimitive.Parts>
					<StreamingCaret />
					<MessageError />
				</div>

				<div className="aui-assistant-message-footer mt-1 ml-2 flex">
					<AssistantActionBar />
				</div>
			</MessagePrimitive.Root>
		</CitationSourcesProvider>
	);
};

const AssistantActionBar: FC = () => (
	<ActionBarPrimitive.Root
		hideWhenRunning
		autohide="not-last"
		autohideFloat="single-branch"
		className="aui-assistant-action-bar-root col-start-3 row-start-2 -ml-1 flex gap-1 text-muted-foreground data-floating:absolute data-floating:rounded-md data-floating:border data-floating:bg-background data-floating:p-1 data-floating:shadow-sm"
	>
		<ActionBarPrimitive.Copy asChild>
			<TooltipIconButton tooltip="Copy">
				<AuiIf condition={(s) => s.message.isCopied}>
					<CheckIcon />
				</AuiIf>
				<AuiIf condition={(s) => !s.message.isCopied}>
					<CopyIcon />
				</AuiIf>
			</TooltipIconButton>
		</ActionBarPrimitive.Copy>
		<ActionBarMorePrimitive.Root>
			<ActionBarMorePrimitive.Trigger asChild>
				<TooltipIconButton
					tooltip="More"
					className="data-[state=open]:bg-accent"
				>
					<MoreHorizontalIcon />
				</TooltipIconButton>
			</ActionBarMorePrimitive.Trigger>
			<ActionBarMorePrimitive.Content
				side="bottom"
				align="start"
				className="aui-action-bar-more-content z-50 min-w-32 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
			>
				<ActionBarPrimitive.ExportMarkdown asChild>
					<ActionBarMorePrimitive.Item className="aui-action-bar-more-item flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground">
						<DownloadIcon className="size-4" />
						Export as Markdown
					</ActionBarMorePrimitive.Item>
				</ActionBarPrimitive.ExportMarkdown>
			</ActionBarMorePrimitive.Content>
		</ActionBarMorePrimitive.Root>
	</ActionBarPrimitive.Root>
);

const UserMessage: FC = () => (
	<MessagePrimitive.Root
		className="aui-user-message-root fade-in slide-in-from-bottom-1 mx-auto grid w-full max-w-(--thread-max-width) animate-in auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 py-3 duration-150 [&:where(>*)]:col-start-2"
		data-role="user"
	>
		<UserMessageAttachments />

		<div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
			<div className="aui-user-message-content wrap-break-word peer rounded-2xl bg-muted px-4 py-2.5 text-foreground empty:hidden">
				<MessagePrimitive.Parts />
			</div>
			<div className="aui-user-action-bar-wrapper absolute top-1/2 left-0 -translate-x-full -translate-y-1/2 pr-2 peer-empty:hidden">
				<UserActionBar />
			</div>
		</div>
	</MessagePrimitive.Root>
);

const UserActionBar: FC = () => (
	<ActionBarPrimitive.Root
		hideWhenRunning
		autohide="not-last"
		className="aui-user-action-bar-root flex flex-col items-end"
	>
		<ActionBarPrimitive.Edit asChild>
			<TooltipIconButton tooltip="Edit" className="aui-user-action-edit p-4">
				<PencilIcon />
			</TooltipIconButton>
		</ActionBarPrimitive.Edit>
	</ActionBarPrimitive.Root>
);

const EditComposer: FC = () => (
	<MessagePrimitive.Root className="aui-edit-composer-wrapper mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2 py-3">
		<ComposerPrimitive.Root className="aui-edit-composer-root ml-auto flex w-full max-w-[85%] flex-col rounded-2xl bg-muted">
			<ComposerPrimitive.Input
				className="aui-edit-composer-input min-h-14 w-full resize-none bg-transparent p-4 text-foreground text-sm outline-none"
				autoFocus
			/>
			<div className="aui-edit-composer-footer mx-3 mb-3 flex items-center gap-2 self-end">
				<ComposerPrimitive.Cancel asChild>
					<Button variant="ghost" size="sm">
						Cancel
					</Button>
				</ComposerPrimitive.Cancel>
				<ComposerPrimitive.Send asChild>
					<Button size="sm">Update</Button>
				</ComposerPrimitive.Send>
			</div>
		</ComposerPrimitive.Root>
	</MessagePrimitive.Root>
);
