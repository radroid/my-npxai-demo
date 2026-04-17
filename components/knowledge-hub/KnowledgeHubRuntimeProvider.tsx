"use client";

// Hoisted above AppShell so the ThreadSidebar (which lives in the app-level
// shell sidebar, not inside the Knowledge Hub page) has access to the
// assistant-ui runtime context. Previously the provider lived inside
// KnowledgeHubShell at the page body level, so the sidebar — rendered higher
// in the tree by AppShell — would throw "requires an AuiProvider" the moment
// it tried to read threadListItem state.
//
// The cost of mounting this on every page in the (app) group is one session
// probe and (for signed-in users) one /api/threads list fetch on mount. Both
// are cheap; the alternative of reshuffling the layout so the sidebar lives
// inside the page was a much bigger surgery for no real benefit.

import { useChat } from "@ai-sdk/react";
import {
	AssistantRuntimeProvider,
	useAuiState,
	useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import {
	AssistantChatTransport,
	useAISDKRuntime,
} from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { type ReactNode, useEffect, useMemo } from "react";
import { useKnowledgeHubHistoryAdapter } from "@/lib/assistant-ui/history-adapter";
import { useKnowledgeHubThreadListAdapter } from "@/lib/assistant-ui/thread-list-adapter";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { useThreadStore } from "@/lib/thread-store";

function useKnowledgeHubThreadRuntime() {
	const id = useAuiState((s) => s.threadListItem.id);
	const historyAdapter = useKnowledgeHubHistoryAdapter();
	const transport = useMemo(
		() => new AssistantChatTransport({ api: "/api/knowledge-hub/query" }),
		[],
	);
	const chat = useChat({
		id,
		transport,
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
	});
	return useAISDKRuntime(chat, {
		adapters: { history: historyAdapter },
	});
}

export function KnowledgeHubRuntimeProvider({
	children,
}: {
	children: ReactNode;
}) {
	const setMode = useThreadStore((s) => s.setMode);
	const threadListAdapter = useKnowledgeHubThreadListAdapter();

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

	const runtime = useRemoteThreadListRuntime({
		runtimeHook: useKnowledgeHubThreadRuntime,
		adapter: threadListAdapter,
		allowNesting: true,
	});

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			{children}
		</AssistantRuntimeProvider>
	);
}
