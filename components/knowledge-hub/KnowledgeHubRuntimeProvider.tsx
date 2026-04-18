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
	initialMode,
}: {
	children: ReactNode;
	initialMode: "anon" | "signed_in";
}) {
	// Bootstrap mode from the server-determined session value BEFORE the
	// adapter hooks read from the store. This runs during render — safe
	// because Zustand's setState is synchronous and we only write when the
	// current value disagrees, so no render loop. Without this seeding, the
	// client's first render builds the adapter with `mode: "unknown"` (falls
	// back to "anon"), and a stray initialize() before the client-side
	// session probe resolves can stamp a `__LOCALID_*` into remoteId — which
	// later blows up on loadSigned as GET /api/threads/__LOCALID_* → 400.
	if (useThreadStore.getState().mode !== initialMode) {
		useThreadStore.setState({ mode: initialMode });
	}

	const threadListAdapter = useKnowledgeHubThreadListAdapter();

	// Client-side session reconciliation — picks up sign-in/sign-out that
	// happens without a full page reload (Supabase auth UI redirect, etc.).
	// The server-seeded mode handles the normal first-paint case above; this
	// effect is just for mid-session tier transitions.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const supabase = getSupabaseBrowserClient();
				const {
					data: { session },
				} = await supabase.auth.getSession();
				if (cancelled) return;
				const next = session?.user ? "signed_in" : "anon";
				if (useThreadStore.getState().mode !== next) {
					await useThreadStore.getState().setMode(next);
				}
			} catch {
				// Server-seeded mode stands.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

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
