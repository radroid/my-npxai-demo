# CHAT-IMPROVEMENTS

Audit of the Knowledge Hub chat against [assistant-ui](https://github.com/assistant-ui/assistant-ui) canonical patterns (`@assistant-ui/react` + `@assistant-ui/react-ai-sdk`, AI SDK v5/v6).

**Scope.** Bring existing features (thread management, message persistence, preset prompts, composer, sidebar) into alignment with upstream best practices. **No new features.** The "new thread creation" flow is the area Raj flagged as lacking — it gets the deepest treatment (P0-A).

**What works today (don't regress).**
- Hybrid anon (localStorage) / signed-in (Supabase) persistence with explicit tier-crossing guards (`lib/thread-store.ts:108-121`).
- Append-only message persistence — only the tail diff is POSTed, not the full tree (`lib/thread-store.ts:223-246`).
- Append-only message log + JSONB content in Postgres — schema is simple and correct.
- Streaming UX — `text-delta` parts stream token-by-token; `data-sources` part is emitted at the end and rendered via `CitationSourcesProvider` (`app/api/knowledge-hub/query/route.ts:305-346`).
- Tier isolation: signed-in mode excludes `threads` + `messagesByThread` from `persist.partialize` (`lib/thread-store.ts:326`).
- Redis cache of answers keyed on normalized-query hash + prompt version (30 min TTL).

**What diverges from upstream canon (the body of this plan).**

---

## Priority summary

| ID    | Change                                                            | Impact | Effort | Risk |
|-------|-------------------------------------------------------------------|--------|--------|------|
| P0-A  | Kill pre-init + revert cleanup cron (zombie-row fix)              | High   | S      | Low  |
| P1    | Full adapter refactor (rolls P0-B + P1-A + P1-B + P2-B together)  | High   | L      | Med  |
| P2-A  | Migrate starter questions to `useAui({ suggestions })` + primitive| Low    | S      | Low  |
| P3-A  | Per-thread URLs (`/knowledge-hub/[threadId]`) for shareable state | Low    | M      | Low  |

**Revised after source dive (2026-04-17).** Originally P0-B (drop `key={runtimeKey}`) was listed as an independent change. Reading `node_modules/@assistant-ui/react-ai-sdk/dist/ui/use-chat/useChatRuntime.js`, it turns out `useChatRuntime` **already wraps itself in `useRemoteThreadListRuntime` internally** with an `InMemoryThreadListAdapter` (since we don't pass `cloud`). The `useChat` instance's `id` comes from `useAuiState((s) => s.threadListItem.id)` — which overrides whatever `id` we pass in. That means our `key={runtimeKey}` remount is not redundant — it is the only mechanism by which our sidebar's thread-switch translates into a useChat swap. Removing it without also providing our own `RemoteThreadListAdapter` would break thread switching.

Consequence: P0-B, P1-A, P1-B, P2-B are no longer independent — they are one coherent refactor (swap `useChatRuntime`'s internal in-memory thread-list for our own Supabase-backed adapter, which lets us drop the remount, move persistence to the history adapter, and rebuild the sidebar on primitives). Collapsed below as **P1** (the big refactor). P0-A and P2-A are still safe to ship standalone and land in the current commit.

---

## P0-A — Replace pre-init + daily cleanup with lazy `initialize()` on first send

**The anti-pattern we're running.** `KnowledgeHubShell.tsx:66-86` eagerly creates a server row for signed-in users the moment they load the page with no active thread. This produces zombie `chat_threads` rows for users who navigate away without typing, and we compensate with a daily `pg_cron` sweep (`supabase/migrations/20260417210000_cleanup_empty_chat_threads.sql`). `ThreadSidebar.tsx:26-37` does the same on every "+ New thread" click.

**Why this is an anti-pattern.** assistant-ui's canonical model is: new threads have status `"new"` and a client-only `__LOCALID_*` id. The server row is minted exactly once, lazily, via `adapter.initialize(localId)` — and only from two call sites:
1. `AssistantChatTransport.prepareSendMessagesRequest` awaits `threadListItem.initialize()` before sending the first user turn, substituting the canonical `remoteId` into the POST body (`packages/react-ai-sdk/src/ui/use-chat/AssistantChatTransport.ts:28`).
2. The `ThreadHistoryAdapter.append()` path awaits `initialize()` before writing the first message. The docs explicitly warn: "you must await thread initialization before saving messages. Failing to do so can cause the first message to be lost." (`custom-thread-list.mdx:226-259`).

`initialize()` is idempotent and transactional — all callers resolve to the same `remoteId`, so the two call sites collapse onto one server row. No zombies, no cron sweep, no pre-init race.

**Refactor steps.**
1. Delete `preInitInFlightRef` effect in `KnowledgeHubShell.tsx:66-86`. Keep only the "snap to most recent thread" branch if we still want returning users to land on their last thread — but implement it via `switchToThread(threads[0].id)` on the thread-list-runtime, not our Zustand setter.
2. Change `ThreadSidebar.tsx:onNew` to *not* POST to `/api/threads`. Just call `thread-list-runtime.switchToNewThread()` (or equivalent on our adapter); the server row mints itself on first send.
3. Route `/api/threads` POST now only runs when the transport or history adapter invokes it — both await `initialize()` under the hood. The handler itself doesn't change shape.
4. Revert migration `20260417210000_cleanup_empty_chat_threads.sql` — drop the function and the pg_cron schedule. The rationale in its header comment will no longer apply.
5. Update `lib/thread-store.ts:createThread` — it still supports the seeded-create path for anon users (create-on-first-send is still the right move there since anon thread ids are local-only), but the signed-in eager path can go.

**Trade-offs.**
- Returning users will land on a welcome screen instead of a blank composer. That's the intended UX (assistant-ui's own pattern) and it's not worse than today; the current pre-init is a bandage for a different problem (see P0-B).
- One gotcha: if we keep manually managing the thread list via Zustand (see P1-B before we commit to that), we need to port the `initialize()` transaction ourselves — the API surface is a `localId → Promise<remoteId>` cache with an in-flight dedupe. Reference: `packages/core/src/runtimes/remote-thread-list/remote-thread-state.ts:288-380`.

---

## P0-B — Stop remounting the runtime via `key={runtimeKey}`

**The anti-pattern we're running.** `KnowledgeHubShell.tsx:95` passes `key={runtimeKey}` to `AssistantRuntimeProvider`. Our Zustand store bumps `runtimeKey` on explicit thread switches and on "+ New thread" clicks (`lib/thread-store.ts:29-34`). Bumping `runtimeKey` forces the provider to unmount/remount, which re-runs `useChatRuntime` from scratch — destroying any in-flight stream and rebuilding the message tree from `seededMessages`.

**Why this is an anti-pattern.** `useChatRuntime` already handles per-thread isolation internally. It threads `threadListItem.id` into each AI SDK `useChat({ id, ... })` instance, so every thread gets its own message buffer automatically (`packages/react-ai-sdk/src/ui/use-chat/useChatRuntime.ts:69-77`). The docs are explicit: "do not manually remount via `key`" — it breaks the state machine, kills in-flight streams on switch, and bypasses the debounced agentic-flicker handling.

Our `runtimeKey` vs `activeId` split (`lib/thread-store.ts:29-34`) exists *precisely because* `onFinish` null→threadId would otherwise retrigger a remount mid-stream. If we stop remounting at all, the distinction dissolves.

**Refactor steps.**
1. Remove `runtimeKey` from the store entirely — delete field, remove selector in `KnowledgeHubShell.tsx:18`, drop the `key={runtimeKey}` prop.
2. Pass `activeThreadId` (or better, the thread-list-runtime's current id) as the `id` prop to `useChatRuntime`. The hook's own memoization handles per-thread identity — we don't.
3. Delete the `useThreadRuntime` extracted helper (`KnowledgeHubShell.tsx:133-149`) — fold its contents back into the main component body now that there's no "when does this reinstantiate" subtlety to isolate.
4. Audit every store action that currently bumps `runtimeKey` (`setActiveThread`, `createThread`, `deleteThread`, `setMode`) and strip those bumps. The thread-list-runtime (or our adapter, if we keep manual management per P1-B) owns thread-switching semantics now.

**Trade-offs.**
- This is load-bearing for the "first send doesn't stall" UX Raj saw. Combined with P0-A (lazy `initialize()`), the stall disappears because: (a) the transport blocks on `initialize()` *inside* the first send rather than us awaiting `createThread` before even mounting the runtime, and (b) the runtime never remounts so token-deltas stream into the same tree the user is watching.
- If we keep our custom Zustand thread-list management (P1-B unfinished), we still need *some* way to hand a "new thread signal" to the runtime. Either port `switchToNewThread` semantics into our store, or bite the bullet and do P1-B.

---

## P1-A — Move persistence from `onFinish` → `ThreadHistoryAdapter`

**The anti-pattern we're running.** `KnowledgeHubShell.tsx:99-113` calls `syncMessages(targetId, messages)` inside `useChatRuntime`'s `onFinish`. This writes the new user+assistant pair to the server. It works, but:
- `onFinish` fires once at stream completion. If the user sends multiple messages in quick succession (regeneration, rapid followups), we get overlapping fetches we don't debounce.
- Agentic flows (tool calls that loop) would hit `onFinish` between steps, producing partial writes. We don't have tools today, but the upstream pattern is tool-ready by design.
- We bypass the upstream race-safety: the history adapter's `append()` awaits `aui.threadListItem().initialize()` — this is the second half of the P0-A fix. Doing it in `onFinish` re-implements this race protection ourselves (badly — currently we don't await initialize at all because we pre-init).

**The canonical pattern.** Implement a `ThreadHistoryAdapter` and register it via `adapters.history` on `useChatRuntime`. The runtime invokes `append(message)` after each run settles, inside a one-tick `setTimeout` that absorbs agentic-step flickers (`packages/core/src/react/runtimes/external-store/useExternalHistory.ts:158-170`).

```ts
// lib/assistant-ui/history-adapter.ts (new file)
import type { ThreadHistoryAdapter } from "@assistant-ui/react";
import { useThreadStore } from "@/lib/thread-store";

export function useSupabaseHistoryAdapter(): ThreadHistoryAdapter {
  return {
    async load() {
      // Called on thread switch — returns the seeded message list.
      // Back this with our existing /api/threads/[id] GET.
    },
    async append(message) {
      // Called post-settle with a single new UIMessage.
      // POST to /api/threads/[id]/messages.
    },
  };
}
```

**Refactor steps.**
1. Create `lib/assistant-ui/history-adapter.ts` with `load()` (replaces current `loadMessages`) and `append()` (replaces current `syncMessages` tail-diff logic).
2. Pass it to `useChatRuntime({ adapters: { history: adapter } })`.
3. Delete the `onFinish` callback body in `KnowledgeHubShell.tsx:99-113`. Keep `autoTitle` — but route it through its own adapter method (e.g. `onRunSettled`) or leave it as a fire-and-forget effect subscribed to `useAuiState`.
4. Delete `syncMessages` + `loadMessages` from `lib/thread-store.ts`. The store's job shrinks to: thread list, active id, anon localStorage persistence.

**Trade-offs.**
- Anon users don't need `append()` — their messages live in Zustand persist. Guard the adapter with a mode check, or register two history adapters (one no-op for anon, one HTTP for signed-in). Cleanest: the adapter reads `mode` from the store and no-ops when anon.
- `autoTitle` is currently called from `onFinish` with the full message list. Reproducing this from within the history adapter needs access to the full thread — use `useAuiState((s) => s.thread.messages)` inside the adapter hook.

---

## P1-B — Adopt `RemoteThreadListAdapter` over manual Zustand thread-list sync

**What we have.** `lib/thread-store.ts` is a ~350-line Zustand store that re-implements what `useRemoteThreadListRuntime` provides natively: thread list fetch, optimistic rename/archive/delete, active-id tracking, mode handling.

**The canonical pattern.** Implement `RemoteThreadListAdapter` (docs: `apps/docs/content/docs/runtimes/custom/custom-thread-list.mdx`, reference implementation: `packages/core/src/react/runtimes/cloud/useCloudThreadListAdapter.tsx`). Wire it via `useRemoteThreadListRuntime({ runtimeHook: useChatRuntime, adapter })`. We get for free:
- Optimistic updates for rename/archive/delete (the reducer "throws to revert" — no manual refetch on error).
- The `"new"` → `"regular"` state machine and `initialize()` transaction (solves P0-A).
- Per-thread `useChat` isolation (solves P0-B).
- Debounced history adapter invocations (solves P1-A).

**Refactor steps (high-level — this is the biggest change).**
1. Create `lib/assistant-ui/thread-list-adapter.ts` implementing `RemoteThreadListAdapter`:
   - `list()` → GET `/api/threads`
   - `initialize(localId)` → POST `/api/threads` (returns `{ remoteId }`)
   - `rename(remoteId, title)` → PATCH `/api/threads/[id]`
   - `archive(remoteId)` / `unarchive(remoteId)` — stub for now, we don't archive today
   - `delete(remoteId)` → DELETE `/api/threads/[id]`
2. Add auth gating: anon users get a pure-local adapter (use `InMemoryThreadListAdapter` or a thin localStorage wrapper). Swap based on `mode` — done at the `AssistantRuntimeProvider` level, not inside the adapter.
3. Rewrite `KnowledgeHubShell` to compose: `useRemoteThreadListRuntime({ adapter, runtimeHook: () => useChatRuntime({ transport, adapters: { history } }) })`.
4. Shrink `lib/thread-store.ts` to just "what mode am I in" + anon localStorage hooks. Most of its current surface area dissolves into the adapter + runtime state.
5. `ThreadSidebar.tsx` continues reading from the store for the mode toggle, but the thread list + active-id reads shift to `useAuiState((s) => s.threadList.items)` etc. (full subscriptive API).

**Trade-offs.**
- Biggest refactor in this plan. Touches the store, both sidebars, shell. Worth doing as one PR after P0-A and P0-B land, so we're not refactoring while fixing.
- Once done, `lib/thread-store.ts` may not need to exist at all — the mode state can live in a React context or a `useSyncExternalStore` on a Supabase auth listener.

---

## P2-A — Migrate starter questions to `useAui({ suggestions })` + primitive

**What we have.** `components/assistant-ui/thread.tsx:99-183` hardcodes `STARTER_QUESTIONS`, renders them as a grid gated on `thread.isEmpty`, and injects via `api.composer().setText()` + `api.composer().send()` with a `launchedRef` single-shot guard.

**The canonical pattern (v0.14+).**

```tsx
useAui({
  suggestions: Suggestions([
    { prompt: "What are the CNSC requirements for shift turnover at a reactor facility?", label: "Shift turnover requirements" },
    // ...
  ]),
});

<ThreadPrimitive.Suggestions>
  {() => (
    <SuggestionPrimitive.Trigger send>
      <SuggestionPrimitive.Label />
    </SuggestionPrimitive.Trigger>
  )}
</ThreadPrimitive.Suggestions>
```

**Why migrate.** The old `<ThreadPrimitive.Suggestion prompt=".." send />` inline API is deprecated (`apps/docs/content/docs/(reference)/migrations/v0-14.mdx`). Our `launchedRef` guard is also redundant — `SuggestionPrimitive.Trigger` auto-disables when the thread is running, and the primitive's click semantics are idempotent by design.

**Refactor steps.**
1. Extract `STARTER_QUESTIONS` into a module-level constant (already is).
2. Register via `useAui({ suggestions: Suggestions(STARTER_QUESTIONS) })` inside `KnowledgeHubShell`.
3. Replace the `StarterQuestions` JSX in `thread.tsx` with `<ThreadPrimitive.Suggestions>{() => ...}</ThreadPrimitive.Suggestions>`.
4. Delete `launchedRef` — the primitive handles it.

**Trade-offs.**
- Our current implementation has a nice animation + responsive grid (`@md:grid-cols-2 nth-[n+3]:hidden`). We preserve that by rendering our own chrome inside the render-prop — the primitive gives us state, we still own the DOM.

---

## P2-B — Rebuild `ThreadSidebar` on `ThreadListPrimitive`

**What we have.** `ThreadSidebar.tsx` reads from Zustand directly and implements rename/delete/active-state imperatively (180 lines). Comment at `ThreadSidebar.tsx:3-8` notes this was done because assistant-ui's `<ThreadList />` was backed by `InMemoryThreadList`.

**Why revisit.** With `RemoteThreadListAdapter` in place (P1-B), the primitives are no longer in-memory — they wrap our adapter. The primitives give us:
- `ThreadListItemPrimitive.Root` with `data-active` auto-applied — one CSS rule replaces our `active ? "bg-surface-2" : ...` conditional.
- `ThreadListItemPrimitive.Rename` / `.Archive` / `.Delete` — optimistic updates already wired, auto-disable when capability is missing.
- `ThreadListPrimitive.New` — the "new thread" button, auto-disabled on a fresh thread.

**Refactor steps.**
1. After P1-B lands (depends on it).
2. Rewrite `ThreadSidebar` as a thin wrapper composing `ThreadListPrimitive.Root` → `ThreadListPrimitive.Items` (render-prop) → `ThreadListItemPrimitive.Root` → our existing DOM with `asChild`.
3. Keep our styling — the primitives are headless. We lose ~100 lines of state management; the visual result is identical.

**Trade-offs.**
- Depends on P1-B. Don't attempt before the adapter lands.
- Rename inline-edit is our UX choice — the primitive exposes `ThreadListItemPrimitive.RenameForm` but we can keep our `<input>` inside the `Rename asChild` slot.

---

## P3-A — Per-thread URLs (`/knowledge-hub/[threadId]`)

**What we have.** Active thread is entirely client-side state. Refresh lands you on whichever thread the store's `activeThreadId` resolves to. No shareable URLs.

**The upstream-supported pattern.** `useRemoteThreadListRuntime` accepts a `threadId` prop — "automatically switches to the specified thread when the prop changes" (`packages/core/src/runtimes/remote-thread-list/types.ts:56`). Feed it from `useParams()`, add a Next.js dynamic route.

**Refactor steps.**
1. Add `app/(app)/knowledge-hub/[threadId]/page.tsx` that re-exports the hub with `threadId` from `useParams`.
2. Inside `KnowledgeHubShell`, pass `threadId` to `useRemoteThreadListRuntime`.
3. When a user creates a new thread (lazy init resolves), `router.replace(/knowledge-hub/${remoteId})` to keep the URL in sync. Do this from an effect on the runtime's current id, not from an adapter callback.
4. Sidebar thread clicks become `<Link href={/knowledge-hub/${id}}>`.

**Trade-offs.**
- Breaks middleware auth semantics if our current `/knowledge-hub` path has route-level auth — verify the dynamic route inherits.
- Anon users have local-only ids. Either URL-scope to signed-in (anon stays client-state), or expose anon local ids in the URL too (low cost, they just won't work across sessions).
- Strictly UX polish. Not required for correctness.

---

## Execution order & commits

Suggested sequence, each a single PR:

1. **P0-A + P0-B together** — they share a root cause (`initialize()` race). Ship them in one commit so we're not in a half-fixed state.
   - Revert the cleanup-cron migration in the same PR.
   - Rollback plan: revert commit, re-push old migrations.
2. **P1-A** — history adapter. Small, strictly additive on top of P0. Easy to revert.
3. **P1-B** — the big Zustand → adapter refactor. Wait until P0/P1-A are soaking in prod for a day or two.
4. **P2-A** — suggestions migration. Independent of P1-B, do whenever.
5. **P2-B** — sidebar on primitives. Depends on P1-B.
6. **P3-A** — URLs. Last, optional.

Each PR must preserve:
- Anon user isolation (tier-crossing destroys state — current `setMode` logic).
- Append-only write semantics (no PUT-over-full-tree).
- Streaming UX (no buffered responses, no `onFinish`-only renders).
- The existing Redis cache on `/api/knowledge-hub/query` (unrelated to this refactor, but easy to break in passing).

---

## Citations — where the canonical guidance lives

- Custom thread list + lazy `initialize()` + race conditions: `assistant-ui/apps/docs/content/docs/runtimes/custom/custom-thread-list.mdx`
- AI SDK v6 wiring: `assistant-ui/apps/docs/content/docs/runtimes/ai-sdk/v6.mdx`
- Suggestions (v0.14 canonical API): `assistant-ui/apps/docs/content/docs/(docs)/guides/suggestions.mdx`
- v0.14 migration (render-function children, deprecated `components` prop): `assistant-ui/apps/docs/content/docs/(reference)/migrations/v0-14.mdx`
- ThreadList primitives: `assistant-ui/apps/docs/content/docs/primitives/thread-list.mdx`
- Composer primitives: `assistant-ui/apps/docs/content/docs/primitives/composer.mdx`
- Reference `RemoteThreadListAdapter` implementation: `assistant-ui/packages/core/src/react/runtimes/cloud/useCloudThreadListAdapter.tsx`
- Reference `ThreadHistoryAdapter` implementation: `assistant-ui/packages/core/src/react/runtimes/cloud/AssistantCloudThreadHistoryAdapter.ts`
- Transport + `initialize()` integration: `assistant-ui/packages/react-ai-sdk/src/ui/use-chat/AssistantChatTransport.ts:28`
- Per-thread `useChat` id wiring: `assistant-ui/packages/react-ai-sdk/src/ui/use-chat/useChatRuntime.ts:69-77`
- History adapter debounce: `assistant-ui/packages/core/src/react/runtimes/external-store/useExternalHistory.ts:158-170`
- Working examples: `assistant-ui/examples/with-custom-thread-list/`, `with-cloud/`, `with-cloud-standalone/`
