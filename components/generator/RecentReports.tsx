"use client";

import { Clock3, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type RecentReport, useGeneratorStore } from "@/lib/generator-store";
import {
	deleteAnonReport,
	readAnonReports,
	relativeTime,
} from "@/lib/report-store";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

export type { RecentReport } from "@/lib/generator-store";

export function RecentReports({ onNavigate }: { onNavigate?: () => void }) {
	const [reports, setReports] = useState<RecentReport[]>([]);
	const [loading, setLoading] = useState(false);
	const [signedIn, setSignedIn] = useState(false);
	const refreshKey = useGeneratorStore((s) => s.refreshKey);
	const requestLoad = useGeneratorStore((s) => s.requestLoad);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const supabase = getSupabaseBrowserClient();
				const {
					data: { session },
				} = await supabase.auth.getSession();
				if (!cancelled) setSignedIn(Boolean(session?.user));
			} catch {
				if (!cancelled) setSignedIn(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const load = useCallback(async () => {
		if (!signedIn) {
			setReports(readAnonReports());
			return;
		}
		setLoading(true);
		try {
			const supabase = getSupabaseBrowserClient();
			const { data, error: rpcErr } = await supabase.rpc("list_reports");
			// rpcErr is typical when migration not yet applied — degrade silently.
			setReports(rpcErr ? [] : ((data as RecentReport[]) ?? []));
		} catch {
			setReports([]);
		} finally {
			setLoading(false);
		}
	}, [signedIn]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a bump counter — changing it is the signal to refetch
	useEffect(() => {
		load();
	}, [load, refreshKey]);

	async function handleSelect(r: RecentReport) {
		if (r.report_markdown) {
			requestLoad(r);
			onNavigate?.();
			return;
		}
		// Signed-in: fetch full markdown lazily.
		try {
			const supabase = getSupabaseBrowserClient();
			const { data, error: rpcErr } = await supabase.rpc("get_report", {
				p_id: r.id,
			});
			if (rpcErr) return;
			const row = Array.isArray(data) ? (data[0] as RecentReport) : null;
			if (row?.report_markdown) {
				requestLoad(row);
				onNavigate?.();
			}
		} catch {
			// Ignore — the user can retry.
		}
	}

	async function handleDelete(id: string, e: React.MouseEvent) {
		e.stopPropagation();
		if (signedIn) {
			try {
				const supabase = getSupabaseBrowserClient();
				await supabase.rpc("delete_report", { p_id: id });
			} catch {
				// Fall through — reload will show current server state.
			}
		} else {
			deleteAnonReport(id);
		}
		await load();
	}

	return (
		<div className="flex h-full flex-col gap-2 px-3 py-3">
			<div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
				<Clock3 className="size-3.5" aria-hidden />
				Recent reports
			</div>
			{reports.length === 0 ? (
				<p className="px-1 py-2 text-xs text-[var(--text-muted)]">
					{loading ? "Loading…" : "Reports you generate will show up here."}
				</p>
			) : (
				<ul className="flex flex-col gap-0.5">
					{reports.map((r) => (
						<li key={r.id}>
							<div className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-[var(--surface-2)]">
								<button
									type="button"
									onClick={() => handleSelect(r)}
									className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
								>
									<span className="truncate font-mono text-[var(--text)]">
										{r.station} · {r.unit} · {r.shift}
									</span>
									<span className="text-[var(--text-muted)]">
										{relativeTime(r.generated_at)}
									</span>
								</button>
								<button
									type="button"
									aria-label={`Delete report for ${r.station} ${r.unit} ${r.shift}`}
									onClick={(e) => handleDelete(r.id, e)}
									className="shrink-0 cursor-pointer rounded p-1 text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-[var(--surface)] hover:text-[var(--danger)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--danger)] group-hover:opacity-100"
								>
									<Trash2 className="size-3" aria-hidden />
								</button>
							</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
