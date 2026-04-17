"use client";

// The assistant-ui runtime provider lives in (app)/layout.tsx now, so this
// component is just the Knowledge Hub page body — header, SourcesDataUI, the
// Thread, and a component that fires the post-first-turn autoTitle. Keeping
// the provider out of here avoids "requires an AuiProvider" errors in the
// ThreadSidebar (which is rendered by AppShell, above this component).

import { useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useRef } from "react";
import { Thread } from "@/components/assistant-ui/thread";
import { SourcesDataUI } from "@/components/knowledge-hub/SourcesDataUI";

export function KnowledgeHubShell() {
	return (
		<>
			<AutoTitle />
			<SourcesDataUI />
			<section className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-bg">
				<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
					<span className="text-xs text-fg-muted">
						Ask a regulatory question — answers cite CNSC REGDOCs.
					</span>
				</div>
				<div className="min-h-0 flex-1 overflow-hidden">
					<Thread />
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
