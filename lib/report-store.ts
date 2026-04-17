// Generator report persistence — client helpers for the anon path.
// Signed-in users read/write via Supabase RPCs (list_reports / save_report /
// delete_report) on the browser client; anon users keep the last N reports
// in localStorage as a simple ring buffer per the 2026-04-17 hybrid decision.

export type StoredReport = {
	id: string;
	station: string;
	unit: string;
	shift: string;
	snapshot_hash: string;
	generated_at: string;
	report_markdown: string;
};

const STORAGE_KEY = "npxai-demo-anon-reports";
const MAX_ANON_REPORTS = 5;

function isBrowser(): boolean {
	return (
		typeof window !== "undefined" && typeof window.localStorage !== "undefined"
	);
}

export function readAnonReports(): StoredReport[] {
	if (!isBrowser()) return [];
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((r): r is StoredReport => {
			return (
				r &&
				typeof r === "object" &&
				typeof r.id === "string" &&
				typeof r.station === "string" &&
				typeof r.unit === "string" &&
				typeof r.shift === "string" &&
				typeof r.snapshot_hash === "string" &&
				typeof r.generated_at === "string" &&
				typeof r.report_markdown === "string"
			);
		});
	} catch {
		return [];
	}
}

function writeAnonReports(reports: StoredReport[]): void {
	if (!isBrowser()) return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
	} catch {
		// Quota or privacy mode — drop silently; persistence is best-effort here.
	}
}

export function saveAnonReport(
	input: Omit<StoredReport, "id">,
): StoredReport | null {
	if (!isBrowser()) return null;
	const existing = readAnonReports();
	// Dedupe on (station, unit, shift, snapshot_hash): if same, overwrite.
	const idx = existing.findIndex(
		(r) =>
			r.station === input.station &&
			r.unit === input.unit &&
			r.shift === input.shift &&
			r.snapshot_hash === input.snapshot_hash,
	);
	const id = idx >= 0 ? existing[idx].id : newId();
	const record: StoredReport = { id, ...input };
	const without = idx >= 0 ? existing.filter((_, i) => i !== idx) : existing;
	const next = [record, ...without].slice(0, MAX_ANON_REPORTS);
	writeAnonReports(next);
	return record;
}

export function deleteAnonReport(id: string): void {
	if (!isBrowser()) return;
	const remaining = readAnonReports().filter((r) => r.id !== id);
	writeAnonReports(remaining);
}

export function findAnonReportByHash(
	station: string,
	unit: string,
	shift: string,
	snapshotHash: string,
): StoredReport | null {
	return (
		readAnonReports().find(
			(r) =>
				r.station === station &&
				r.unit === unit &&
				r.shift === shift &&
				r.snapshot_hash === snapshotHash,
		) ?? null
	);
}

function newId(): string {
	if (isBrowser() && "crypto" in window && "randomUUID" in window.crypto) {
		return window.crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	const now = Date.now();
	const diffMs = now - then;
	if (diffMs < 60_000) return "just now";
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(iso).toLocaleDateString();
}
