"use client";

import { useState } from "react";
import { initialsFromEmail } from "@/lib/initials";

export function UserChip({ email }: { email: string }) {
	const [open, setOpen] = useState(false);

	return (
		<div className="relative">
			<button
				type="button"
				aria-label={`Account menu for ${email}`}
				aria-expanded={open}
				aria-haspopup="menu"
				onClick={() => setOpen((v) => !v)}
				className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-full border border-border bg-[var(--surface-2)] pr-3 pl-1 text-xs font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
			>
				<span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent-brand)] text-[10px] font-semibold text-white">
					{initialsFromEmail(email)}
				</span>
				<span className="max-w-[10rem] truncate">{email}</span>
			</button>

			{open ? (
				<div
					role="menu"
					className="absolute right-0 mt-2 min-w-48 rounded-md border border-border bg-[var(--surface)] py-1 shadow-lg"
				>
					<form action="/auth/signout" method="post">
						<button
							type="submit"
							role="menuitem"
							className="flex w-full items-center px-3 py-2 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-2)]"
						>
							Sign out
						</button>
					</form>
				</div>
			) : null}
		</div>
	);
}
