"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
	AssistantChatTransport,
	useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { Thread } from "@/components/assistant-ui/thread";
import { ThreadList } from "@/components/assistant-ui/thread-list";
import { SourcesDataUI } from "@/components/knowledge-hub/SourcesDataUI";
import {
	Sidebar,
	SidebarContent,
	SidebarHeader,
	SidebarInset,
	SidebarProvider,
	SidebarRail,
	SidebarTrigger,
} from "@/components/ui/sidebar";

// Knowledge Hub client shell. Wires the assistant-ui Thread + ThreadList
// against our own route handler (`/api/knowledge-hub/query`) instead of the
// starter template's Assistant Cloud + `/api/chat`. Thread persistence is
// in-memory for now — Phase 3 swaps in the localStorage zustand store
// (`lib/thread-store.ts`) per the 2026-04-16 decision to keep threads
// client-side only.

export function KnowledgeHubShell() {
	const runtime = useChatRuntime({
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
		transport: new AssistantChatTransport({
			api: "/api/knowledge-hub/query",
		}),
	});

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<SourcesDataUI />
			<SidebarProvider>
				<div className="flex h-[calc(100dvh-3.5rem)] w-full">
					<Sidebar
						role="complementary"
						aria-label="Thread history"
						className="!top-14 !h-[calc(100svh-3.5rem)] border-r border-[--border]"
					>
						<SidebarHeader className="border-b border-[--border] bg-[--surface] px-3 py-3">
							<p className="text-sm font-semibold text-[--text]">
								Knowledge Hub
							</p>
							<p className="text-xs text-[--text-muted]">CNSC REGDOC Q&amp;A</p>
						</SidebarHeader>
						<SidebarContent className="bg-[--surface] px-2 py-2">
							<ThreadList />
						</SidebarContent>
						<SidebarRail />
					</Sidebar>
					<SidebarInset className="bg-[--bg]">
						<div className="flex h-10 shrink-0 items-center gap-2 border-b border-[--border] px-3">
							<SidebarTrigger />
							<span className="text-xs text-[--text-muted]">
								Ask a regulatory question — answers cite CNSC REGDOCs.
							</span>
						</div>
						<div className="flex-1 overflow-hidden">
							<Thread />
						</div>
					</SidebarInset>
				</div>
			</SidebarProvider>
		</AssistantRuntimeProvider>
	);
}
