import Link from "next/link";

export function Footer() {
	const year = new Date().getUTCFullYear();
	return (
		<footer className="mt-16 border-t border-[var(--border)] bg-[var(--bg)]">
			<div className="mx-auto flex max-w-6xl flex-col items-start gap-3 px-4 py-8 text-xs text-[var(--text-muted)] md:flex-row md:items-center md:justify-between md:px-6">
				<p>
					Built by{" "}
					<Link
						href="https://www.linkedin.com/in/rajdholakia"
						target="_blank"
						rel="noopener noreferrer"
						className="text-[var(--text)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)] rounded-sm"
					>
						Raj Dholakia
					</Link>{" "}
					as a demonstration for{" "}
					<Link
						href="https://npxai.com"
						target="_blank"
						rel="noopener noreferrer"
						className="text-[var(--text)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)] rounded-sm"
					>
						NPX Innovation
					</Link>
					.
				</p>
				<div className="flex items-center gap-3 text-[var(--text-muted)]">
					<Link
						href="/faq"
						className="hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)] rounded-sm"
					>
						FAQ
					</Link>
					<span aria-hidden="true">·</span>
					<span>© {year} · Simulated data, not for operational use.</span>
				</div>
			</div>
		</footer>
	);
}
