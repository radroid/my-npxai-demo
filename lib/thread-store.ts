"use client";

// Hybrid Knowledge Hub thread store.
// Anon users keep threads + messages in localStorage (no server footprint).
// Signed-in users mirror into Supabase via the /api/threads/* handlers
// backed by the chat_threads + chat_messages migration (2026-04-17).
// The store tracks the sidebar metadata (thread list) and a per-thread
// message cache; the active thread's messages are fed into useChatRuntime
// as its `messages` prop, and a changing `id` forces the runtime to remount
// when the user switches threads.

import type { UIMessage } from "@ai-sdk/react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ThreadSummary {
	id: string;
	title: string;
	updatedAt: number;
}

interface ThreadStoreState {
	mode: "anon" | "signed_in" | "unknown";
	threads: ThreadSummary[];
	messagesByThread: Record<string, UIMessage[]>;
	activeThreadId: string | null;
	loaded: boolean;

	setMode: (mode: "anon" | "signed_in") => Promise<void>;
	setActiveThread: (id: string | null) => void;
	createThread: (title?: string, initialMessages?: UIMessage[]) => Promise<string>;
	// Sync the full message list for a thread. Called from onFinish with the
	// AI-SDK's authoritative `messages` array. Local state is replaced; the
	// server receives only the tail of new messages (typically the user+assistant
	// pair that just completed), matching the append-only RPC shape.
	syncMessages: (threadId: string, messages: UIMessage[]) => Promise<void>;
	renameThread: (id: string, title: string) => Promise<void>;
	deleteThread: (id: string) => Promise<void>;
	loadMessages: (id: string) => Promise<void>;
}

function newId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

// Server helpers — no-op for anon; the store enforces mode before calling.
async function api<T>(
	path: string,
	init?: RequestInit,
): Promise<T | { error: string }> {
	try {
		const res = await fetch(path, {
			headers: { "Content-Type": "application/json" },
			...init,
		});
		if (!res.ok) return { error: `http_${res.status}` };
		return (await res.json()) as T;
	} catch (e) {
		console.warn("[kh-thread-store] fetch failed", path, e);
		return { error: "fetch_failed" };
	}
}

export const useThreadStore = create<ThreadStoreState>()(
	persist(
		(set, get) => ({
			mode: "unknown",
			threads: [],
			messagesByThread: {},
			activeThreadId: null,
			loaded: false,

			setMode: async (mode) => {
				set({ mode, loaded: false });
				if (mode === "anon") {
					// Rehydrate from localStorage — the persist middleware handles
					// `threads` + `messagesByThread` automatically. Mark as loaded.
					set({ loaded: true });
					return;
				}
				// Signed-in: pull the authoritative thread list from the server
				// and clear any stale anon state. Messages load lazily per-thread.
				const res = await api<{ threads: ServerThread[] }>("/api/threads");
				if ("error" in res) {
					set({ threads: [], messagesByThread: {}, loaded: true });
					return;
				}
				set({
					threads: res.threads.map(toSummary),
					messagesByThread: {},
					loaded: true,
				});
			},

			setActiveThread: (id) => set({ activeThreadId: id }),

			createThread: async (title = "New thread", initialMessages = []) => {
				const state = get();
				if (state.mode === "signed_in") {
					const res = await api<{ id: string; created_at: string }>(
						"/api/threads",
						{ method: "POST", body: JSON.stringify({ title }) },
					);
					if ("error" in res) throw new Error(res.error);
					const t: ThreadSummary = {
						id: res.id,
						title,
						updatedAt: Date.parse(res.created_at),
					};
					// Seed activeThreadId + messagesByThread in one set. A second set
					// would let React remount AssistantRuntimeProvider on the key
					// change before messages arrive — thread blanks, next send throws
					// a duplicate-id when the prop finally lands.
					set((s) => ({
						threads: [t, ...s.threads],
						messagesByThread: {
							...s.messagesByThread,
							[t.id]: initialMessages,
						},
						activeThreadId: t.id,
					}));
					for (const m of initialMessages) {
						void api(`/api/threads/${t.id}/messages`, {
							method: "POST",
							body: JSON.stringify({ role: m.role, content: m }),
						});
					}
					return t.id;
				}
				// Anon path — local id, local persist middleware handles storage.
				const id = newId();
				const t: ThreadSummary = { id, title, updatedAt: Date.now() };
				set((s) => ({
					threads: [t, ...s.threads],
					messagesByThread: { ...s.messagesByThread, [id]: initialMessages },
					activeThreadId: id,
				}));
				return id;
			},

			syncMessages: async (threadId, messages) => {
				const prevCount = get().messagesByThread[threadId]?.length ?? 0;
				// Local replace is authoritative — whatever the AI SDK runtime has
				// is the truth; our cache just mirrors it for sidebar + replay.
				set((s) => ({
					messagesByThread: { ...s.messagesByThread, [threadId]: messages },
					threads: s.threads.map((t) =>
						t.id === threadId ? { ...t, updatedAt: Date.now() } : t,
					),
				}));
				// Server writes are append-only per the save_message RPC. POST only
				// the tail — whatever is new since the previous sync. onFinish
				// typically fires with exactly 2 new messages (user + assistant).
				if (get().mode === "signed_in" && messages.length > prevCount) {
					const newOnes = messages.slice(prevCount);
					for (const m of newOnes) {
						void api(`/api/threads/${threadId}/messages`, {
							method: "POST",
							body: JSON.stringify({ role: m.role, content: m }),
						});
					}
				}
			},

			renameThread: async (id, title) => {
				set((s) => ({
					threads: s.threads.map((t) =>
						t.id === id ? { ...t, title, updatedAt: Date.now() } : t,
					),
				}));
				if (get().mode === "signed_in") {
					void api(`/api/threads/${id}`, {
						method: "PATCH",
						body: JSON.stringify({ title }),
					});
				}
			},

			deleteThread: async (id) => {
				set((s) => {
					const { [id]: _, ...rest } = s.messagesByThread;
					return {
						threads: s.threads.filter((t) => t.id !== id),
						messagesByThread: rest,
						activeThreadId: s.activeThreadId === id ? null : s.activeThreadId,
					};
				});
				if (get().mode === "signed_in") {
					void api(`/api/threads/${id}`, { method: "DELETE" });
				}
			},

			loadMessages: async (id) => {
				const state = get();
				// Anon messages are already in memory (persist middleware).
				if (state.mode !== "signed_in") return;
				// Skip refetch if we already have messages for this thread in cache.
				if ((state.messagesByThread[id]?.length ?? 0) > 0) return;
				const res = await api<{ messages: Array<ServerMessage> }>(
					`/api/threads/${id}`,
				);
				if ("error" in res) return;
				const msgs = res.messages.map(fromServerMessage);
				set((s) => ({
					messagesByThread: { ...s.messagesByThread, [id]: msgs },
				}));
			},
		}),
		{
			name: "npxai-demo-threads",
			version: 2,
			// Only anon mode persists to localStorage. Signed-in state is server-
			// authoritative; persisting it would leak one user's threads to another
			// on the same browser.
			partialize: (s) =>
				s.mode === "signed_in"
					? { activeThreadId: s.activeThreadId }
					: {
							threads: s.threads,
							messagesByThread: s.messagesByThread,
							activeThreadId: s.activeThreadId,
						},
		},
	),
);

// Server-side row shapes (what the /api/threads/* handlers return).
interface ServerThread {
	id: string;
	title: string;
	created_at: string;
	updated_at: string;
}
interface ServerMessage {
	message_id: string;
	role: string;
	content: UIMessage;
	created_at: string;
}

function toSummary(t: ServerThread): ThreadSummary {
	return { id: t.id, title: t.title, updatedAt: Date.parse(t.updated_at) };
}
function fromServerMessage(m: ServerMessage): UIMessage {
	// Content was stored as the full UIMessage jsonb — return it as-is.
	return m.content;
}
