"use client";

import type { UIMessage } from "@ai-sdk/react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
	AssistantChatTransport,
	useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { useEffect } from "react";
import { Thread } from "@/components/assistant-ui/thread";
import { SourcesDataUI } from "@/components/knowledge-hub/SourcesDataUI";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { useThreadStore } from "@/lib/thread-store";

export function KnowledgeHubShell() {
	const activeId = useThreadStore((s) => s.activeThreadId);
	const runtimeKey = useThreadStore((s) => s.runtimeKey);
	const messagesByThread = useThreadStore((s) => s.messagesByThread);
	const syncMessages = useThreadStore((s) => s.syncMessages);
	const createThread = useThreadStore((s) => s.createThread);
	const setMode = useThreadStore((s) => s.setMode);
	const loadMessages = useThreadStore((s) => s.loadMessages);
	const autoTitle = useThreadStore((s) => s.autoTitle);

	// Detect session → tell the store which mode to run in. This triggers the
	// one-shot thread-list fetch for signed-in users.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const supabase = getSupabaseBrowserClient();
				const {
					data: { session },
				} = await supabase.auth.getSession();
				if (cancelled) return;
				await setMode(session?.user ? "signed_in" : "anon");
			} catch {
				if (!cancelled) await setMode("anon");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [setMode]);

	// Lazy-load messages for the active thread (signed-in only — anon already
	// has them in-memory via persist middleware).
	useEffect(() => {
		if (activeId) void loadMessages(activeId);
	}, [activeId, loadMessages]);

	// The runtime's message tree is seeded from the store on mount. `runtimeKey`
	// (not `activeId`) drives remount so the onFinish null→tid transition keeps
	// the live runtime intact — see the rationale on `runtimeKey` in the store.
	const seededMessages = activeId ? (messagesByThread[activeId] ?? []) : [];

	return (
		<AssistantRuntimeProvider
			key={runtimeKey}
			runtime={useThreadRuntime(
				runtimeKey,
				seededMessages,
				async (messages) => {
					// AI SDK's onFinish fires with the full authoritative `messages`
					// list (user turns included). If this is the first turn on a fresh
					// composer, create the thread *with* the messages so the single
					// `set` seeds `messagesByThread` before React remounts on the key
					// change — otherwise the remount sees an empty prop and blanks out.
					const tid = activeId;
					let targetId = tid;
					if (!targetId) {
						targetId = await createThread(undefined, messages);
					} else {
						await syncMessages(targetId, messages);
					}
					void autoTitle(targetId, messages);
				},
			)}
		>
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
		</AssistantRuntimeProvider>
	);
}

// Extracted so the runtime is recreated only when the bound id or seeds change
// (memoization is handled inside useChatRuntime — remount is via the parent `key`).
function useThreadRuntime(
	id: string,
	messages: UIMessage[],
	onFinish: (messages: UIMessage[]) => void | Promise<void>,
) {
	return useChatRuntime({
		id,
		messages,
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
		transport: new AssistantChatTransport({
			api: "/api/knowledge-hub/query",
		}),
		onFinish: ({ messages: all }) => {
			void onFinish(all);
		},
	});
}
