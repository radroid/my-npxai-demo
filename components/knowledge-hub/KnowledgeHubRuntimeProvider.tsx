"use client";

// Hoisted above AppShell so the ThreadSidebar (which lives in the app-level
// shell sidebar, not inside the Knowledge Hub page) has access to the
// assistant-ui runtime context.
//
// Tree shape:
//   <AuthProvider>                         ← single source of truth for mode
//     <SessionExpiredBanner />             ← surfaces stale-cookie failures
//     <RuntimeInner>                       ← builds chat + thread-list runtime
//       <AssistantRuntimeProvider>{...}    ← children (AppShell, page)
//
// AuthProvider is above RuntimeInner so the adapters (which call useAuth)
// always render inside its context. The custom fetch passed to
// AssistantChatTransport reads auth state via a module-level snapshot so
// it doesn't need to be re-memoized when mode flips.

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
import { X } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { useKnowledgeHubHistoryAdapter } from "@/lib/assistant-ui/history-adapter";
import { useKnowledgeHubThreadListAdapter } from "@/lib/assistant-ui/thread-list-adapter";
import {
	type AuthMode,
	AuthProvider,
	getAuthSnapshot,
	useAuth,
} from "@/lib/auth-context";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

// Module-level fetch wrapper. Runs outside React's render, reads auth via
// getAuthSnapshot() rather than a closure so sign-in/sign-out don't require
// rebuilding the transport.
//
// Flow when the server rejects a request as anon:
//   1. Clone the 4xx response and sniff `tier` from the JSON body.
//   2. If the client currently believes it's signed_in and the server said
//      anon, that's a stale-cookie mismatch — try supabase.auth.refreshSession()
//      once. If it succeeds, retry the original request with the fresh cookie.
//   3. If refresh can't rescue it, call markSessionExpired(): flips client
//      mode to anon and surfaces the "session expired" banner. The original
//      429 body still returns to the caller so assistant-ui can render its
//      error state — the banner is an out-of-band hint, not a replacement.
async function chatFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const res = await fetch(input, { ...init, credentials: "include" });
	if (res.status !== 429 && res.status !== 403) return res;

	let body: { tier?: string } = {};
	try {
		body = (await res.clone().json()) as { tier?: string };
	} catch {
		return res;
	}

	const snapshot = getAuthSnapshot();
	if (body.tier !== "anon" || snapshot?.mode !== "signed_in") return res;

	// Tier mismatch — attempt a transparent refresh.
	try {
		const supabase = getSupabaseBrowserClient();
		const {
			data: { session },
		} = await supabase.auth.refreshSession();
		if (session) {
			return await fetch(input, { ...init, credentials: "include" });
		}
	} catch {
		// Fall through to the visible failure path.
	}

	snapshot.markSessionExpired();
	return res;
}

function useKnowledgeHubThreadRuntime() {
	const id = useAuiState((s) => s.threadListItem.id);
	const historyAdapter = useKnowledgeHubHistoryAdapter();
	const transport = useMemo(
		() =>
			new AssistantChatTransport({
				api: "/api/knowledge-hub/query",
				fetch: chatFetch,
			}),
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

function RuntimeInner({ children }: { children: ReactNode }) {
	const threadListAdapter = useKnowledgeHubThreadListAdapter();
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

function SessionExpiredBanner() {
	const { sessionExpired, dismissSessionExpired } = useAuth();
	if (!sessionExpired) return null;
	return (
		<div
			role="status"
			aria-live="polite"
			className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 max-w-[min(28rem,calc(100vw-2rem))] rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning shadow-md backdrop-blur-sm"
		>
			<div className="flex items-start gap-2">
				<span className="flex-1">
					Your session expired. Sign in again to keep your higher daily limits.
				</span>
				<button
					type="button"
					onClick={dismissSessionExpired}
					aria-label="Dismiss"
					className="-mr-1 -mt-1 rounded p-1 text-warning/80 hover:text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning"
				>
					<X className="h-4 w-4" aria-hidden="true" />
				</button>
			</div>
		</div>
	);
}

export function KnowledgeHubRuntimeProvider({
	children,
	initialMode,
}: {
	children: ReactNode;
	initialMode: AuthMode;
}) {
	return (
		<AuthProvider initialMode={initialMode}>
			<SessionExpiredBanner />
			<RuntimeInner>{children}</RuntimeInner>
		</AuthProvider>
	);
}
