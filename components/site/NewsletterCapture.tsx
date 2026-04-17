"use client";

import { CheckIcon } from "lucide-react";
import { type FC, useState } from "react";

// UI-only newsletter capture. No backend — the submit simulates acceptance
// and clears. Scope per PLAN.md: "Homepage newsletter email capture remains
// UI-only and is unrelated to auth."
export const NewsletterCapture: FC = () => {
	const [email, setEmail] = useState("");
	const [status, setStatus] = useState<"idle" | "sent">("idle");

	function submit(e: React.FormEvent) {
		e.preventDefault();
		if (!/^\S+@\S+\.\S+$/.test(email)) return;
		setStatus("sent");
		setEmail("");
		setTimeout(() => setStatus("idle"), 4000);
	}

	return (
		<form
			onSubmit={submit}
			className="mx-auto flex w-full max-w-md flex-col gap-2 sm:flex-row"
			aria-label="Newsletter signup (UI-only demo)"
		>
			<label className="sr-only" htmlFor="newsletter-email">
				Email
			</label>
			<input
				id="newsletter-email"
				type="email"
				required
				value={email}
				onChange={(e) => setEmail(e.target.value)}
				placeholder="you@company.com"
				className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
			/>
			<button
				type="submit"
				disabled={status === "sent"}
				className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-default disabled:opacity-80"
			>
				{status === "sent" ? (
					<>
						<CheckIcon className="size-4" aria-hidden="true" /> Subscribed
					</>
				) : (
					"Keep me posted"
				)}
			</button>
		</form>
	);
};
