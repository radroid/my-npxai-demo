"use client";

// Stub for Phase 2 iter 3. Opens the sign-in modal once it's wired.
// For now it is a visible, keyboard-reachable button with no-op click
// so the nav renders complete and iter 2's eyeball review can confirm
// styling/contrast before the modal arrives.

export function SignInButton() {
	return (
		<button
			type="button"
			onClick={() => {
				// TODO(iter3): open sign-in modal (Appendix J.6)
			}}
			className="inline-flex h-8 items-center rounded-md bg-[--accent] px-3 text-xs font-medium text-[--bg] transition-colors hover:bg-[--accent-hover] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] focus-visible:ring-offset-2 focus-visible:ring-offset-[--surface]"
		>
			Sign in
		</button>
	);
}
