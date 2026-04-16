# Agent Rules

Rules for agents working in this repo. Only essential, repeatedly-relevant rules belong here. Project context lives in `README.md`.

## Rules

- Use **Bun** as the package manager. Never run `npm`, `yarn`, or `pnpm`. Use `bun install`, `bun add`, `bun dev`, `bunx`.
- **Assume the dev server is already running.** Do not start, restart, or kill it.
