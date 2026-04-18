"use client";

import { BookOpen, FileText, Home, Lightbulb, Menu, Scale, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";

type NavItem = {
	href: string;
	label: string;
	Icon: typeof Home;
	description?: string;
};

const PRIMARY_ITEMS: NavItem[] = [
	{ href: "/", label: "Home", Icon: Home },
	{ href: "/knowledge-hub", label: "Knowledge Hub", Icon: BookOpen },
	{ href: "/generator", label: "Shift Generator", Icon: FileText },
];

const CONCEPT_ITEMS: NavItem[] = [
	{
		href: "/insights",
		label: "Insights",
		Icon: Lightbulb,
		description: "Surfacing regulatory changes + precedent.",
	},
	{
		href: "/equivalency",
		label: "Equivalency",
		Icon: Scale,
		description: "Mapping requirements across jurisdictions.",
	},
];

// Mobile-only drawer. The desktop nav keeps the pill row in place.
// This consumes the whole WORKING_APPS + ConceptsMenu + ThemeToggle payload
// so the header row at < md can stay at: hamburger · brand · user/sign-in.
export function MobileNav() {
	const [open, setOpen] = useState(false);
	const close = () => setOpen(false);

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetTrigger asChild>
				<button
					type="button"
					aria-label="Open navigation menu"
					className="inline-flex h-11 w-11 items-center justify-center rounded-md text-fg transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand md:hidden"
				>
					<Menu className="h-5 w-5" aria-hidden="true" />
				</button>
			</SheetTrigger>
			<SheetContent
				side="left"
				className="w-[85vw] max-w-sm border-r border-border bg-surface p-0 text-fg"
			>
				<SheetHeader className="flex flex-row items-center justify-between border-b border-border p-4">
					<SheetTitle className="text-base text-fg">Menu</SheetTitle>
					<SheetClose asChild>
						<button
							type="button"
							aria-label="Close navigation menu"
							className="inline-flex h-10 w-10 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						>
							<X className="h-5 w-5" aria-hidden="true" />
						</button>
					</SheetClose>
				</SheetHeader>

				<nav aria-label="Primary" className="flex flex-1 flex-col gap-6 overflow-y-auto p-4">
					<div className="flex flex-col gap-1">
						<p className="px-3 pb-1 text-xs font-medium uppercase tracking-[0.12em] text-fg-muted">
							Working demos
						</p>
						{PRIMARY_ITEMS.map(({ href, label, Icon }) => (
							<Link
								key={href}
								href={href}
								onClick={close}
								className="inline-flex min-h-11 items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							>
								<Icon className="h-4 w-4 text-fg-muted" aria-hidden="true" />
								<span>{label}</span>
							</Link>
						))}
					</div>

					<div className="flex flex-col gap-1">
						<p className="px-3 pb-1 text-xs font-medium uppercase tracking-[0.12em] text-fg-muted">
							Concepts
						</p>
						{CONCEPT_ITEMS.map(({ href, label, Icon, description }) => (
							<Link
								key={href}
								href={href}
								onClick={close}
								className="flex min-h-11 items-start gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							>
								<Icon
									className="mt-0.5 h-4 w-4 shrink-0 text-brand"
									aria-hidden="true"
								/>
								<span className="flex min-w-0 flex-col gap-0.5">
									<span className="text-sm font-medium text-fg">{label}</span>
									{description ? (
										<span className="text-xs text-fg-muted">{description}</span>
									) : null}
								</span>
							</Link>
						))}
					</div>

					<div className="flex flex-col gap-2 border-t border-border pt-4">
						<p className="px-3 pb-1 text-xs font-medium uppercase tracking-[0.12em] text-fg-muted">
							Theme
						</p>
						<div className="px-3">
							<ThemeToggle />
						</div>
					</div>
				</nav>
			</SheetContent>
		</Sheet>
	);
}
