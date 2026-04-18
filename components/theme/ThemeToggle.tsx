"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { NpxLogoMark } from "@/components/icons/NpxLogoMark";

const OPTIONS = [
	{ value: "light", label: "Light", Icon: Sun },
	{ value: "dark", label: "Dark", Icon: Moon },
	{ value: "npx", label: "NPX brand", Icon: NpxLogoMark },
] as const;

type ToggleSize = "sm" | "md";

export function ThemeToggle({ size = "md" }: { size?: ToggleSize }) {
	const { theme, resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	// Before mount we don't know the actual theme; render without an active
	// pill to avoid a hydration flash. After mount, if the user hasn't picked
	// explicitly, `theme === "system"` — fall back to the OS-resolved value so
	// the matching pill (Light or Dark) lights up.
	const active = mounted
		? theme === "system"
			? resolvedTheme
			: theme
		: undefined;
	// On mobile, each pill stretches to a comfortable tap target (~44px tall)
	// so the drawer-mounted toggle is thumb-friendly. Desktop keeps the
	// compact size baked into the original Appendix G layout.
	const btnSize =
		size === "sm" ? "h-9 w-9 sm:h-6 sm:w-6" : "h-10 w-10 sm:h-7 sm:w-7";
	const iconSize =
		size === "sm" ? "h-4 w-4 sm:h-3 sm:w-3" : "h-4 w-4 sm:h-3.5 sm:w-3.5";

	return (
		<fieldset
			aria-label="Color theme"
			className="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface-2 p-0.5"
		>
			{OPTIONS.map(({ value, label, Icon }) => {
				const isActive = active === value;
				return (
					<button
						key={value}
						type="button"
						aria-pressed={isActive}
						aria-label={`${label} theme`}
						onClick={() => setTheme(value)}
						className={`inline-flex ${btnSize} items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
							isActive
								? "bg-surface text-fg shadow-sm"
								: "text-fg-muted hover:text-fg"
						}`}
					>
						<Icon className={iconSize} aria-hidden="true" />
					</button>
				);
			})}
		</fieldset>
	);
}
