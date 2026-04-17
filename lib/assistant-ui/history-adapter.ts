"use client";

// ThreadHistoryAdapter for the Knowledge Hub — wires useExternalHistory
// (inside useAISDKRuntime) to our per-thread message storage. Same hybrid
// pattern as the thread-list adapter: signed-in hits /api/threads/[id] +
// /api/threads/[id]/messages, anon reads/writes localStorage. The runtime
// invokes load() on thread switch (debounced) and append() after each run
// settles, which replaces the onFinish→syncMessages path in the old flow.
//
// We implement the `withFormat` path rather than the base load/append since
// useExternalHistory always wraps the adapter via
// `historyAdapter.withFormat(aiSDKV6FormatAdapter).load()`. Base load/append
// are left as throwing stubs so misuse is loud rather than silently broken.

import type { UIMessage } from "@ai-sdk/react";
import type {
	GenericThreadHistoryAdapter,
	MessageFormatAdapter,
	MessageFormatRepository,
	ThreadHistoryAdapter,
} from "@assistant-ui/react";
import { useAui } from "@assistant-ui/react";
import { useMemo } from "react";
import { useThreadStore } from "@/lib/thread-store";

const ANON_MESSAGES_PREFIX = "npxai-kh-anon-msgs:";

interface StoredAnonMessage<TStorageFormat extends Record<string, unknown>> {
	id: string;
	parent_id: string | null;
	format: string;
	content: TStorageFormat;
}

function anonKey(threadId: string): string {
	return `${ANON_MESSAGES_PREFIX}${threadId}`;
}

function readAnonMessages<TStorageFormat extends Record<string, unknown>>(
	threadId: string,
): Array<StoredAnonMessage<TStorageFormat>> {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(anonKey(threadId));
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed)
			? (parsed as Array<StoredAnonMessage<TStorageFormat>>)
			: [];
	} catch {
		return [];
	}
}

function writeAnonMessages<TStorageFormat extends Record<string, unknown>>(
	threadId: string,
	rows: Array<StoredAnonMessage<TStorageFormat>>,
): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(anonKey(threadId), JSON.stringify(rows));
	} catch {
		// Quota exceeded — silent; the live runtime still has the messages in
		// memory so the current session is fine, just no cross-refresh replay.
	}
}

// Shape the /api/threads/[id] GET handler returns. Content is stored as JSONB
// (the full UIMessage), so decoding is just pulling `content` out.
interface ServerMessage {
	message_id: string;
	role: string;
	content: UIMessage;
	created_at: string;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		headers: { "Content-Type": "application/json" },
		...init,
	});
	if (!res.ok) throw new Error(`http_${res.status}`);
	return (await res.json()) as T;
}

export function useKnowledgeHubHistoryAdapter(): ThreadHistoryAdapter {
	const aui = useAui();
	const mode = useThreadStore((s) => s.mode);
	const effectiveMode = mode === "signed_in" ? "signed_in" : "anon";

	return useMemo<ThreadHistoryAdapter>(() => {
		// `currentRemoteId` is resolved at call time rather than bound up-front.
		// useExternalHistory calls load() after the thread has switched and
		// append() after awaiting `threadListItem().initialize()`, so the value
		// is stable by the time we read it.
		const getRemoteId = (): string | undefined => {
			if (aui.threadListItem.source === null) return undefined;
			return aui.threadListItem().getState().remoteId ?? undefined;
		};

		return {
			// Base load/append are unused — useExternalHistory always goes
			// through withFormat. Throw loudly if anyone reaches here.
			load: async () => {
				throw new Error(
					"ThreadHistoryAdapter.load called directly — expected withFormat path",
				);
			},
			append: async () => {
				throw new Error(
					"ThreadHistoryAdapter.append called directly — expected withFormat path",
				);
			},
			withFormat: <TMessage, TStorageFormat extends Record<string, unknown>>(
				formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>,
			): GenericThreadHistoryAdapter<TMessage> => {
				const loadSigned = async (
					threadId: string,
				): Promise<MessageFormatRepository<TMessage>> => {
					const { messages } = await apiJson<{
						messages: Array<ServerMessage>;
					}>(`/api/threads/${threadId}`);
					// Server stores raw UIMessage in `content`. The format adapter's
					// `decode` wraps the stored payload in the `{parentId, message}`
					// shape the runtime expects — we just have to rebuild the
					// MessageStorageEntry shape it decodes from.
					return {
						messages: messages.map((m) => {
							const stored = {
								id: m.message_id,
								parent_id: null,
								format: formatAdapter.format,
								// `content` on the server is the full UIMessage jsonb;
								// the AI SDK format adapter's decode spreads it onto the
								// message, and id comes from the stored.id separately.
								content: m.content as unknown as TStorageFormat,
							};
							return formatAdapter.decode(stored);
						}),
					};
				};

				const loadAnon = async (
					threadId: string,
				): Promise<MessageFormatRepository<TMessage>> => {
					const rows = readAnonMessages<TStorageFormat>(threadId);
					return {
						messages: rows.map((r) =>
							formatAdapter.decode({
								id: r.id,
								parent_id: r.parent_id,
								format: r.format,
								content: r.content,
							}),
						),
					};
				};

				const appendSigned = async (
					threadId: string,
					item: { parentId: string | null; message: TMessage },
				): Promise<void> => {
					// The server handler takes `{role, content}` where content is the
					// full stored payload. Encode via the format adapter so the
					// stored shape matches what load()/decode() expects back.
					const encoded = formatAdapter.encode(item);
					const role =
						(item.message as unknown as { role?: string }).role ?? "user";
					await apiJson(`/api/threads/${threadId}/messages`, {
						method: "POST",
						body: JSON.stringify({ role, content: encoded }),
					});
				};

				const appendAnon = async (
					threadId: string,
					item: { parentId: string | null; message: TMessage },
				): Promise<void> => {
					const existing = readAnonMessages<TStorageFormat>(threadId);
					const id = formatAdapter.getId(item.message);
					const encoded = formatAdapter.encode(item);
					// Replace-by-id: streaming-in-progress messages can append
					// multiple times for the same id (partial → complete).
					const next = existing.filter((r) => r.id !== id);
					next.push({
						id,
						parent_id: item.parentId,
						format: formatAdapter.format,
						content: encoded,
					});
					writeAnonMessages(threadId, next);
				};

				return {
					load: async () => {
						const remoteId = getRemoteId();
						if (!remoteId) return { messages: [] };
						if (effectiveMode === "signed_in") return loadSigned(remoteId);
						return loadAnon(remoteId);
					},
					append: async (item) => {
						if (aui.threadListItem.source === null) return;
						const { remoteId } = await aui.threadListItem().initialize();
						if (effectiveMode === "signed_in")
							return appendSigned(remoteId, item);
						return appendAnon(remoteId, item);
					},
				};
			},
		};
	}, [aui, effectiveMode]);
}
