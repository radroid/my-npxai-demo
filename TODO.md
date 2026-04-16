# TODO.md

Actionable task list for the NPX demo sprint. **Aligned with [PLAN.md](./PLAN.md)**. Broken into two sections:

- **👤 For Humans (Raj)** — tasks that need credentials, external accounts, human judgment, or real-world actions (recording video, sending outreach).
- **🤖 For Agents** — tasks that can be completed by an AI agent working in the repo (code, scaffolding, config).

Legend: `[ ]` todo · `[x]` done · `[~]` in progress · `[!]` blocked (explain in sub-bullet)

> **Rule for everyone:** when you finish a task, flip the checkbox. If a new task emerges mid-sprint, add it to the right section under the right phase. Do not delete completed tasks — strike them through by marking `[x]` so history is preserved.

---

## 👤 For Humans (Raj)

### Phase 1 — Setup (Thu Apr 16)
- [x] Create Supabase project at supabase.com
- [x] Run Appendix A.1 (pgvector extension) in Supabase SQL editor
- [x] Run Appendix A.2 (tables + indexes)
- [x] Run Appendix A.3 (RLS + revokes) — **critical: without this, anon has direct table access**
- [x] Run Appendix A.4 (RPC functions + grants)
- [x] Run Appendix A.6 (profiles table + auth trigger + `get_user_tier` RPC)
- [ ] Supabase dashboard → Auth → Providers → Email: enable the provider and confirm magic-link / Email OTP is the sign-in mode
- [x] Supabase dashboard → Auth → URL Configuration: set Site URL (localhost now, swap to production URL on Phase 5) and add `/auth/callback` under Redirect URLs
- [x] Supabase dashboard → Auth → Email Templates → **Magic Link** template: sanity-check the subject line + from address. Default is fine for the demo; personalize later if desired.
- [x] Run `bunx wrangler login` to authenticate Cloudflare
- [x] Create `.env.local` at repo root with:
  - `OPENAI_API_KEY`
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` (used by route handlers + client)
  - `SUPABASE_SERVICE_ROLE_KEY` (used **only** by offline ingestion script)
  - `UPSTASH_REDIS_REST_URL`
  - `UPSTASH_REDIS_REST_TOKEN`
- [x] Create Upstash Redis database at console.upstash.com (free tier is enough — ~10k commands/day)
- [x] Set an OpenAI usage budget alert at $10 in the OpenAI dashboard (belt + braces with the in-app circuit breaker)
- [x] Confirm `.env.local` is in `.gitignore` (it should be by default, but verify)
- [x] Kick off the Cowork scraping task — hand it Appendix C (C.1 doc list, C.2 etiquette, C.3 parsing, C.4 chunking, C.5 embedding, C.6 verification). Minimum acceptable output: Tier 1 (5 docs) fully ingested and queryable via `match_regdoc_chunks`.
- [x] Confirm `.env.local` exists so the agent can wire up the backend (never paste keys into chat — just confirm presence)

### Phase 2 — Scaffolding (Fri Apr 17)
- [ ] Review agent's assistant-ui integration in browser, confirm dark navy theme looks right
- [ ] Review agent's Appendix F seed data — confirm CANDU parameters, values, and shift-log narrative ring true, or flag corrections. If approved, no action needed; agent will run `bun run seed:plant` to apply.
- [ ] Test the sign-in modal once agent wires it up: enter your Gmail → receive magic link → click → land on Knowledge Hub → confirm nav shows you signed in. Flag any UX friction before outreach.

### Phase 3 — RAG pipeline (Sat Apr 18)
- [ ] Verify Cowork scraping completed; confirm chunk count in Supabase
- [ ] Run the 20-question eval battery in Appendix E (manually or via `bun run eval:kb`) — flag any failing adversarial Q as a blocker
- [ ] Judge RAG quality against the MVP bar (≥14/20) and ship bar (≥17/20); decide whether to add hybrid search or tune chunk count

### Phase 4 — Full build (Sun Apr 19)
- [ ] Review Knowledge Hub polish (citations, badges, starter questions, mobile)
- [ ] Approve Generator output format for shift turnover reports
- [ ] Review the Appendix G design system (colors, type, states, a11y). If OK, no action; agent will implement. If NPX has specific brand assets (logo SVG, exact palette from their site), hand them over to override tokens.

### Phase 5 — Polish + ship (Mon Apr 20)
- [ ] After deploy, update Supabase dashboard → Auth → URL Configuration → Site URL to the production URL (and add it to Redirect URLs). Otherwise magic links will redirect to localhost.
- [ ] Cross-device manual test (iPhone + tablet + desktop) — exercise both anon path and signed-in path
- [ ] Run `bunx wrangler deploy` (or approve agent doing it) and verify live URL
- [ ] Set up basic analytics (so you know when NPX team visits)
- [ ] **Record 90-second Loom video** — follow shot list + script in Appendix I.1. Do the pre-warm query + two takes. Replace `{LOOM_URL}` etc. in the outreach drafts once uploaded.
- [ ] Personalize the Appendix I.2 outreach drafts (Kshitij, Bharath, Margaret, info@ email) — tune tone in your voice, add {LOOM_URL} / {DEMO_URL} / {REPO_URL}

### Tuesday Apr 21 — Outreach
- [ ] 9 AM — LinkedIn DM to Kshitij Ahuja
- [ ] 11 AM — LinkedIn DM to Bharath Nangia
- [ ] 2 PM — Email info@npxinnovation.ca
- [ ] 3 PM — Apply to Senior Full Stack Developer role
- [ ] Next day — LinkedIn DM to Margaret McBeath

---

## 🤖 For Agents

> Before starting any task below, read `PLAN.md` to confirm the current phase and any scope changes. Do NOT attempt anything in the Human section above.

### Phase 1 — Setup (Thu Apr 16)
- [x] `bun add @supabase/ssr` — cookie-aware Supabase client for App Router route handlers
- [x] Create `lib/supabase.ts` helper — exports a server-side Supabase client built with **`NEXT_PUBLIC_SUPABASE_ANON_KEY`** only, cookie-aware via `@supabase/ssr`. Must NOT import or reference `SUPABASE_SERVICE_ROLE_KEY`. All access goes through the RPCs from Appendix A.4 + A.6.
- [x] Create `lib/supabase-browser.ts` — browser client (anon key + session from cookies) for the sign-in modal
- [ ] Create `scripts/ingest.ts` (separate entry point) — uses `SUPABASE_SERVICE_ROLE_KEY` for bulk chunk inserts during ingestion. Lives outside `app/` so it's never bundled into the runtime build. Consumes the pre-parsed JSON under `scraped_regdocs/` (one file per REGDOC, schema: `{regdoc_id, title, url, sections[{section_number, section_title, anchor, paragraphs:[{text, requirement_type}]}]}`), reconstructs section text, applies Appendix C.4 chunking (400 tokens, 60-token overlap, sentence-aware, one chunk per section boundary), C.5 embedding batching + retries, batched `INSERT` into `regdoc_chunks` (1000 rows/statement per Supabase batch-insert guidance), and C.6 verification output.
- [ ] Run the ingestion: `bun run ingest` against the Supabase project populates `regdoc_chunks` from all 19 files in `scraped_regdocs/`. Acceptance: `SELECT count(*) FROM regdoc_chunks` returns > 1500 chunks; `SELECT count(*) FROM regdoc_chunks WHERE embedding IS NULL` returns 0; a smoke `match_regdoc_chunks` RPC call for "shift turnover" returns rows citing `REGDOC-2.3.4`. Script is idempotent — on rerun it TRUNCATEs `regdoc_chunks` first (it's derived data, safe to regenerate).
- [x] Add `grep` guard to pre-deploy check: fail the build if `SUPABASE_SERVICE_ROLE_KEY` appears under `app/` *(lives in `scripts/preflight.ts`, wired as `bun run preflight`)*
- [x] Create `lib/openai.ts` helper (configured OpenAI client)
- [x] Add `@upstash/ratelimit` + `@upstash/redis` to dependencies (`bun add @upstash/ratelimit @upstash/redis`)
- [x] Create `lib/guard.ts` — wraps route handlers with per-route rate limits (Appendix B.1), input validation (B.2), and the global daily circuit breaker (B.4). Resolves client IP per B.1 ordering **and** reads the authenticated user via `supabase.auth.getUser()`; if present, calls `get_user_tier()` RPC once per request and uses the tiered bucket formula in Appendix J.5 (`rl:{route}:{identifier}`). Also picks tier-scaled input-char cap (B.2) and output `max_tokens` (B.3).
- [x] Create `lib/validators.ts` — zod schemas for query body, generator inputs, thread/message IDs (Appendix B.2)
- [x] Pre-deploy secrets scan script — Appendix B.5 grep, exit non-zero on any hit. Hook into `bun run build` or a lint step. *(`scripts/preflight.ts`, wired as `bun run preflight`)*
- [x] Set same-origin CORS headers in every route handler (Appendix B.6) *(no `Access-Control-Allow-Origin` emitted; same-origin end-to-end per B.6)*
- [x] Scaffold route handler stubs under `app/api/`:
  - [x] `app/api/knowledge-hub/query/route.ts` (empty handler returning 501 for now)
  - [x] `app/api/generator/plant-status/route.ts`
  - [x] `app/api/generator/work-orders/route.ts`
  - [x] `app/api/generator/turnover/route.ts`
  - [x] `app/auth/callback/route.ts` — exchanges the magic-link code for a session cookie via `@supabase/ssr`, then redirects to `/knowledge-hub` (Appendix J.3 step 4)
  - [x] `app/auth/signout/route.ts` — `supabase.auth.signOut()`, clear cookies, redirect to `/`
- [x] **Do NOT** create `app/api/chat/threads/route.ts` — threads are localStorage-only per the 2026-04-16 decision. If assistant-ui starter scaffolded this file, delete it. *(verified absent; starter's `/api/chat/route.ts` is the streaming endpoint, not threads — left in place for now, gets reworked in Phase 2)*
- [x] Create `lib/thread-store.ts` — zustand store with `persist` middleware targeting localStorage for Knowledge Hub thread list + message history
- [x] Create `.env.example` at repo root with placeholder values for all 6 env vars (OPENAI_API_KEY, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN) — zero real secrets
- [x] Create placeholder page shells:
  - [x] `app/knowledge-hub/page.tsx`
  - [x] `app/generator/page.tsx`
  - [x] `app/insights/page.tsx`
  - [x] `app/equivalency/page.tsx`
- [ ] Configure `open-next.config.ts` for Cloudflare deployment - use domain 'npx.curlycloud.dev'
- [ ] Write `app/globals.css` CSS variables per Appendix G.1 — G.3 (colors, typography, spacing, radii). All component styles reference tokens; zero hex values in components.
- [ ] Load Inter + JetBrains Mono via `next/font` (self-hosted, no runtime CDN)

### Phase 2 — Scaffolding (Fri Apr 17)
- [ ] Wire assistant-ui (`ThreadListSidebar` + `Thread`) into `app/knowledge-hub/page.tsx`
- [ ] Build custom runtime adapter pointing to `/api/knowledge-hub/query`
- [ ] Test send/receive round-trip with a mock response
- [ ] Build top nav component (Logo + Why NPX AI? | Features | FAQ | Contact | Sign In / profile chip when authed)
- [ ] Build sign-in modal per Appendix J.6 — email input, `supabase.auth.signInWithOtp({ email, options: { emailRedirectTo } })`, loading/success/error states, a11y (role="dialog", focus trap, `aria-live` status, returns focus on close), full-screen on mobile
- [ ] Build footer component with "Built by Raj Dholakia as a demonstration for NPX Innovation"
- [ ] Write `seeds/bruce-power.sql` implementing Appendix F (≈50 plant_status rows, ≈12 work_orders, ≈15 shift_log_entries). Use `now() - interval '<N> minutes'` for timestamps so data feels fresh per demo.
- [ ] Wire `bun run seed:plant` script (executes `seeds/bruce-power.sql` via Supabase connection) — uses `SUPABASE_SERVICE_ROLE_KEY` since it's a one-shot ingestion like chunk insert

### Phase 3 — RAG pipeline (Sat Apr 18)
- [x] Create `lib/prompts.ts` — export `KNOWLEDGE_HUB_SYSTEM` (Appendix D.1 verbatim), `GENERATOR_SYSTEM` (D.4 verbatim), `PROMPT_VERSION` constant. *(done early in Phase 1; was originally Phase 3)*
- [x] Create `lib/context-envelope.ts` — wraps retrieved chunks in `<context_snippet>` tags per D.2 with HTML-entity escaping on body. *(done early in Phase 1; was originally Phase 3)*
- [x] Create `lib/output-guard.ts` — D.6 output validation: deny-list scan, truncate-on-hit, hashed-IP logging. *(done early in Phase 1; was originally Phase 3)*
- [x] Create `lib/logger.ts` — structured JSON logger per Appendix H.6; exports `logRequest()`, `logGuardEvent()`, `hashIp(ip)` **and `hashUser(userId)`** (same daily-salt rotation). Every request log includes `tier` (anon | signed_in | npx_circle); authenticated requests additionally include `user_hash`.
- [ ] Verify `@assistant-ui/react-markdown` + `remark-gfm` config has raw-HTML passthrough disabled. If enabled by default, explicitly disable.
- [ ] Implement `/api/knowledge-hub/query/route.ts`:
  - [ ] Wrap handler with `withGuard()` from `lib/guard.ts` (rate limit + validation + circuit breaker per Appendix B)
  - [ ] Embed user query with `text-embedding-3-small`
  - [ ] Call `match_regdoc_chunks(query_embedding, 8, 0.3)` RPC (Appendix A.4) via anon client — no raw table SQL
  - [ ] Apply retrieval fallback thresholds per D.3 (early-return without LLM on top-1 < 0.50)
  - [ ] Wrap retained chunks using `lib/context-envelope.ts` (D.2) — HTML-escape bodies
  - [ ] Stream from `gpt-4o-mini` with `KNOWLEDGE_HUB_SYSTEM`, `max_tokens: 800`, and the output guard (D.6) in the token pipeline
- [ ] Handle out-of-corpus / ambiguous queries gracefully (fallback rules from Appendix D.3 + verified against Appendix E questions 14–16, 20)
- [ ] Create `evals/knowledge-hub.jsonl` from Appendix E.1 (one JSON object per question, matching the extended E.3 format: `must_cite`, `must_cite_section`, `must_contain_any`, `must_contain_all_from_group`, `min_group_hits`, `must_not_contain`). Pull the exact section numbers and grounded phrases from Appendix E.5, not from memory.
- [ ] Create `scripts/eval-kb.ts` — runs the battery against the local/deployed endpoint, grades per the E.4 order (status → behavior → citations → sections → keywords → group hits → deny list → latency), prints pass/fail table, exits non-zero on anything that violates the ship bar (≥17/20 AND all 3 adversarial pass)
- [ ] Wire `bun run eval:kb` into `package.json` scripts
- [ ] Add tier-aware integration tests: (a) 6th anon KH query/day → 429; (b) 51st signed_in KH query/day → 429; (c) 1400-char query succeeds as signed_in, fails 400 as anon (per Appendix H.3 + J.10)
- [ ] Frontend: parse citation markers using the regex from Appendix D.5; render as clickable chips mapped to retrieved snippet metadata
- [ ] Frontend: "Sources" panel showing retrieved chunks
- [ ] Frontend: streaming response wired into assistant-ui Thread

### Phase 4 — Full build (Sun Apr 19)
**Knowledge Hub polish**
- [ ] Clickable citation badges per Appendix G.8 — pill shape, `--requirement`/`--guidance` color, tooltip with full REGDOC title + section
- [ ] Visual distinction: Requirement (`--requirement` blue) vs Guidance (`--guidance` amber) per G.1
- [ ] Suggested starter questions on empty state (use Appendix E Q1–5 as the defaults)
- [ ] "Browse REGDOCs" sidebar grouped by SCA category
- [ ] Mobile responsive per Appendix G.7 (ThreadListSidebar collapses below `md`)
- [ ] All four component states per Appendix G.4 (loading skeleton, empty, error, partial/degraded)
- [ ] Typing indicator + Abort button per Appendix G.5
- [ ] `role="log" aria-live="polite"` on thread scroll region (Appendix G.6)

**Generator demo**
- [ ] Build `/generator` page with Station / Unit / Shift selectors
- [ ] Implement `/api/generator/turnover/route.ts`:
  - [ ] Wrap handler with `withGuard()` (rate limit + enum validation + circuit breaker per Appendix B)
  - [ ] Call `get_turnover_snapshot(unit)` RPC (Appendix A.4) via anon client — no raw table SQL
  - [ ] Send to OpenAI using `GENERATOR_SYSTEM` (Appendix D.4) with `max_tokens: 1500` and the output guard (D.6)
  - [ ] Return structured report (Plant Status / Safety Systems / Work & Clearances / Key Events / Watch Items / Recommended Actions)
- [ ] Render report in clean, printable format
- [ ] Priority flags on items (safety-critical / attention / routine)

**Website shell**
- [ ] Homepage with NPXai-inspired hero + 4 feature cards + Why NPX AI? + email signup (UI-only)
- [ ] Static Insights page (explainer)
- [ ] Static Equivalency Evaluator page (explainer)
- [ ] FAQ page (inspired by npxai.com structure)

### Phase 5 — Polish + ship (Mon Apr 20)
- [ ] Responsive audit across all pages against Appendix G.7 breakpoints
- [ ] Token consistency pass — grep for hex colors in `app/**/*.tsx` and `components/**/*.tsx`; every match must be inside `globals.css` (zero-hex-in-components rule per G.1)
- [ ] Verify all four component states present wherever data renders (G.4 acceptance — audit each page)
- [ ] Accessibility pass per Appendix G.6 (focus rings, contrast, keyboard nav, `prefers-reduced-motion`)
- [ ] API response caching for repeated queries
- [ ] OpenGraph meta tags (preview image for LinkedIn/Slack)
- [ ] Pre-deploy: `bun run build` clean
- [ ] Pre-deploy: `bun run eval:kb` passes the ship bar (≥17/20, all adversarial Qs pass) per Appendix E.2
- [ ] Assist human with `bunx wrangler deploy` (agent can run it, human verifies)
- [ ] Post-deploy smoke test: `bun run eval:kb` (Appendix E) + Generator run for Unit 3 Evening (the demo "money shot" per Appendix F.5) + spot check other units/shifts
- [ ] Post-deploy sign-in smoke: in an incognito window, open the prod URL → click Sign In → enter Raj's email → receive and click magic link → land on `/knowledge-hub` with session cookie set → issue one query and confirm `tier` appears in the request log (Appendix H.5 + J.10)

### Ongoing / cross-phase
- [ ] Keep `PLAN.md` current phase updated when phase transitions happen
- [ ] Before advancing `Current phase`, verify the relevant Appendix H checklist is green
- [ ] Log notable decisions in `PLAN.md` decisions log
- [ ] Flag any scope creep or new blockers to the human in chat
- [ ] Every route handler uses `logRequest()` from `lib/logger.ts` — no ad-hoc `console.log` in route code
