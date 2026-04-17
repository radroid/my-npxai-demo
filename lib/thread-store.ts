"use client";

// localStorage-only thread store for the Knowledge Hub.
// Per the 2026-04-16 decision, there is NO server-side threads table —
// both anon and signed-in threads live client-side. See Appendix J.12.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ThreadMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	createdAt: number;
	citations?: Array<{
		regdoc_id: string;
		section_number: string | null;
		url: string | null;
	}>;
}

export interface Thread {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messages: ThreadMessage[];
}

interface ThreadStore {
	threads: Thread[];
	activeThreadId: string | null;
	createThread: (title?: string) => string;
	setActiveThread: (id: string | null) => void;
	appendMessage: (
		threadId: string,
		message: Omit<ThreadMessage, "id" | "createdAt">,
	) => void;
	renameThread: (id: string, title: string) => void;
	deleteThread: (id: string) => void;
}

function newId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export const useThreadStore = create<ThreadStore>()(
	persist(
		(set) => ({
			threads: [],
			activeThreadId: null,
			createThread: (title = "New thread") => {
				const id = newId();
				const now = Date.now();
				set((state) => ({
					threads: [
						{ id, title, createdAt: now, updatedAt: now, messages: [] },
						...state.threads,
					],
					activeThreadId: id,
				}));
				return id;
			},
			setActiveThread: (id) => set({ activeThreadId: id }),
			appendMessage: (threadId, message) =>
				set((state) => ({
					threads: state.threads.map((t) =>
						t.id === threadId
							? {
									...t,
									updatedAt: Date.now(),
									messages: [
										...t.messages,
										{ ...message, id: newId(), createdAt: Date.now() },
									],
								}
							: t,
					),
				})),
			renameThread: (id, title) =>
				set((state) => ({
					threads: state.threads.map((t) =>
						t.id === id ? { ...t, title, updatedAt: Date.now() } : t,
					),
				})),
			deleteThread: (id) =>
				set((state) => ({
					threads: state.threads.filter((t) => t.id !== id),
					activeThreadId:
						state.activeThreadId === id ? null : state.activeThreadId,
				})),
		}),
		{
			name: "npxai-demo-threads",
			version: 1,
		},
	),
);
