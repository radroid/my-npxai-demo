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
		{ name: "kh-source-scope", version: 1 },
	),
);

/** The body field the chat and artifact requests carry. */
export function currentScopeBody(): { scope: ScopeRequest } {
	return { scope: useSourceScope.getState().scope };
}
