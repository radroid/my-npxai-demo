"use client";

import { Clock3, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	deleteAnonReport,
	readAnonReports,
	relativeTime,
} from "@/lib/report-store";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

export type RecentReport = {
	id: string;
	station: string;
	unit: string;
	shift: string;
	snapshot_hash: string;
	generated_at: string;
	// Only populated for anon path (localStorage). For signed-in listings we
	// fetch the full markdown via get_report RPC on click.
	report_markdown?: string;
};

type RecentReportsProps = {
	signedIn: boolean;
	refreshKey: number;
	onLoad: (report: RecentReport) => void;
};

export function RecentReports({
	signedIn,
	refreshKey,
	onLoad,
}: RecentReportsProps) {
	const [reports, setReports] = useState<RecentReport[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setError(null);
		if (!signedIn) {
			setReports(readAnonReports());
			return;
		}
		setLoading(true);
		try {
			const supabase = getSupabaseBrowserClient();
			const { data, error: rpcErr } = await supabase.rpc("list_reports");
			if (rpcErr) {
				// Typical when migration not yet applied — degrade silently.
				setReports([]);
				setError(null);
			} else {
				setReports((data as RecentReport[]) ?? []);
			}
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
			onLoad(r);
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
			if (row?.report_markdown) onLoad(row);
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

	if (reports.length === 0 && !loading && !error) return null;

	return (
		<section
			aria-label="Recent reports"
			className="flex flex-col gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3"
		>
			<div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text)]">
				<Clock3 className="size-3.5 text-[var(--text-muted)]" aria-hidden />
				Recent reports
			</div>
			<ul className="flex flex-col gap-1">
				{reports.map((r) => (
					<li key={r.id}>
						<div className="group flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-[var(--surface-2)]">
							<button
								type="button"
								onClick={() => handleSelect(r)}
								className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)] rounded-sm"
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
								className="shrink-0 rounded p-1 text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-[var(--surface)] hover:text-[var(--danger)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--danger)] group-hover:opacity-100"
							>
								<Trash2 className="size-3" aria-hidden />
							</button>
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}
