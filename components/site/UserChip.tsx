"use client";

import { useEffect, useRef, useState } from "react";
import { initialsFromEmail } from "@/lib/initials";

export function UserChip({ email }: { email: string }) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);

	// Close the menu on outside click + Escape so it doesn't linger after a
	// user taps elsewhere on mobile.
	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (!rootRef.current) return;
			if (!rootRef.current.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div className="relative" ref={rootRef}>
			<button
				type="button"
				aria-label={`Account menu for ${email}`}
				aria-expanded={open}
				aria-haspopup="menu"
				onClick={() => setOpen((v) => !v)}
				className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-full border border-border bg-surface-2 pr-1 pl-1 text-xs font-medium text-fg transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface sm:h-8 sm:pr-3"
			>
				<span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-white sm:h-6 sm:w-6 sm:text-[10px]">
					{initialsFromEmail(email)}
				</span>
				<span className="hidden max-w-[10rem] truncate sm:inline">{email}</span>
			</button>

			{open ? (
				// Anchor left + cap width so the menu stays inside the 240px
				// sidebar (which is `overflow-hidden` — anything that escapes the
				// aside's right edge gets clipped).
				<div
					role="menu"
					className="absolute left-0 bottom-full mb-2 w-[min(12rem,calc(100vw-1.5rem))] overflow-hidden rounded-md border border-border bg-surface shadow-lg"
				>
					<p
						className="truncate border-b border-border px-3 py-2 text-xs text-fg-muted"
						title={email}
					>
						{email}
					</p>
					<form action="/auth/signout" method="post">
						<button
							type="submit"
							role="menuitem"
							className="flex w-full items-center px-3 py-2.5 text-left text-sm text-fg hover:bg-surface-2"
						>
							Sign out
						</button>
					</form>
				</div>
			) : null}
		</div>
	);
}
