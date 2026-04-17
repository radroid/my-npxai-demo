"use client";

// Knowledge Hub auth-mode store. Used to be a full thread+message cache; most
// of that moved into the RemoteThreadListAdapter + ThreadHistoryAdapter pair
// once the runtime took over thread identity + hydration. What remains is the
// one piece the runtime can't know on its own: which auth tier the adapters
// should branch to (Supabase vs localStorage). KnowledgeHubShell sets this
// from the Supabase session; the adapters read it inside their hooks so a
// tier change rebuilds them and the runtime re-lists threads in the new tier.
//
// Persist is kept purely as a hint so the adapters can render sensibly on
// first paint before the async session check resolves (treats "unknown" as
// anon, so localStorage shows if present).

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ThreadStoreState {
	mode: "anon" | "signed_in" | "unknown";
	setMode: (mode: "anon" | "signed_in") => Promise<void>;
}

export const useThreadStore = create<ThreadStoreState>()(
	persist(
		(set) => ({
			mode: "unknown",
			setMode: async (mode) => {
				set({ mode });
			},
		}),
		{
			name: "npxai-kh-mode",
			version: 1,
		},
	),
);
