"use client";

// The user's source scope — the "model picker" of the Knowledge Hub. One
// global choice shared by chat and artifact mode, remembered across visits
// (localStorage) like a chat app remembers the selected model.
//
// The chat transport reads it at send time (useSourceScope.getState()), so
// the runtime never has to be rebuilt when the selection changes. The
// server validates it again and treats it as a request, not a grant: a
// pinned collection that is not enabled gets a notice, never a fallback.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CollectionId } from "./catalog";
import type { ScopeRequest } from "./scope";

interface SourceScopeState {
	scope: ScopeRequest;
	/**
	 * Set by a notice's "Switch to …" button just before it re-asks the
	 * question. The re-ask goes out as a regenerate (it replaces the notice),
	 * which would normally skip and invalidate the answer cache; this tells
	 * the server it is a scope change, not a "give me a fresh answer", so a
	 * cached answer for the new scope is still served. One-shot, not
	 * persisted, and only honoured for SWITCH_WINDOW_MS: if that re-ask never
	 * reaches the transport, a later manual Regenerate is not mistaken for
	 * it. A timestamp (0 = none).
	 */
	switchPendingAt: number;
	markScopeSwitch: () => void;
	setAuto: () => void;
	pin: (collection: CollectionId) => void;
	setHistorical: (historical: boolean) => void;
	/** Drop a pinned collection the deployment no longer offers. */
	reconcile: (available: readonly CollectionId[]) => void;
}

export const useSourceScope = create<SourceScopeState>()(
	persist(
		(set, get) => ({
			scope: { mode: "auto" },
			switchPendingAt: 0,
			markScopeSwitch: () => set({ switchPendingAt: Date.now() }),
			setAuto: () =>
				set({ scope: { mode: "auto", historical: get().scope.historical } }),
			pin: (collection) =>
				set({
					scope: {
						mode: "pinned",
						collection,
						historical: get().scope.historical,
					},
				}),
			setHistorical: (historical) =>
				set({ scope: { ...get().scope, historical } }),
			reconcile: (available) => {
				const { scope } = get();
				if (scope.mode === "pinned" && !available.includes(scope.collection)) {
					set({ scope: { mode: "auto", historical: scope.historical } });
				}
			},
		}),
		{
			name: "kh-source-scope",
			version: 1,
			partialize: (s) => ({ scope: s.scope }),
			// Rehydrated by ScopePicker after mount: reading localStorage while
			// the store is created would make the first client render differ
			// from the server's ("Auto") and break hydration.
			skipHydration: true,
		},
	),
);

const SWITCH_WINDOW_MS = 5000;

/**
 * The body fields the CHAT request carries. Consumes the one-shot
 * scope-switch flag (see switchPendingAt). The artifact request uses
 * currentScope() and never touches the flag.
 */
export function currentScopeBody(): {
	scope: ScopeRequest;
	scopeSwitch?: true;
} {
	const { scope, switchPendingAt } = useSourceScope.getState();
	if (switchPendingAt === 0) return { scope };
	useSourceScope.setState({ switchPendingAt: 0 });
	return Date.now() - switchPendingAt <= SWITCH_WINDOW_MS
		? { scope, scopeSwitch: true }
		: { scope };
}

/** The scope alone, for requests that have no regenerate (artifacts). */
export function currentScope(): { scope: ScopeRequest } {
	return { scope: useSourceScope.getState().scope };
}
