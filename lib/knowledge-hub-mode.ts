// Pure Chat/Artifact mode-reconciliation logic for the Knowledge Hub
// (item-1 slice 1.2, fix round 1 — ISSUE 1). Deliberately dependency-free
// (no React/assistant-ui imports) so it's testable without a DOM renderer;
// see scripts/test-frontend.ts.
//
// Why this exists: the Knowledge Hub thread sidebar (rendered by AppShell,
// OUTSIDE KnowledgeHubShell's mode-swapped surfaces) stays live regardless
// of mode — "New thread" and thread-switch triggers keep working even while
// the chat surface is `hidden` behind Artifact mode. Without this, clicking
// them mutates hidden thread state with zero visible feedback (the app
// reads as frozen). The fix: snap back to Chat mode whenever the active
// thread-list item id CHANGES, so the action the user just took becomes
// visible immediately.
//
// KnowledgeHubShell.tsx pairs this with a `useRef<string | undefined>`
// seeded from the FIRST render's thread id, so the initial mount always
// compares a value to itself here (returns false) — a user who deliberately
// opened Artifact mode is never yanked back to Chat for free.
export function shouldSnapToChatOnThreadChange(
	previousThreadId: string | undefined,
	nextThreadId: string | undefined,
): boolean {
	return previousThreadId !== nextThreadId;
}
