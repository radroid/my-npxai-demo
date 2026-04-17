"use client";

// Knowledge Hub thread sidebar — reads the thread list from the assistant-ui
// runtime via ThreadListPrimitive + useAuiState, dispatches switch/rename/
// delete through the ThreadListItem runtime so they flow into our custom
// RemoteThreadListAdapter (Supabase for signed-in, localStorage for anon).
// Replaces the prior direct-Zustand-store reads; no more runtimeKey remount
// on click.

import {
	ThreadListItemPrimitive,
	ThreadListPrimitive,
	useAui,
	useAuiState,
} from "@assistant-ui/react";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

export function ThreadSidebar({ onNavigate }: { onNavigate?: () => void }) {
	return (
		<ThreadListPrimitive.Root className="flex h-full flex-col gap-2 px-3 py-3">
			<ThreadListPrimitive.New asChild>
				<button
					type="button"
					onClick={() => onNavigate?.()}
					className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				>
					<PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
					New thread
				</button>
			</ThreadListPrimitive.New>
			<ul className="-mx-1 flex flex-col gap-0.5 overflow-x-hidden px-1">
				{/* px-1 leaves room for the rename-input's ring-2 which would
				    otherwise be clipped — the ancestor's overflow-y-auto coerces
				    overflow-x to auto per CSS spec and crops the ring. */}
				<ThreadListPrimitive.Items>
					{() => <ThreadRow onNavigate={onNavigate} />}
				</ThreadListPrimitive.Items>
				<EmptyHint />
			</ul>
		</ThreadListPrimitive.Root>
	);
}

// Placeholder row shown when the thread list is empty. The Items primitive
// simply renders nothing when length === 0, so we probe the list state via
// useAuiState and render the hint at the list level.
function EmptyHint() {
	const hasThreads = useAuiState((s) => s.threads.threadIds.length > 0);
	if (hasThreads) return null;
	return (
		<li className="px-2 py-2 text-xs text-fg-muted">
			Threads you start will show up here.
		</li>
	);
}

function ThreadRow({ onNavigate }: { onNavigate?: () => void }) {
	const aui = useAui();
	const title = useAuiState((s) => s.threadListItem.title) ?? "New thread";
	// Items are scoped by index inside ThreadListPrimitive.Items, so
	// s.threadListItem refers to THIS row. Compare its id against the main
	// thread id elsewhere in the state tree to know if it's the active one.
	const isActive = useAuiState(
		(s) => s.threadListItem.id === s.threads.mainThreadId,
	);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(title);

	const commit = async () => {
		const trimmed = draft.trim();
		setEditing(false);
		if (!trimmed || trimmed === title) return;
		if (aui.threadListItem.source === null) return;
		await aui.threadListItem().rename(trimmed);
	};

	const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			void commit();
		} else if (e.key === "Escape") {
			setDraft(title);
			setEditing(false);
		}
	};

	return (
		<ThreadListItemPrimitive.Root asChild>
			<li
				className={`group relative flex items-center gap-1 rounded-md ${
					isActive
						? "bg-surface-2"
						: "hover:bg-surface-2/50 focus-within:bg-surface-2/50"
				}`}
			>
				{editing ? (
					<input
						// biome-ignore lint/a11y/noAutofocus: rename flow — focusing the input IS the user's intent after clicking Rename
						autoFocus
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onFocus={(e) => e.currentTarget.select()}
						onBlur={() => void commit()}
						onKeyDown={onKey}
						// mx-0.5 leaves breathing room so ring-2 isn't clipped by the
						// sidebar's scroll container (overflow-y-auto on the ancestor
						// forces overflow-x: auto per CSS spec).
						className="mx-0.5 min-w-0 flex-1 rounded-md border border-brand bg-bg px-2.5 py-1.5 text-sm text-fg shadow-sm outline-none ring-2 ring-brand/30 focus-visible:ring-2 focus-visible:ring-brand"
						aria-label="Rename thread"
					/>
				) : (
					<ThreadListItemPrimitive.Trigger asChild>
						<button
							type="button"
							onClick={() => onNavigate?.()}
							className={`min-w-0 flex-1 cursor-pointer truncate px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
								isActive ? "font-medium text-fg" : "text-fg-muted hover:text-fg"
							}`}
							title={title}
						>
							<span
								// Remount when the title text changes so the fade-in animation
								// replays — this is the "thread renamed" cue for auto-titling.
								key={title}
								className="fade-in slide-in-from-left-1 inline-block animate-in duration-300"
							>
								{title}
							</span>
						</button>
					</ThreadListItemPrimitive.Trigger>
				)}
				{!editing ? (
					<div className="mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
						<button
							type="button"
							aria-label="Rename thread"
							onClick={() => {
								setDraft(title);
								setEditing(true);
							}}
							className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-fg-muted transition-colors hover:bg-surface hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						>
							<PencilIcon className="h-3.5 w-3.5" aria-hidden="true" />
						</button>
						<ThreadListItemPrimitive.Delete asChild>
							<button
								type="button"
								aria-label="Delete thread"
								className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-fg-muted transition-colors hover:bg-surface hover:text-danger focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							>
								<Trash2Icon className="h-3.5 w-3.5" aria-hidden="true" />
							</button>
						</ThreadListItemPrimitive.Delete>
					</div>
				) : null}
			</li>
		</ThreadListItemPrimitive.Root>
	);
}
