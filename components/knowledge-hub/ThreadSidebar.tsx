"use client";

// Custom thread sidebar for the Knowledge Hub (Phase 6B.persistence).
// Replaces assistant-ui's <ThreadList /> because that primitive is backed by
// an in-memory InMemoryThreadList — it resets on refresh and doesn't mirror
// server state. This sidebar reads from the hybrid thread-store (localStorage
// for anon, Supabase for signed-in) and dispatches switch / rename / delete
// through the store's actions.

import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { useThreadStore } from "@/lib/thread-store";

export function ThreadSidebar() {
	const threads = useThreadStore((s) => s.threads);
	const activeId = useThreadStore((s) => s.activeThreadId);
	const createThread = useThreadStore((s) => s.createThread);
	const setActiveThread = useThreadStore((s) => s.setActiveThread);

	const onNew = async () => {
		const id = await createThread();
		setActiveThread(id);
	};

	return (
		<div className="flex h-full flex-col gap-1">
			<button
				type="button"
				onClick={onNew}
				className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
			>
				<PlusIcon className="h-4 w-4" aria-hidden="true" />
				New thread
			</button>
			<ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto py-1">
				{threads.length === 0 ? (
					<li className="px-2 py-6 text-center text-xs text-[var(--text-muted)]">
						Threads you start will show up here.
					</li>
				) : (
					threads.map((t) => (
						<ThreadRow
							key={t.id}
							id={t.id}
							title={t.title}
							active={t.id === activeId}
						/>
					))
				)}
			</ul>
		</div>
	);
}

function ThreadRow({
	id,
	title,
	active,
}: {
	id: string;
	title: string;
	active: boolean;
}) {
	const setActiveThread = useThreadStore((s) => s.setActiveThread);
	const renameThread = useThreadStore((s) => s.renameThread);
	const deleteThread = useThreadStore((s) => s.deleteThread);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(title);

	const commit = async () => {
		const trimmed = draft.trim();
		if (trimmed && trimmed !== title) await renameThread(id, trimmed);
		setEditing(false);
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

	const onDelete = async () => {
		await deleteThread(id);
	};

	return (
		<li
			className={`group relative flex items-center gap-1 rounded-md ${
				active
					? "bg-[var(--surface-2)]"
					: "hover:bg-[var(--surface-2)]/50 focus-within:bg-[var(--surface-2)]/50"
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
					className="min-w-0 flex-1 rounded-md border border-[var(--accent-brand)] bg-[var(--bg)] px-2.5 py-1.5 text-sm text-[var(--text)] shadow-sm outline-none ring-2 ring-[var(--accent-brand)]/30 focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
					aria-label="Rename thread"
				/>
			) : (
				<button
					type="button"
					onClick={() => setActiveThread(id)}
					className={`min-w-0 flex-1 cursor-pointer truncate px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)] ${
						active
							? "font-medium text-[var(--text)]"
							: "text-[var(--text-muted)] hover:text-[var(--text)]"
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
						className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
					>
						<PencilIcon className="h-3.5 w-3.5" aria-hidden="true" />
					</button>
					<button
						type="button"
						aria-label="Delete thread"
						onClick={() => void onDelete()}
						className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--danger)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-brand)]"
					>
						<Trash2Icon className="h-3.5 w-3.5" aria-hidden="true" />
					</button>
				</div>
			) : null}
		</li>
	);
}
