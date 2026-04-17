# Agent Rules

Rules for agents working in this repo. Only essential, repeatedly-relevant rules belong here. Project context lives in `README.md`.

## Rules

- Use **Bun** as the package manager. Never run `npm`, `yarn`, or `pnpm`. Use `bun install`, `bun add`, `bun dev`, `bunx`.
- **Assume the dev server is already running.** Do not start, restart, or kill it.
- **Prefer CLIs over dashboards or ad-hoc drivers for external services.** For databases and deployment platforms (Supabase, Cloudflare, Vercel, etc.), use the official CLI (`supabase`, `wrangler`, `vercel`) for schema changes, migrations, env management, and deploys. Do not propose new npm drivers (`postgres.js`, `pg`) or "paste into the dashboard SQL editor" as the primary path. The CLIs give us versioned, replayable, scriptable operations; dashboard-paste is a last resort when no CLI command exists.
- **Every frontend change must work in BOTH light and dark themes.** The app ships both modes (`next-themes` + the shadcn `ThemeToggle`). Whenever you touch colors/backgrounds/borders/text:
  1. Reference semantic tokens from `app/globals.css` — never hardcoded hex values in components. Available tokens: `--bg`, `--surface`, `--surface-2`, `--text`, `--text-muted`, `--accent-brand`, `--accent-brand-hover`, `--requirement`, `--guidance`, `--success`, `--warning`, `--danger`, `--border`, `--border-strong`. Light values are in `:root`, dark values in `.dark`.
  2. Mentally verify each element in BOTH palettes before shipping. Special danger zone: white/colored text on colored backgrounds — these flip catastrophically if a token doesn't resolve or the contrast doesn't survive the theme swap.
  3. **Tailwind 4 CSS-variable syntax matters.** Write `bg-[var(--accent-brand)]` (explicit `var()`) or `bg-(--accent-brand)` (Tailwind 4 parentheses shorthand). Do NOT use the bracket-only form `bg-[--accent-brand]` — Tailwind 4 treats that as a literal token and the background silently fails to render, leaving white-on-white text in light mode. Same rule for `text-`, `border-`, `ring-`, `fill-`, `stroke-` arbitrary-value utilities.

## OVERNIGHT.md (sprint state, gitignored)

When Raj kicks off a multi-stage overnight or multi-day sprint, agent-side state (the brief verbatim, rule overrides, decisions taken autonomously, branch plan, metrics-in-flight) lives in `OVERNIGHT.md` at the repo root. It is gitignored — safe for orchestration notes that should not pollute the committed history.

On any session start: if `OVERNIGHT.md` exists, read it first. It captures what Raj said, what has been done, what remains, and any autonomous decisions the agent made. When committed files (PLAN.md, TODO.md, REFACTOR_METRICS.md) disagree with OVERNIGHT.md, trust OVERNIGHT for agent-side intent and the committed files for shipped state.

## PLAN.md + TODO.md workflow

This repo uses a shared-context system between the human (Raj) and agents. Two files coordinate work:

- **`PLAN.md`** — single source of truth for mission, current phase, stack, decisions, scope guardrails, and appendices (SQL schemas, scraping targets, question batteries, scripts). Source of alignment between human and agents.
- **`TODO.md`** — actionable checklist split into **👤 For Humans** and **🤖 For Agents** sections, organized by phase. Aligned with `PLAN.md`.

### At the start of every session
1. Read `PLAN.md` to learn the current phase, decisions, and scope guardrails.
2. Read `TODO.md` — specifically the **🤖 For Agents** section for the current phase — to know what's outstanding.
3. If the user's request is already captured as an agent task, proceed with it. If it belongs in the Humans section, surface that to the user instead of doing it yourself.

### While working
- When you pick up an agent task, flip it to `[~]` (in progress). When done, flip to `[x]`.
- **Never check off items in the 👤 For Humans section.** Those require real-world actions (creating accounts, running DB migrations in external consoles, recording videos, sending outreach). If progress on an agent task is blocked by a human task, mark it `[!]` with a sub-bullet naming the blocking human item.
- If the scope changes, the current phase advances, or a non-obvious decision is made, **update `PLAN.md`** (current phase section + decisions log). Keep entries one line each.
- If a new task emerges mid-work, add it to the correct section of `TODO.md` under the right phase. Do not silently do work that isn't tracked.
- Do not delete completed tasks — leave them `[x]` so history is preserved.

### What not to do
- Do not dump task lists into `PLAN.md` — tasks belong in `TODO.md`.
- Do not mark human tasks as complete based on your own actions. Only the human flips those.
- Do not invent work outside the scope guardrails in `PLAN.md` without first flagging it to the user.

## Decision priority

When making decisions during plan improvement or implementation, apply in order:
1. **Security first** — secrets handling, auth, data exposure, dependency risk, injection/XSS, cost-abuse surfaces.
2. **UX second** — clarity, error states, accessibility, responsiveness, loading feedback, empty states.
3. **Everything else third** — performance, cost, developer ergonomics, aesthetic polish.

For decisions that genuinely require human input (credentials, subjective brand calls, personal narrative, outreach tone), leave a clearly-marked bullet under a `## Needs human decision` section in `PLAN.md` instead of guessing. Keep the list short — if the bullet can be resolved by research, resolve it yourself.
