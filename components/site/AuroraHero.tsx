import type { ReactNode } from "react";

export function AuroraHero({ children }: { children: ReactNode }) {
	return (
		<div className="relative isolate overflow-hidden">
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 -z-10"
			>
				<div className="aurora-band aurora-band-a" />
				<div className="aurora-band aurora-band-b" />
				<div className="aurora-band aurora-band-c" />
				<div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[var(--bg)]" />
			</div>
			{children}
		</div>
	);
}
