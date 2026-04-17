"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

const OPTIONS = [
	{ value: "light", label: "Light", Icon: Sun },
	{ value: "dark", label: "Dark", Icon: Moon },
	{ value: "system", label: "System", Icon: Monitor },
] as const;

type ToggleSize = "sm" | "md";

export function ThemeToggle({ size = "md" }: { size?: ToggleSize }) {
	const { theme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	const active = (mounted ? theme : "system") ?? "system";
	const btnSize = size === "sm" ? "h-6 w-6" : "h-7 w-7";
	const iconSize = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";

	return (
		<fieldset
			aria-label="Color theme"
			className="inline-flex items-center gap-0.5 rounded-full border border-border bg-[var(--surface-2)] p-0.5"
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
						className={`inline-flex ${btnSize} items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)] ${
							isActive
								? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
								: "text-[var(--text-muted)] hover:text-[var(--text)]"
						}`}
					>
						<Icon className={iconSize} aria-hidden="true" />
					</button>
				);
			})}
		</fieldset>
	);
}
