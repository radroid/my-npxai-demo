"use client";

import type { UIMessage } from "@ai-sdk/react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
	AssistantChatTransport,
	useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { Thread } from "@/components/assistant-ui/thread";
import { SourcesDataUI } from "@/components/knowledge-hub/SourcesDataUI";
import { ThreadSidebar } from "@/components/knowledge-hub/ThreadSidebar";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { useThreadStore } from "@/lib/thread-store";

const SIDEBAR_STATE_KEY = "npxai-kh-threads-collapsed";

export function KnowledgeHubShell() {
	const activeId = useThreadStore((s) => s.activeThreadId);
	const messagesByThread = useThreadStore((s) => s.messagesByThread);
	const syncMessages = useThreadStore((s) => s.syncMessages);
	const createThread = useThreadStore((s) => s.createThread);
	const setActiveThread = useThreadStore((s) => s.setActiveThread);
	const setMode = useThreadStore((s) => s.setMode);
	const loadMessages = useThreadStore((s) => s.loadMessages);
	const autoTitle = useThreadStore((s) => s.autoTitle);
	const loaded = useThreadStore((s) => s.loaded);

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

	// Unique runtime id per thread. When it changes, `useChatRuntime` remounts
	// and seeds from the new `messages` array. "__new__" is the placeholder for
	// a fresh composer with no thread yet.
	const runtimeId = activeId ?? "__new__";
	const seededMessages = activeId ? (messagesByThread[activeId] ?? []) : [];

	return (
		<AssistantRuntimeProvider
			// `key` forces a full React remount so useChatRuntime re-reads the
			// new `messages` prop cleanly on thread switch.
			key={runtimeId}
			runtime={useThreadRuntime(runtimeId, seededMessages, async (messages) => {
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
			})}
		>
			<SourcesDataUI />
			<ShellBody loaded={loaded} setActive={setActiveThread} />
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

function ShellBody({
	loaded,
	setActive: _setActive,
}: {
	loaded: boolean;
	setActive: (id: string | null) => void;
}) {
	const [collapsed, setCollapsed] = useState(false);
	useEffect(() => {
		try {
			const stored = window.localStorage.getItem(SIDEBAR_STATE_KEY);
			setCollapsed(stored === "1");
		} catch {}
	}, []);
	const toggle = () => {
		setCollapsed((v) => {
			const next = !v;
			try {
				window.localStorage.setItem(SIDEBAR_STATE_KEY, next ? "1" : "0");
			} catch {}
			return next;
		});
	};

	return (
		<div className="flex h-full w-full gap-2">
			{!collapsed ? (
				<aside
					aria-label="Thread history"
					className="hidden w-64 shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] lg:flex"
				>
					<div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-3">
						<div>
							<p className="text-sm font-semibold text-[var(--text)]">
								Knowledge Hub
							</p>
							<p className="text-xs text-[var(--text-muted)]">
								CNSC REGDOC Q&amp;A
							</p>
						</div>
						<button
							type="button"
							aria-label="Collapse thread history"
							onClick={toggle}
							className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
						>
							<PanelLeftClose className="h-4 w-4" aria-hidden="true" />
						</button>
					</div>
					<div className="flex-1 overflow-y-auto px-2 py-2">
						{loaded ? (
							<ThreadSidebar />
						) : (
							<p className="px-2 py-2 text-xs text-[var(--text-muted)]">
								Loading threads…
							</p>
						)}
					</div>
				</aside>
			) : null}
			<section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)]">
				<div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3">
					{collapsed ? (
						<button
							type="button"
							aria-label="Expand thread history"
							onClick={toggle}
							className="hidden h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)] lg:inline-flex"
						>
							<PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
						</button>
					) : null}
					<span className="text-xs text-[var(--text-muted)]">
						Ask a regulatory question — answers cite CNSC REGDOCs.
					</span>
				</div>
				<div className="min-h-0 flex-1 overflow-hidden">
					<Thread />
				</div>
			</section>
		</div>
	);
}
