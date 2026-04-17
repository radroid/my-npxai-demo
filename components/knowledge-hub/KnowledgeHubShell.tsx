"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
	AssistantChatTransport,
	useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { Thread } from "@/components/assistant-ui/thread";
import { ThreadList } from "@/components/assistant-ui/thread-list";
import { SourcesDataUI } from "@/components/knowledge-hub/SourcesDataUI";

const SIDEBAR_STATE_KEY = "npxai-kh-threads-collapsed";

export function KnowledgeHubShell() {
	const runtime = useChatRuntime({
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
		transport: new AssistantChatTransport({
			api: "/api/knowledge-hub/query",
		}),
	});
	const [collapsed, setCollapsed] = useState(false);
	const [hydrated, setHydrated] = useState(false);

	useEffect(() => {
		try {
			const stored = window.localStorage.getItem(SIDEBAR_STATE_KEY);
			if (stored === "1") setCollapsed(true);
		} catch {}
		setHydrated(true);
	}, []);
	useEffect(() => {
		if (!hydrated) return;
		try {
			window.localStorage.setItem(SIDEBAR_STATE_KEY, collapsed ? "1" : "0");
		} catch {}
	}, [collapsed, hydrated]);

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<SourcesDataUI />
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
								onClick={() => setCollapsed(true)}
								className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
							>
								<PanelLeftClose className="h-4 w-4" aria-hidden="true" />
							</button>
						</div>
						<div className="flex-1 overflow-y-auto px-2 py-2">
							<ThreadList />
						</div>
					</aside>
				) : null}
				<section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)]">
					<div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3">
						{collapsed ? (
							<button
								type="button"
								aria-label="Expand thread history"
								onClick={() => setCollapsed(false)}
								className="hidden h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)] lg:inline-flex"
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
		</AssistantRuntimeProvider>
	);
}
