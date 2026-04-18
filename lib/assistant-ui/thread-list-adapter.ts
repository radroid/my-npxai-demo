"use client";

// Hybrid RemoteThreadListAdapter: drives the Knowledge Hub's thread list for
// both signed-in (Supabase via /api/threads/*) and anon (localStorage) users
// behind a single contract. Fed to `useRemoteThreadListRuntime` so the
// assistant-ui runtime owns thread identity + switching natively — replaces
// the runtimeKey-remount-on-switch dance in the prior Zustand-only flow.
//
// Mode-awareness lives inside each method so we keep one adapter identity
// across sign-in/sign-out and don't force the runtime to tear down. The auth
// mode is read from useThreadStore (the trimmed-down store still owns that).

import type {
	RemoteThreadInitializeResponse,
	RemoteThreadListResponse,
	RemoteThreadMetadata,
} from "@assistant-ui/core";
import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import { useMemo } from "react";
import { useThreadStore } from "@/lib/thread-store";

const ANON_THREADS_KEY = "npxai-kh-anon-threads";

// localStorage schema for anon threads. We only keep metadata here; messages
// live under a separate per-thread key managed by the history adapter.
interface AnonThreadRow {
	id: string;
	title: string;
	status: "regular" | "archived";
	createdAt: number;
	updatedAt: number;
}

function readAnonThreads(): AnonThreadRow[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(ANON_THREADS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? (parsed as AnonThreadRow[]) : [];
	} catch {
		return [];
	}
}

function writeAnonThreads(rows: AnonThreadRow[]): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(ANON_THREADS_KEY, JSON.stringify(rows));
	} catch {
		// Quota / privacy-mode — silent; runtime state is authoritative for UX.
	}
}

// Thin JSON wrapper. Returns parsed body on 2xx, throws on anything else so
// the runtime's adapter reducer can treat it as an optimistic-update revert.
async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		headers: { "Content-Type": "application/json" },
		...init,
	});
	if (!res.ok) throw new Error(`http_${res.status}`);
	return (await res.json()) as T;
}

interface ServerThread {
	id: string;
	title: string;
	created_at: string;
	updated_at: string;
}

function toMetadata(t: ServerThread): RemoteThreadMetadata {
	return { status: "regular", remoteId: t.id, title: t.title };
}

function anonToMetadata(t: AnonThreadRow): RemoteThreadMetadata {
	return { status: t.status, remoteId: t.id, title: t.title };
}

export function useKnowledgeHubThreadListAdapter(): RemoteThreadListAdapter {
	const mode = useThreadStore((s) => s.mode);
	// mode can be "unknown" during the brief window between mount and session
	// detection; treat that as anon until we know otherwise, since the
	// localStorage path is read-only-safe and never hits the server.
	const effectiveMode = mode === "signed_in" ? "signed_in" : "anon";

	return useMemo<RemoteThreadListAdapter>(() => {
		const listSigned = async (): Promise<RemoteThreadListResponse> => {
			const { threads } = await apiJson<{ threads: ServerThread[] }>(
				"/api/threads",
			);
			return { threads: threads.map(toMetadata) };
		};
		const listAnon = async (): Promise<RemoteThreadListResponse> => {
			const rows = readAnonThreads().sort((a, b) => b.updatedAt - a.updatedAt);
			return { threads: rows.map(anonToMetadata) };
		};

		const initializeSigned =
			async (): Promise<RemoteThreadInitializeResponse> => {
				const body = await apiJson<{ id: string }>("/api/threads", {
					method: "POST",
					body: JSON.stringify({ title: "New thread" }),
				});
				return { remoteId: body.id, externalId: undefined };
			};
		const initializeAnon = async (
			threadId: string,
		): Promise<RemoteThreadInitializeResponse> => {
			// Use the caller-provided localId as the permanent id — anon threads
			// never leave the device, so the local id IS the remote id.
			const rows = readAnonThreads();
			if (!rows.find((r) => r.id === threadId)) {
				rows.unshift({
					id: threadId,
					title: "New thread",
					status: "regular",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				writeAnonThreads(rows);
			}
			return { remoteId: threadId, externalId: undefined };
		};

		const renameSigned = async (id: string, title: string): Promise<void> => {
			await apiJson(`/api/threads/${id}`, {
				method: "PATCH",
				body: JSON.stringify({ title }),
			});
		};
		const renameAnon = async (id: string, title: string): Promise<void> => {
			const rows = readAnonThreads();
			const updated = rows.map((r) =>
				r.id === id ? { ...r, title, updatedAt: Date.now() } : r,
			);
			writeAnonThreads(updated);
		};

		const deleteSigned = async (id: string): Promise<void> => {
			await apiJson(`/api/threads/${id}`, { method: "DELETE" });
		};
		const deleteAnon = async (id: string): Promise<void> => {
			const rows = readAnonThreads();
			writeAnonThreads(rows.filter((r) => r.id !== id));
			// The history adapter owns message cleanup via its own localStorage key.
		};

		return {
			list: effectiveMode === "signed_in" ? listSigned : listAnon,
			initialize:
				effectiveMode === "signed_in" ? initializeSigned : initializeAnon,
			rename: effectiveMode === "signed_in" ? renameSigned : renameAnon,
			// Archive is a capability we don't currently surface in the sidebar.
			// Stub both so the runtime doesn't throw if something calls them.
			archive: async () => {},
			unarchive: async () => {},
			delete: effectiveMode === "signed_in" ? deleteSigned : deleteAnon,
			// Title generation is handled out-of-band via /api/threads/title on
			// onFinish, so this adapter hook is a no-op. We still have to satisfy
			// the `Promise<AssistantStream>` contract — returning an empty
			// ReadableStream (what the upstream in-memory adapter does) lets the
			// runtime await and move on without writing anything. Throwing here
			// used to surface as an unhandled rejection every time a thread was
			// created.
			generateTitle: async () => new ReadableStream(),
			fetch: async (threadId: string) => {
				// No single-thread metadata endpoint — fall back to the list.
				const { threads } =
					effectiveMode === "signed_in" ? await listSigned() : await listAnon();
				const hit = threads.find((t) => t.remoteId === threadId);
				if (!hit) throw new Error(`thread_not_found:${threadId}`);
				return hit;
			},
		};
	}, [effectiveMode]);
}
