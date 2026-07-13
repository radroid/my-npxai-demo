"use client";

// The assistant-ui runtime provider lives in (app)/layout.tsx now, so this
// component is just the Knowledge Hub page body — header, SourcesDataUI, the
// Thread, and a component that fires the post-first-turn autoTitle. Keeping
// the provider out of here avoids "requires an AuiProvider" errors in the
// ThreadSidebar (which is rendered by AppShell, above this component).

import { useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useRef, useState } from "react";
import { Thread } from "@/components/assistant-ui/thread";
import { ArtifactWorkbench } from "@/components/knowledge-hub/ArtifactWorkbench";
import {
	type HubMode,
	ModeToggle,
} from "@/components/knowledge-hub/ModeToggle";
import { SourcesDataUI } from "@/components/knowledge-hub/SourcesDataUI";

export function KnowledgeHubShell() {
	// Chat ↔ Artifact mode (item-1 slice 1.2). BOTH surfaces stay mounted;
	// the toggle flips CSS visibility only (`hidden`), never unmounts — this
	// preserves the chat composer draft, scroll position, and the last
	// generated artifact across toggles, and an in-flight artifact run keeps
	// streaming while hidden.
	const [mode, setMode] = useState<HubMode>("chat");
	const modeToggle = <ModeToggle mode={mode} onModeChange={setMode} />;

	return (
		<>
			<AutoTitle />
			<SourcesDataUI />
			<section className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-bg">
				<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
					<span className="text-xs text-fg-muted">
						{mode === "chat"
							? "Ask a regulatory question — answers cite CNSC REGDOCs."
							: "Generate a self-contained HTML explainer — diagrams, citations, downloadable."}
					</span>
				</div>
				<div
					className={
						mode === "chat" ? "min-h-0 flex-1 overflow-hidden" : "hidden"
					}
				>
					<Thread composerHeader={modeToggle} />
				</div>
				<div
					className={
						mode === "artifact" ? "min-h-0 flex-1 overflow-hidden" : "hidden"
					}
				>
					<ArtifactWorkbench modeToggle={modeToggle} />
				</div>
			</section>
		</>
	);
}

// Auto-title the thread once the first user+assistant pair lands. Watches
// the thread state inside the runtime (so it picks up tool-call runs,
// retries, etc. naturally) and fires the one-shot /api/threads/title call
// exactly once per thread, keyed on its id. Rename goes through the
// thread-list runtime so the adapter's rename path runs and the sidebar
// updates without any bespoke syncing.
function AutoTitle() {
	const aui = useAui();
	const isRunning = useAuiState((s) => s.thread.isRunning);
	const messages = useAuiState((s) => s.thread.messages);
	const threadItemId = useAuiState((s) => s.threadListItem.id);
	const threadItemTitle = useAuiState((s) => s.threadListItem.title);
	const firedRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		if (isRunning) return;
		if (!threadItemId) return;
		if (threadItemTitle && threadItemTitle !== "New thread") return;
		const hasUser = messages.some((m) => m.role === "user");
		const hasAssistant = messages.some((m) => m.role === "assistant");
		if (!hasUser || !hasAssistant) return;
		if (firedRef.current.has(threadItemId)) return;
		firedRef.current.add(threadItemId);
		void (async () => {
			try {
				const res = await fetch("/api/threads/title", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ messages }),
				});
				if (!res.ok) return;
				const { title } = (await res.json()) as { title?: string };
				if (!title?.trim()) return;
				if (aui.threadListItem.source === null) return;
				await aui.threadListItem().rename(title.trim());
			} catch {
				// Best-effort — the thread keeps its default title otherwise.
			}
		})();
	}, [aui, isRunning, messages, threadItemId, threadItemTitle]);

	return null;
}
