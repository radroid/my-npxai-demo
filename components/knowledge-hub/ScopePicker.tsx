"use client";

// Source selector — "which regulator's documents should answer this", picked
// the way a chat app's model is picked. Auto (default) routes by what the
// question names and falls back to CNSC; pinning keeps every question on one
// regulator until the user changes it. Reference-only catalogues (IAEA,
// AERB, Fukushima reports) are listed but not selectable, with the reason.
//
// Rendered next to the Chat/Artifact toggle in both surfaces. Options come
// from the server (lib/sources/config.ts getScopeOptions) — the client never
// decides what is searchable. Canonical token utilities only, so it reads in
// light and dark.

import { CheckIcon, ChevronDownIcon, LibraryIcon } from "lucide-react";
import { useEffect } from "react";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ScopeOptions } from "@/lib/sources/scope-options";
import { useSourceScope } from "@/lib/sources/scope-store";

function formatAsOf(asOf: string | null): string {
	return asOf ? `as of ${asOf}` : "";
}

export function ScopePicker({ options }: { options: ScopeOptions }) {
	const scope = useSourceScope((s) => s.scope);
	const setAuto = useSourceScope((s) => s.setAuto);
	const pin = useSourceScope((s) => s.pin);
	const setHistorical = useSourceScope((s) => s.setHistorical);
	const reconcile = useSourceScope((s) => s.reconcile);

	useEffect(() => {
		reconcile(options.collections.map((c) => c.id));
	}, [options, reconcile]);

	const pinned =
		scope.mode === "pinned"
			? options.collections.find((c) => c.id === scope.collection)
			: undefined;
	const triggerLabel = pinned ? pinned.label : "Auto";
	const defaultLabel =
		options.collections.find((c) => c.id === options.defaultCollection)
			?.label ?? options.defaultCollection.toUpperCase();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={`Sources: ${triggerLabel}${scope.historical ? ", including superseded editions" : ""}. Change sources`}
					className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1 font-medium text-fg text-xs transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				>
					<LibraryIcon aria-hidden="true" className="size-3.5 text-fg-muted" />
					<span className="text-fg-muted">Sources:</span>
					<span>{triggerLabel}</span>
					{scope.historical ? (
						<span className="rounded-full border border-warning/40 bg-warning/10 px-1.5 text-[10px] text-warning">
							+ superseded
						</span>
					) : null}
					<ChevronDownIcon
						aria-hidden="true"
						className="size-3.5 text-fg-muted"
					/>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				side="top"
				className="w-80 border-border bg-surface text-fg"
			>
				<DropdownMenuLabel className="text-fg-muted text-xs">
					Answer from
				</DropdownMenuLabel>
				<DropdownMenuItem
					onSelect={setAuto}
					className="flex items-start gap-2 focus:bg-surface-2"
				>
					<CheckIcon
						aria-hidden="true"
						className={`mt-0.5 size-4 shrink-0 ${scope.mode === "auto" ? "text-brand" : "invisible"}`}
					/>
					<span className="flex flex-col">
						<span className="font-medium text-sm">Auto</span>
						<span className="text-fg-muted text-xs">
							Uses the regulator your question names; otherwise {defaultLabel}.
							Compares only when you ask to compare.
						</span>
					</span>
				</DropdownMenuItem>
				{options.collections.map((c) => {
					const active = pinned?.id === c.id;
					return (
						<DropdownMenuItem
							key={c.id}
							onSelect={() => pin(c.id)}
							className="flex items-start gap-2 focus:bg-surface-2"
						>
							<CheckIcon
								aria-hidden="true"
								className={`mt-0.5 size-4 shrink-0 ${active ? "text-brand" : "invisible"}`}
							/>
							<span className="flex flex-col">
								<span className="font-medium text-sm">
									{c.label}{" "}
									<span className="font-normal text-fg-muted">
										· {c.region}
									</span>
								</span>
								<span className="text-fg-muted text-xs">{c.description}</span>
								<span className="text-fg-muted text-[11px]">
									{c.documents} document{c.documents === 1 ? "" : "s"}{" "}
									{formatAsOf(c.asOf)}
								</span>
							</span>
						</DropdownMenuItem>
					);
				})}
				<DropdownMenuSeparator className="bg-border" />
				<DropdownMenuCheckboxItem
					checked={scope.historical === true}
					onCheckedChange={(v) => setHistorical(v === true)}
					onSelect={(e) => e.preventDefault()}
					className="text-sm focus:bg-surface-2"
				>
					Include superseded editions
				</DropdownMenuCheckboxItem>
				{options.referenceOnly.length > 0 ? (
					<>
						<DropdownMenuSeparator className="bg-border" />
						<DropdownMenuLabel className="text-fg-muted text-xs">
							Reference only — not searchable
						</DropdownMenuLabel>
						{options.referenceOnly.map((r) => (
							<DropdownMenuItem
								key={r.id}
								disabled
								className="flex flex-col items-start gap-0 data-disabled:opacity-100"
							>
								<span className="text-fg-muted text-sm">
									{r.label} · {r.region}
								</span>
								<span className="text-fg-muted text-[11px]">
									{r.documents} catalogued · {r.reason}
								</span>
							</DropdownMenuItem>
						))}
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
