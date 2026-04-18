"use client";

import { useTheme } from "next-themes";
import { useRef } from "react";
import { BrandMark } from "@/components/site/BrandMark";

// Easter-egg click target: the brand lockup in the top-left toggles
// between NPX brand theme and whatever the user was on before. Remembers
// the previous explicit choice in a ref so toggling back after refresh
// falls through to `resolvedTheme` (OS preference) instead of stale state.
export function BrandThemeToggle() {
	const { theme, resolvedTheme, setTheme } = useTheme();
	const previousTheme = useRef<string | undefined>(undefined);

	const handleClick = () => {
		if (theme === "npx") {
			setTheme(previousTheme.current ?? resolvedTheme ?? "light");
			return;
		}
		previousTheme.current = theme === "system" ? resolvedTheme : theme;
		setTheme("npx");
	};

	const isNpx = theme === "npx";
	const pressedLabel = isNpx
		? "Switch back to previous theme"
		: "Switch to NPX brand theme";

	return (
		<button
			type="button"
			onClick={handleClick}
			aria-pressed={isNpx}
			aria-label={pressedLabel}
			title={pressedLabel}
			className="flex items-center gap-2 rounded-md text-sm font-semibold tracking-tight text-fg transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
		>
			<BrandMark className="h-6 w-6" />
			<span>NPXai Demo</span>
		</button>
	);
}
