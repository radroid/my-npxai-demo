const NPX_EMAIL_DOMAINS = new Set(["npxinnovation.ca"]);

export function isNpxEmail(email: string | null | undefined): boolean {
	if (!email) return false;
	const at = email.lastIndexOf("@");
	if (at < 0) return false;
	const domain = email.slice(at + 1).toLowerCase();
	return NPX_EMAIL_DOMAINS.has(domain);
}

export function defaultThemeForEmail(
	email: string | null | undefined,
): "npx" | "system" {
	return isNpxEmail(email) ? "npx" : "system";
}
