"use client";

// Bridge store for the Generator's "Recent reports" rail.
// RecentReports now renders in the global AppShell sidebar (under a
// pathname-gated section) while GeneratorForm still owns the stream + view.
// Props no longer reach across the tree, so we coordinate via zustand:
//   - bumpRefresh(): stream fires on completion → sidebar reloads its list
//   - requestLoad(r): sidebar row click → form picks it up in a useEffect
//     and calls loadExisting() to render it in the main view.

import { create } from "zustand";

export type RecentReport = {
	id: string;
	station: string;
	unit: string;
	shift: string;
	snapshot_hash: string;
	generated_at: string;
	// Only populated for the anon path (localStorage). Signed-in listings
	// fetch full markdown on click via get_report.
	report_markdown?: string;
};

interface GeneratorStoreState {
	refreshKey: number;
	pendingLoad: RecentReport | null;
	bumpRefresh: () => void;
	requestLoad: (r: RecentReport) => void;
	consumeLoad: () => void;
}

export const useGeneratorStore = create<GeneratorStoreState>((set) => ({
	refreshKey: 0,
	pendingLoad: null,
	bumpRefresh: () => set((s) => ({ refreshKey: s.refreshKey + 1 })),
	requestLoad: (r) => set({ pendingLoad: r }),
	consumeLoad: () => set({ pendingLoad: null }),
}));
