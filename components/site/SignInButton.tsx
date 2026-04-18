"use client";

import { type ReactNode, useId, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type Status = "idle" | "loading" | "success" | "error";

const COPY = {
	title: "Sign in for extended daily quota",
	blurb:
		"Sign in for 10× more queries per day. Work emails from Bruce Power, OPG, Cameco, CNSC, or NPX unlock an extended tier.",
	emailLabel: "Email address",
	emailPlaceholder: "you@company.com",
	submit: "Send magic link",
	submitting: "Sending…",
	success: "Check your email — the link is valid for 1 hour.",
	error: "Something went wrong. Try again.",
	retry: "Try again",
};

export function SignInButton({ trigger }: { trigger?: ReactNode } = {}) {
	const [open, setOpen] = useState(false);
	const [status, setStatus] = useState<Status>("idle");
	const [email, setEmail] = useState("");
	const emailId = useId();
	const statusId = useId();

	const reset = () => {
		setStatus("idle");
	};

	const onOpenChange = (next: boolean) => {
		setOpen(next);
		if (!next) {
			setStatus("idle");
			setEmail("");
		}
	};

	const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!email.trim()) return;
		setStatus("loading");
		try {
			const supabase = getSupabaseBrowserClient();
			const { error } = await supabase.auth.signInWithOtp({
				email: email.trim(),
				options: {
					emailRedirectTo: `${window.location.origin}/auth/callback`,
				},
			});
			if (error) throw error;
			setStatus("success");
		} catch (err) {
			console.error("[sign-in] signInWithOtp failed", err);
			setStatus("error");
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>
				{trigger ?? (
					<button
						type="button"
						className="inline-flex h-11 cursor-pointer items-center rounded-md bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface sm:h-8 sm:px-3 sm:text-xs"
					>
						Sign in
					</button>
				)}
			</DialogTrigger>
			<DialogContent className="border-border bg-surface text-fg sm:max-w-md max-sm:h-full max-sm:max-w-full max-sm:rounded-none">
				<DialogHeader>
					<DialogTitle className="text-fg">{COPY.title}</DialogTitle>
					<DialogDescription className="text-fg-muted">
						{COPY.blurb}
					</DialogDescription>
				</DialogHeader>

				{status === "success" ? (
					<div
						aria-live="polite"
						id={statusId}
						className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg"
					>
						{COPY.success}
					</div>
				) : (
					<form onSubmit={onSubmit} className="flex flex-col gap-3">
						<label htmlFor={emailId} className="text-sm text-fg-muted">
							{COPY.emailLabel}
						</label>
						<input
							id={emailId}
							type="email"
							required
							autoComplete="email"
							inputMode="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							placeholder={COPY.emailPlaceholder}
							disabled={status === "loading"}
							className="h-10 rounded-md border border-border bg-bg px-3 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60"
						/>

						{status === "error" ? (
							<div
								role="alert"
								aria-live="polite"
								id={statusId}
								className="rounded-md border border-danger bg-danger/10 px-3 py-2 text-sm text-danger"
							>
								<p>{COPY.error}</p>
								<button
									type="button"
									onClick={reset}
									className="mt-2 inline-flex cursor-pointer items-center text-xs font-medium text-fg underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded-sm"
								>
									{COPY.retry}
								</button>
							</div>
						) : null}

						<button
							type="submit"
							disabled={status === "loading" || !email.trim()}
							aria-describedby={status === "error" ? statusId : undefined}
							className="mt-1 inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-60"
						>
							{status === "loading" ? (
								<>
									<Spinner />
									{COPY.submitting}
								</>
							) : (
								COPY.submit
							)}
						</button>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

function Spinner() {
	return (
		<span
			aria-hidden="true"
			className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
		/>
	);
}
