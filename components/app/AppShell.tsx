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
import { RecentReports } from "@/components/generator/RecentReports";
import { ThreadSidebar } from "@/components/knowledge-hub/ThreadSidebar";
import { BrandMark } from "@/components/site/BrandMark";
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
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@/components/ui/sheet";
import { initialsFromEmail } from "@/lib/initials";
import { useThreadStore } from "@/lib/thread-store";

const PRIMARY_NAV = [
	{ href: "/knowledge-hub", label: "Knowledge Hub", Icon: BookOpen },
	{ href: "/generator", label: "Generator", Icon: FileText },
] as const;

const SIDEBAR_STATE_KEY = "npxai-app-sidebar-collapsed";

const ICON_BTN =
	"inline-flex items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

export function AppShell({
	children,
	userEmail,
}: {
	children: ReactNode;
	userEmail: string | null;
}) {
	const [mobileOpen, setMobileOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(false);

	useEffect(() => {
		try {
			setCollapsed(window.localStorage.getItem(SIDEBAR_STATE_KEY) === "1");
		} catch {}
	}, []);

	const toggleCollapsed = () =>
		setCollapsed((v) => {
			const n = !v;
			try {
				window.localStorage.setItem(SIDEBAR_STATE_KEY, n ? "1" : "0");
			} catch {}
			return n;
		});

	return (
		<div className="flex h-dvh w-full gap-2 overflow-hidden bg-bg p-2 text-fg">
			<aside
				aria-label="App sidebar"
				className={`hidden shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface transition-[width] duration-200 md:flex ${
					collapsed ? "w-14" : "w-60"
				}`}
			>
				<AppSidebarContent
					userEmail={userEmail}
					collapsed={collapsed}
					onToggleCollapse={toggleCollapsed}
				/>
			</aside>

			<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
				<SheetContent
					side="left"
					className="w-72 border-r border-border bg-surface p-0"
				>
					<SheetTitle className="sr-only">Navigation</SheetTitle>
					<SheetDescription className="sr-only">
						Primary navigation and account controls.
					</SheetDescription>
					<AppSidebarContent
						userEmail={userEmail}
						collapsed={false}
						onNavigate={() => setMobileOpen(false)}
					/>
				</SheetContent>
			</Sheet>

			<main className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<header className="flex h-11 shrink-0 items-center gap-2 rounded-xl border border-border bg-surface px-3 mb-3 md:hidden">
					<button
						type="button"
						aria-label={mobileOpen ? "Close menu" : "Open menu"}
						onClick={() => setMobileOpen(true)}
						className={`${ICON_BTN} h-9 w-9`}
					>
						<Menu className="h-4 w-4" aria-hidden="true" />
					</button>
					<Link
						href="/"
						className="flex items-center gap-2 text-sm font-semibold tracking-tight text-fg"
					>
						<BrandMark className="h-5 w-5" />
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

	// One header action button: Expand (collapsed), Close (mobile), or Collapse (desktop expanded).
	const action = collapsed
		? onToggleCollapse && {
				on: onToggleCollapse,
				aria: "Expand sidebar",
				Icon: PanelLeftOpen,
				size: "h-8 w-8",
			}
		: onNavigate
			? { on: onNavigate, aria: "Close menu", Icon: X, size: "h-8 w-8" }
			: onToggleCollapse
				? {
						on: onToggleCollapse,
						aria: "Collapse sidebar",
						Icon: PanelLeftClose,
						size: "h-7 w-7",
					}
				: null;

	return (
		<div className="flex h-full flex-col">
			<div
				className={`flex shrink-0 border-b border-border ${
					collapsed
						? "flex-col items-center gap-2 px-2 py-2"
						: "h-12 items-center justify-between px-3"
				}`}
			>
				{collapsed ? (
					<Link
						href="/"
						aria-label="NPXai Demo — home"
						title="NPXai Demo"
						className="flex size-7 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					>
						<BrandMark className="h-7 w-7" />
					</Link>
				) : (
					<Link
						href="/"
						onClick={onNavigate}
						className="flex items-center gap-2 rounded-md text-sm font-semibold tracking-tight text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					>
						<BrandMark className="h-6 w-6" />
						<span>NPXai Demo</span>
					</Link>
				)}
				{action ? (
					<button
						type="button"
						aria-label={action.aria}
						onClick={action.on}
						className={`${ICON_BTN} ${action.size}`}
					>
						<action.Icon className="h-4 w-4" aria-hidden="true" />
					</button>
				) : null}
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
							className={`flex items-center gap-2 rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
								collapsed ? "justify-center p-2" : "px-2.5 py-2"
							} ${
								active
									? "bg-brand font-medium text-white shadow-sm hover:bg-brand-hover"
									: "text-fg-muted hover:bg-surface-2 hover:text-fg"
							}`}
						>
							<Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
							<span className={collapsed ? "sr-only" : undefined}>{label}</span>
						</Link>
					);
				})}
			</nav>

			{collapsed ? (
				<div className="flex-1" />
			) : (
				<ContextualRail pathname={pathname} onNavigate={onNavigate} />
			)}

			{collapsed ? (
				<div className="flex flex-col items-center gap-2 border-t border-border p-2">
					<CollapsedThemeCycle />
					{userEmail ? (
						<CollapsedUserAvatar email={userEmail} />
					) : (
						<CollapsedSignIn />
					)}
				</div>
			) : (
				<div className="border-t border-border p-3">
					<p className="mb-3 text-[11px] leading-snug text-fg-muted">
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

// Pathname-aware contextual slot: fills the middle of the expanded sidebar
// with content tied to the active app. Knowledge Hub → thread history,
// Generator → recent reports. On other routes the rail collapses to an
// empty spacer so the footer stays pinned to the bottom.
function ContextualRail({
	pathname,
	onNavigate,
}: {
	pathname: string;
	onNavigate?: () => void;
}) {
	const threadsLoaded = useThreadStore((s) => s.loaded);

	let body: ReactNode = null;
	let label: string | null = null;
	if (pathname.startsWith("/knowledge-hub")) {
		label = "Threads";
		body = threadsLoaded ? (
			<ThreadSidebar onNavigate={onNavigate} />
		) : (
			<p className="px-5 py-3 text-xs text-fg-muted">Loading threads…</p>
		);
	} else if (pathname.startsWith("/generator")) {
		body = <RecentReports onNavigate={onNavigate} />;
	}

	if (!body) return <div className="flex-1" />;

	return (
		<div className="flex min-h-0 flex-1 flex-col border-t border-border">
			{label ? (
				<div className="px-5 pt-3 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
					{label}
				</div>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
		</div>
	);
}

const THEME_CYCLE = {
	light: { next: "dark", Icon: Sun, label: "Dark" },
	dark: { next: "system", Icon: Moon, label: "System" },
	system: { next: "light", Icon: Monitor, label: "Light" },
} as const;

function CollapsedThemeCycle() {
	const { theme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const active = (mounted ? theme : "system") ?? "system";
	const { next, Icon, label } =
		THEME_CYCLE[active as keyof typeof THEME_CYCLE] ?? THEME_CYCLE.system;
	return (
		<button
			type="button"
			aria-label={`Switch to ${label} theme`}
			title={`Theme: ${active} → ${label}`}
			onClick={() => setTheme(next)}
			className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface-2 text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
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
					className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full bg-brand text-white shadow-sm transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				>
					<LogIn className="h-4 w-4" aria-hidden="true" />
				</button>
			}
		/>
	);
}

function CollapsedUserAvatar({ email }: { email: string }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={`Account menu for ${email}`}
					title={email}
					className="flex size-8 items-center justify-center rounded-full bg-brand font-semibold text-[11px] text-white shadow-sm ring-1 ring-border transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				>
					{initialsFromEmail(email)}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent side="right" align="end" className="min-w-48">
				<DropdownMenuLabel className="truncate text-xs font-normal text-fg-muted">
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
