"use client";

// Two-option segmented control switching the Knowledge Hub between the chat
// thread and the Artifact workbench (item-1 slice 1.2, DELTA D3). Rendered in
// BOTH surfaces near the composer/input so the toggle never moves on screen.
// Canonical token utilities only (I1.3) — active option follows the AppShell
// active-nav precedent (bg-brand text-white), correct in light/dark/npx.

export type HubMode = "chat" | "artifact";

const OPTIONS: Array<{ mode: HubMode; label: string }> = [
	{ mode: "chat", label: "Chat" },
	{ mode: "artifact", label: "Artifact" },
];

export interface ModeToggleProps {
	mode: HubMode;
	onModeChange: (mode: HubMode) => void;
}

export function ModeToggle({ mode, onModeChange }: ModeToggleProps) {
	return (
		// aria-pressed buttons carry the toggle semantics; biome's
		// useSemanticElements rejects role="group" on a div, and a fieldset
		// brings default-style baggage — the two labelled buttons are
		// self-describing.
		<div className="inline-flex w-fit items-center gap-0.5 rounded-full border border-border bg-surface-2 p-0.5">
			{OPTIONS.map((opt) => {
				const active = mode === opt.mode;
				return (
					<button
						key={opt.mode}
						type="button"
						aria-pressed={active}
						onClick={() => onModeChange(opt.mode)}
						className={`rounded-full px-3 py-1 font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
							active
								? "bg-brand text-white shadow-sm"
								: "text-fg-muted hover:text-fg"
						}`}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}
