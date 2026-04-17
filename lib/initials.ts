export function initialsFromEmail(email: string): string {
	const local = email.split("@")[0] ?? "";
	const parts = local.split(/[._-]+/).filter(Boolean);
	const first = parts[0]?.[0];
	const second = parts[1]?.[0];
	if (first && second) return (first + second).toUpperCase();
	return (local.slice(0, 2) || "??").toUpperCase();
}
