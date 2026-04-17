"use client";

import {
	BookOpen,
	FileText,
	LogIn,
	Menu,
	Monitor,
	Moon,
	PanelLeftClose,
	PanelLeftOpen,
	Sun,
	X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { type ReactNode, useEffect, useState } from "react";
import { SignInButton } from "@/components/site/SignInButton";
import { UserChip } from "@/components/site/UserChip";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { initialsFromEmail } from "@/lib/initials";

type PrimaryNavItem = {
	href: string;
	label: string;
	Icon: typeof BookOpen;
};

const PRIMARY_NAV: PrimaryNavItem[] = [
	{ href: "/knowledge-hub", label: "Knowledge Hub", Icon: BookOpen },
	{ href: "/generator", label: "Generator", Icon: FileText },
];

const SIDEBAR_STATE_KEY = "npxai-app-sidebar-collapsed";

type AppShellProps = {
	children: ReactNode;
	userEmail: string | null;
};

export function AppShell({ children, userEmail }: AppShellProps) {
	const [mobileOpen, setMobileOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const [hydrated, setHydrated] = useState(false);

	useEffect(() => {
		try {
			const stored = window.localStorage.getItem(SIDEBAR_STATE_KEY);
			if (stored === "1") setCollapsed(true);
		} catch {
			// localStorage unavailable — keep defaults.
		}
		setHydrated(true);
	}, []);

	useEffect(() => {
		if (!hydrated) return;
		try {
			window.localStorage.setItem(SIDEBAR_STATE_KEY, collapsed ? "1" : "0");
		} catch {
			// Ignore quota / privacy errors.
		}
	}, [collapsed, hydrated]);

	return (
		<div className="flex h-dvh w-full gap-2 overflow-hidden bg-[var(--bg)] p-2 text-[var(--text)]">
			<aside
				aria-label="App sidebar"
				className={`hidden shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] transition-[width] duration-200 md:flex ${
					collapsed ? "w-14" : "w-60"
				}`}
			>
				<AppSidebarContent
					userEmail={userEmail}
					collapsed={collapsed}
					onToggleCollapse={() => setCollapsed((v) => !v)}
				/>
			</aside>

			<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
				<SheetContent
					side="left"
					className="w-72 border-r border-[var(--border)] bg-[var(--surface)] p-0"
				>
					<AppSidebarContent
						userEmail={userEmail}
						collapsed={false}
						onNavigate={() => setMobileOpen(false)}
					/>
				</SheetContent>
			</Sheet>

			<main className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<header className="flex h-11 shrink-0 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 md:hidden">
					<button
						type="button"
						aria-label={mobileOpen ? "Close menu" : "Open menu"}
						onClick={() => setMobileOpen(true)}
						className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
					>
						<Menu className="h-4 w-4" aria-hidden="true" />
					</button>
					<Link
						href="/"
						className="flex items-center gap-2 text-sm font-semibold tracking-tight text-[var(--text)]"
					>
						<span
							aria-hidden="true"
							className="inline-block h-5 w-5 rounded-md bg-[var(--accent-brand)]"
						/>
						<span>NPXai Demo</span>
					</Link>
				</header>
				<div className="min-h-0 flex-1 overflow-hidden">{children}</div>
			</main>
		</div>
	);
}

function AppSidebarContent({
	userEmail,
	collapsed,
	onNavigate,
	onToggleCollapse,
}: {
	userEmail: string | null;
	collapsed: boolean;
	onNavigate?: () => void;
	onToggleCollapse?: () => void;
}) {
	const pathname = usePathname();

	return (
		<div className="flex h-full flex-col">
			{/* Header — logo + collapse toggle. Toggle always lives at the top
			    of the sidebar in both states so the control doesn't jump
			    between top and bottom when the user flips the panel. */}
			<div
				className={`flex shrink-0 border-b border-[var(--border)] ${
					collapsed
						? "flex-col items-center gap-2 px-2 py-2"
						: "h-12 items-center justify-between px-3"
				}`}
			>
				{collapsed ? (
					<>
						<Link
							href="/"
							aria-label="NPXai Demo — home"
							title="NPXai Demo"
							className="flex size-7 items-center justify-center rounded-md bg-[var(--accent-brand)] font-semibold text-[12px] text-white shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
						>
							N
						</Link>
						{onToggleCollapse ? (
							<button
								type="button"
								aria-label="Expand sidebar"
								onClick={onToggleCollapse}
								className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
							>
								<PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
							</button>
						) : null}
					</>
				) : (
					<>
						<Link
							href="/"
							onClick={onNavigate}
							className="flex items-center gap-2 text-sm font-semibold tracking-tight text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)] rounded-md"
						>
							<span
								aria-hidden="true"
								className="inline-block h-6 w-6 rounded-md bg-[var(--accent-brand)]"
							/>
							<span>NPXai Demo</span>
						</Link>
						{onNavigate ? (
							<button
								type="button"
								aria-label="Close menu"
								onClick={onNavigate}
								className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
							>
								<X className="h-4 w-4" aria-hidden="true" />
							</button>
						) : onToggleCollapse ? (
							<button
								type="button"
								aria-label="Collapse sidebar"
								onClick={onToggleCollapse}
								className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
							>
								<PanelLeftClose className="h-4 w-4" aria-hidden="true" />
							</button>
						) : null}
					</>
				)}
			</div>

			<nav
				aria-label="App sections"
				className={`flex flex-col gap-1 ${collapsed ? "p-2" : "p-3"}`}
			>
				{PRIMARY_NAV.map(({ href, label, Icon }) => {
					const active = pathname === href || pathname.startsWith(`${href}/`);
					return (
						<Link
							key={href}
							href={href}
							onClick={onNavigate}
							aria-current={active ? "page" : undefined}
							title={collapsed ? label : undefined}
							className={`flex items-center gap-2 rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)] ${
								collapsed ? "justify-center p-2" : "px-2.5 py-2"
							} ${
								active
									? "bg-[var(--accent-brand)] font-medium text-white shadow-sm hover:bg-[var(--accent-brand-hover)]"
									: "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
							}`}
						>
							<Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
							{collapsed ? (
								<span className="sr-only">{label}</span>
							) : (
								<span>{label}</span>
							)}
						</Link>
					);
				})}
			</nav>

			<div className="flex-1" />

			{collapsed ? (
				<div className="flex flex-col items-center gap-2 border-t border-[var(--border)] p-2">
					<CollapsedThemeCycle />
					{userEmail ? (
						<CollapsedUserAvatar email={userEmail} />
					) : (
						<CollapsedSignIn />
					)}
				</div>
			) : (
				<div className="border-t border-[var(--border)] p-3">
					<p className="mb-3 text-[11px] leading-snug text-[var(--text-muted)]">
						Simulated data. Not for operational use.
					</p>
					<div className="flex flex-col items-start gap-2">
						{userEmail ? <UserChip email={userEmail} /> : <SignInButton />}
						<ThemeToggle size="sm" />
					</div>
				</div>
			)}
		</div>
	);
}

// Compact theme control for the collapsed sidebar — cycles through
// Light → Dark → System on each click, showing the icon of the active
// mode. Keeps all three choices reachable in 32px of width.
function CollapsedThemeCycle() {
	const { theme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const active = (mounted ? theme : "system") ?? "system";
	const next =
		active === "light" ? "dark" : active === "dark" ? "system" : "light";
	const Icon = active === "light" ? Sun : active === "dark" ? Moon : Monitor;
	const nextLabel =
		next === "light" ? "Light" : next === "dark" ? "Dark" : "System";
	return (
		<button
			type="button"
			aria-label={`Switch to ${nextLabel} theme`}
			title={`Theme: ${active} → ${nextLabel}`}
			onClick={() => setTheme(next)}
			className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)] transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
		>
			<Icon className="h-3.5 w-3.5" aria-hidden="true" />
		</button>
	);
}

function CollapsedSignIn() {
	return (
		<SignInButton
			trigger={
				<button
					type="button"
					aria-label="Sign in"
					title="Sign in"
					className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full bg-[var(--accent-brand)] text-white shadow-sm transition-colors hover:bg-[var(--accent-brand-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
				>
					<LogIn className="h-4 w-4" aria-hidden="true" />
				</button>
			}
		/>
	);
}

function CollapsedUserAvatar({ email }: { email: string }) {
	const initials = initialsFromEmail(email);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={`Account menu for ${email}`}
					title={email}
					className="flex size-8 items-center justify-center rounded-full bg-[var(--accent-brand)] font-semibold text-[11px] text-white shadow-sm ring-1 ring-[var(--border)] transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
				>
					{initials}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent side="right" align="end" className="min-w-48">
				<DropdownMenuLabel className="truncate text-xs font-normal text-[var(--text-muted)]">
					{email}
				</DropdownMenuLabel>
				<DropdownMenuSeparator />
				<DropdownMenuItem asChild>
					<form action="/auth/signout" method="post" className="w-full">
						<button type="submit" className="w-full text-left">
							Sign out
						</button>
					</form>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
