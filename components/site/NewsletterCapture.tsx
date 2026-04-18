"use client";

import { ArrowRightIcon, CheckIcon } from "lucide-react";
import Link from "next/link";
import { type FC, useId, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type Status = "idle" | "loading" | "sent" | "error";

export const NewsletterCapture: FC<{ isSignedIn?: boolean }> = ({
	isSignedIn = false,
}) => {
	const [email, setEmail] = useState("");
	const [status, setStatus] = useState<Status>("idle");
	const emailId = useId();
	const statusId = useId();

	if (isSignedIn) {
		return (
			<div className="flex flex-col items-center gap-3">
				<p className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg">
					<CheckIcon className="size-4 text-success" aria-hidden="true" />
					You're already signed in.
				</p>
				<Link
					href="/knowledge-hub"
					className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				>
					Open the Knowledge Hub
					<ArrowRightIcon className="size-4" aria-hidden="true" />
				</Link>
			</div>
		);
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = email.trim();
		if (!/^\S+@\S+\.\S+$/.test(trimmed)) return;
		setStatus("loading");
		try {
			const supabase = getSupabaseBrowserClient();
			const { error } = await supabase.auth.signInWithOtp({
				email: trimmed,
				options: {
					emailRedirectTo: `${window.location.origin}/auth/callback`,
				},
			});
			if (error) throw error;
			setStatus("sent");
			setEmail("");
		} catch (err) {
			console.error("[newsletter] signInWithOtp failed", err);
			setStatus("error");
		}
	}

	if (status === "sent") {
		return (
			<div
				aria-live="polite"
				id={statusId}
				className="mx-auto flex w-full max-w-md items-center justify-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-3 text-sm text-fg"
			>
				<CheckIcon className="size-4 text-success" aria-hidden="true" />
				Check your inbox — the link signs you in. Good for 1 hour.
			</div>
		);
	}

	return (
		<form
			onSubmit={submit}
			className="mx-auto flex w-full max-w-md flex-col gap-2 sm:flex-row"
			aria-label="Sign up for NPXai with a magic link"
		>
			<label className="sr-only" htmlFor={emailId}>
				Email
			</label>
			<input
				id={emailId}
				type="email"
				required
				autoComplete="email"
				inputMode="email"
				value={email}
				onChange={(e) => setEmail(e.target.value)}
				placeholder="you@company.com"
				disabled={status === "loading"}
				aria-describedby={status === "error" ? statusId : undefined}
				className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60"
			/>
			<button
				type="submit"
				disabled={status === "loading" || !email.trim()}
				className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-60"
			>
				{status === "loading" ? (
					<>
						<Spinner />
						Sending…
					</>
				) : (
					"Send me a sign-in link"
				)}
			</button>
			{status === "error" ? (
				<p
					role="alert"
					aria-live="polite"
					id={statusId}
					className="w-full rounded-md border border-danger bg-danger/10 px-3 py-2 text-sm text-danger sm:w-auto"
				>
					Couldn't send that link. Try again.
				</p>
			) : null}
		</form>
	);
};

function Spinner() {
	return (
		<span
			aria-hidden="true"
			className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
		/>
	);
}
