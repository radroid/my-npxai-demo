"use client";

import { ChevronDown, Lightbulb, Scale } from "lucide-react";
import Link from "next/link";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Data lives in the client component because Server Components can't ship
// React component references (lucide icons) across the boundary. Small cost:
// a single place to edit concept-page entries.
const CONCEPT_ITEMS = [
	{
		href: "/insights",
		label: "Insights",
		description: "Concept for surfacing regulatory changes + precedent.",
		Icon: Lightbulb,
	},
	{
		href: "/equivalency",
		label: "Equivalency",
		description: "Concept for mapping requirements across jurisdictions.",
		Icon: Scale,
	},
] as const;

// Dropdown for the concept explainer pages. Hides Insights + Equivalency
// behind a single trigger so the primary CTAs (Knowledge Hub, Generator)
// don't have to compete for attention on the nav row.
export function ConceptsMenu() {
	const items = CONCEPT_ITEMS;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand data-[state=open]:bg-surface-2 data-[state=open]:text-fg"
				>
					<span>Concepts</span>
					<ChevronDown
						className="h-3.5 w-3.5 transition-transform data-[state=open]:rotate-180"
						aria-hidden
					/>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-72 p-1.5">
				{items.map(({ href, label, description, Icon }) => (
					<DropdownMenuItem key={href} asChild>
						<Link
							href={href}
							className="flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-sm"
						>
							<span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-brand">
								<Icon className="size-3.5" aria-hidden />
							</span>
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="font-medium text-fg">{label}</span>
								<span className="text-xs text-fg-muted">{description}</span>
							</span>
						</Link>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
