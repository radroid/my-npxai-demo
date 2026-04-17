// Generator report persistence — client helpers for the anon path.
// Signed-in users read/write via Supabase RPCs; anon users keep the last N
// reports in localStorage as a ring buffer (2026-04-17 hybrid decision).

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
const STRING_FIELDS: (keyof StoredReport)[] = [
	"id",
	"station",
	"unit",
	"shift",
	"snapshot_hash",
	"generated_at",
	"report_markdown",
];

const isBrowser = (): boolean =>
	typeof window !== "undefined" && typeof window.localStorage !== "undefined";

export function readAnonReports(): StoredReport[] {
	if (!isBrowser()) return [];
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		const parsed = raw ? JSON.parse(raw) : null;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(r): r is StoredReport =>
				r &&
				typeof r === "object" &&
				STRING_FIELDS.every((k) => typeof r[k] === "string"),
		);
	} catch {
		return [];
	}
}

function writeAnonReports(reports: StoredReport[]): void {
	if (!isBrowser()) return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
	} catch {
		// Quota/privacy mode — persistence is best-effort.
	}
}

export function saveAnonReport(
	input: Omit<StoredReport, "id">,
): StoredReport | null {
	if (!isBrowser()) return null;
	const existing = readAnonReports();
	const match = existing.find(
		(r) =>
			r.station === input.station &&
			r.unit === input.unit &&
			r.shift === input.shift &&
			r.snapshot_hash === input.snapshot_hash,
	);
	const record: StoredReport = { id: match?.id ?? newId(), ...input };
	const next = [record, ...existing.filter((r) => r.id !== record.id)].slice(
		0,
		MAX_ANON_REPORTS,
	);
	writeAnonReports(next);
	return record;
}

export function deleteAnonReport(id: string): void {
	if (!isBrowser()) return;
	writeAnonReports(readAnonReports().filter((r) => r.id !== id));
}

function newId(): string {
	if (isBrowser() && window.crypto?.randomUUID) {
		return window.crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function relativeTime(iso: string): string {
	const diffMs = Date.now() - new Date(iso).getTime();
	if (diffMs < 60_000) return "just now";
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(iso).toLocaleDateString();
}
