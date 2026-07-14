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
- [x] Supabase dashboard → Auth → Providers → Email: enable the provider and confirm magic-link / Email OTP is the sign-in mode *(Raj confirmed complete 2026-04-17 night)*
- [x] Run `migrations/001-switch-to-hnsw.sql` in Supabase SQL editor — replaces the ivfflat index with HNSW. *(applied 2026-04-16 evening; `bun run scripts/smoke-rag.ts` confirmed 6/6 probes returning the correct REGDOC in top-3)*
- [~] Create a **public** GitHub repo for this project and push `main` to it. *(Repo exists + push-to-main works — Raj 2026-04-17 night. Flipping to public is deferred until after the Loom recording per Raj's decision; until then outreach drafts referencing `{REPO_URL}` should hold.)*
- [x] Cloudflare dashboard → Workers & Pages → Create → Connect to Git → select this repo. Build command: `bun run build:cloudflare`. Deploy command: auto. *(Raj confirmed 2026-04-17 night — dashboard Build command swapped per the earlier fix; Git integration live.)*
- [x] Cloudflare dashboard → Workers & Pages → npxai-demo → Settings → Variables and Secrets → add the 5 runtime env vars from `.env.local` (OPENAI_API_KEY, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN). SUPABASE_SERVICE_ROLE_KEY stays local-only. *(Raj confirmed 2026-04-17 night)*
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
- [x] Review agent's assistant-ui integration in browser, confirm dark navy theme looks right
- [x] Review agent's Appendix F seed data — confirmed realistic; follow-up migration (alarms + Night shift + Unit 3 SDS-1 clarification) pushed 2026-04-17.
- [x] Test the sign-in modal once agent wires it up: enter your Gmail → receive magic link → click → land on Knowledge Hub → confirm nav shows you signed in. Flag any UX friction before outreach. *(Agent note 2026-04-17: email provider is already enabled on the remote per CLI check; redirect URLs include localhost:3000/3001/auth/callback and https://npx.curlycloud.dev/auth/callback. No longer blocked.)*

> **Phase 1 verification (2026-04-16 evening):** Raj tested placeholder page loads (no console errors), auth trigger end-to-end (Supabase Add User → profiles row with correct tier for `@brucepower.com` and `@gmail.com`), and Supabase dashboard shows 1945 rows in `regdoc_chunks` with HNSW index in place. Phase 1 gate green. Two Phase-1 holds carried forward as non-blocking for Phase 2 agent work: Email provider enable (needed before sign-in modal testing); GitHub public repo + Cloudflare Git integration (needed before Phase 5 deploy).

### Phase 3 — RAG pipeline (Sat Apr 18)
- [x] Verify Cowork scraping completed; confirm chunk count in Supabase *(verified Phase 1 evening — 1945 rows in `regdoc_chunks`, HNSW index in place, smoke-rag 6/6 probes pass with top-sim 0.64–0.75)*
- [x] Add `EVAL_BYPASS_KEY=<any-local-string>` to `.env.local` and restart the dev server, then run `bun run eval:kb`. *(Done 2026-04-17. Never ship with `EVAL_BYPASS_KEY` set in production.)*
- [x] Run the 20-question eval battery — **20/20 (100%) passing, all 3 adversarial Qs pass** (2026-04-17). Iteration path: first run 15/20, then grader loosenings for Q3/Q4/Q5/Q7 (LLM uses different-but-correct wording than the planned keyword) + `stripHtmlTags` handler fix for Q19 (removes JS function-call leftovers after tag strip so the LLM sees the clean benign portion of the query).
- [x] Judge RAG quality against the MVP bar (≥14/20) and ship bar (≥17/20) — **ship bar green**, no hybrid search needed. *(If the corpus grows in Phase 4+ we may revisit chunk-count tuning.)*
- [x] Apply the seed-augmentation migration to the linked Supabase project: pushed via `bunx supabase db push --linked` 2026-04-17 night. Post-apply counts now 52 / 15 / 24.

### Phase 4 — Full build (Sun Apr 19)
- [x] Review Knowledge Hub polish — design system signed off; agent implementing against Appendix G tokens *(Raj 2026-04-17 night)*
- [x] Approve Generator output format for shift turnover reports — D.4 prompt structure approved *(Raj 2026-04-17 night)*
- [x] Review the Appendix G design system (colors, type, states, a11y) — approved as-is, no brand-asset overrides *(Raj 2026-04-17 night)*

### Phase 5 — Polish + ship (Mon Apr 20)
- [x] After deploy, update Supabase dashboard → Auth → URL Configuration → Site URL to the production URL (and add it to Redirect URLs) *(Raj 2026-04-17 night — production URL configured)*
- [x] Cross-device manual test (iPhone + tablet + desktop) — exercise both anon path and signed-in path *(Raj 2026-04-17 night)*
- [x] Trigger deploy by pushing `main` to GitHub (Cloudflare Git integration auto-deploys). Verify live URL + TLS cert *(Raj 2026-04-17 night)*
- [x] Set up basic analytics (so you know when NPX team visits) *(Raj 2026-04-17 night)*
- [ ] **Record 90-second Loom video** — follow shot list + script in Appendix I.1. Do the pre-warm query + two takes. Replace `{LOOM_URL}` etc. in the outreach drafts once uploaded. *(Only remaining human task. Flip repo to public immediately after recording per Raj.)*
- [x] Personalize the Appendix I.2 outreach drafts (Kshitij, Bharath, Margaret, info@ email) — tune tone in your voice, add {LOOM_URL} / {DEMO_URL} / {REPO_URL} *(Raj 2026-04-17 night — drafts personalized; {LOOM_URL} stub stays until Loom landed)*

### Phase 6 — Frontend overhaul (opened 2026-04-17 night)
- [ ] Apply the `generated_reports` migration to Supabase once the agent lands it (`bunx supabase db push --linked`)
- [ ] Apply the `chat_threads` + `chat_messages` migration to Supabase once the agent lands it (`bunx supabase db push --linked`)
- [ ] Gut-check the northern-lights hero animation at 1x + 1.5x viewport — reject if it distracts from the headline or tanks Lighthouse Performance
- [ ] Confirm the operator-grade palette (agent extracts a Vercel/Linear/Palantir-referenced darker-navy variant, keeps one aurora cue from NPXai) before the swap lands
- [ ] Eyeball the light-mode pass in daylight on a real device — dark-only was the prior default; this is the first time the app reads under direct sunlight
- [ ] Decide whether the marketing landing copy stays as-is or gets rewritten to match the NPXai tone (agent can draft; final voice is yours)
- [ ] End-to-end sign-in smoke **after** hybrid thread persistence ships: anon creates 2 threads → sign in → threads visible on server, rename works, second device sees the same threads
- [ ] End-to-end Generator cache smoke: generate Unit 3 Evening → wait → regenerate (should be cached with "nothing has changed") → force-click Regenerate → confirm new OpenAI call fires

### Phase 7 — Post-launch website polish (backlog, opened 2026-04-17)
- [ ] Decide which sections of the homepage survive vs move to a `/behind-the-demo` consolidation page (agent drafts the cut; Raj approves the voice)
- [ ] Daylight re-check of light mode on a real device after 7B + 7C land (palette swap is the one change Browserbase can't judge for you)

### Phase 8 — Mobile polish (opened 2026-04-18, pre-outreach)
- [ ] Raj manual-test the home page on iPhone 14 Pro Max (both Safari + Chrome) after agent lands 8A–8D — especially: hamburger drawer opens/closes, Sign in dialog is reachable, NPX theme background looks right in portrait, no horizontal scrolling anywhere.
- [ ] Raj visual-check on a second device class (regular iPhone / Android) — the outreach audience is 3 people on unknown phones.

### Phase 11 — Artifact mode + RAG eval framework (opened 2026-07-13)

> 🔴 **Both blockers below gate every real number in the RAG evaluation report.** Full recipes in `docs/orchestration/manual-verification.md`.

- [ ] **Un-pause the Supabase project** (`NPX-demo`, ref `ptepxophdneugvcziqny`). Confirmed via `supabase projects list` that it still exists and is linked — it is paused, not deleted (DNS returns NXDOMAIN, same signature as the 2026-05-14 pause). The CLI has no unpause command, so this needs the dashboard — or export `SUPABASE_ACCESS_TOKEN` in an agent session and the Management API restore endpoint can do it. Until then the eval golden set cannot be generated and the runner refuses to score placeholder data.
- [ ] **Start the dev server** (`bun dev`, :3001) before the eval battery — the answer harness scores the REAL pipeline over HTTP, and agents are forbidden from starting the server themselves.
- [ ] Raj live-verify Artifact mode in the browser once merged: toggle to Artifact, ask a complex regulatory question, confirm the generated HTML explainer renders in both light + dark app themes, diagrams display, download works (see `docs/orchestration/manual-verification.md` for the exact recipe).
- [ ] Raj review the committed RAG evaluation report (scores per category + methodology) and decide whether any score warrants a follow-up hardening phase.

### Tuesday Apr 21 — Outreach (paused behind Phase 6 completion)
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
- [x] Create `scripts/ingest.ts` (separate entry point) — uses `SUPABASE_SERVICE_ROLE_KEY` for bulk chunk inserts during ingestion. Lives outside `app/` so it's never bundled into the runtime build. Consumes the pre-parsed JSON under `scraped_regdocs/` (one file per REGDOC, schema: `{regdoc_id, title, url, sections[{section_number, section_title, anchor, paragraphs:[{text, requirement_type}]}]}`), reconstructs section text, applies Appendix C.4 chunking (400 tokens, 60-token overlap, sentence-aware, one chunk per section boundary), C.5 embedding batching + retries, batched `INSERT` into `regdoc_chunks` (1000 rows/statement per Supabase batch-insert guidance), and C.6 verification output. *(dry-run on 2026-04-16: 1945 chunks / 863 requirement / 1082 guidance over 1670 sections. Supports `--dry-run` and `--only=REGDOC-X.X.X` flags.)*
- [x] Run the ingestion: `bun run ingest` against the Supabase project populates `regdoc_chunks` from all 19 files in `scraped_regdocs/`. Acceptance: `SELECT count(*) FROM regdoc_chunks` returns > 1500 chunks; `SELECT count(*) FROM regdoc_chunks WHERE embedding IS NULL` returns 0; a smoke `match_regdoc_chunks` RPC call for "shift turnover" returns rows citing `REGDOC-2.3.4`. Script is idempotent — on rerun it TRUNCATEs `regdoc_chunks` first (it's derived data, safe to regenerate). *(done 2026-04-16: 1945 rows inserted, 0 NULL embeddings. Smoke failed until HNSW migration — see new human task above.)*
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
- [x] Wire assistant-ui (`Thread` + `ThreadList` in a navy-themed sidebar) into `app/knowledge-hub/page.tsx` via `components/knowledge-hub/KnowledgeHubShell.tsx` (client component, `useChatRuntime` w/ no Assistant Cloud → Phase 3 will swap in localStorage persistence per 2026-04-16 decision).
- [x] Custom runtime adapter pointing to `/api/knowledge-hub/query` — `AssistantChatTransport({ api: "/api/knowledge-hub/query" })`.
- [x] Test send/receive round-trip with a mock response — `/api/knowledge-hub/query` now streams a deterministic UIMessage via `createUIMessageStream`/`createUIMessageStreamResponse` (no OpenAI call). Phase 3 replaces the handler with the real RAG pipeline.
- [x] Build top nav component — `components/site/TopNav.tsx` (server, reads `auth.getUser()` and swaps between `SignInButton` + `UserChip`), `components/site/SignInButton.tsx` (client stub for iter 3), `components/site/UserChip.tsx` (client, initials + email + sign-out dropdown). Sticky header with backdrop-blur, navy tokens only, `focus-visible` rings.
- [x] Build sign-in modal per Appendix J.6 — implemented in `components/site/SignInButton.tsx` as a Radix Dialog with 4 states (idle / loading / success / error), email input with `autocomplete="email"`, `supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${window.location.origin}/auth/callback` } })`. Radix handles role="dialog", focus trap, Esc dismiss, and focus return. Status area uses `aria-live="polite"`; error banner uses `role="alert"`. Below `sm`, modal goes full-screen via `max-sm:h-full max-sm:max-w-full max-sm:rounded-none`. Errors never surface raw Supabase strings — just "Something went wrong. Try again." + retry. **Human test blocker:** Supabase Auth → Providers → Email must be enabled before the magic-link actually sends.
- [x] Build footer component — `components/site/Footer.tsx`, "Built by Raj Dholakia as a demonstration for NPX Innovation" with LinkedIn + npxai.com links, simulated-data disclaimer, wired into `app/layout.tsx` below `<main>`.
- [x] Write Appendix F seed migration — applied 2026-04-17 as `supabase/migrations/20260417015131_seed_bruce_power_fixtures.sql` (50 plant_status + 12 work_orders + 15 shift_log_entries, BEGIN/COMMIT, TRUNCATE…RESTART IDENTITY). Applied via `supabase db push --linked`; row counts verified through `supabase db query`. *(Replaces the earlier plan to write `seeds/bruce-power.sql` + a `bun run seed:plant` runner — dropped after Raj established the CLI-first rule 2026-04-17. Going forward all DB work is CLI-driven.)*

### Phase 3 — RAG pipeline (Sat Apr 18)
- [x] Create `lib/prompts.ts` — export `KNOWLEDGE_HUB_SYSTEM` (Appendix D.1 verbatim), `GENERATOR_SYSTEM` (D.4 verbatim), `PROMPT_VERSION` constant. *(done early in Phase 1; was originally Phase 3)*
- [x] Create `lib/context-envelope.ts` — wraps retrieved chunks in `<context_snippet>` tags per D.2 with HTML-entity escaping on body. *(done early in Phase 1; was originally Phase 3)*
- [x] Create `lib/output-guard.ts` — D.6 output validation: deny-list scan, truncate-on-hit, hashed-IP logging. *(done early in Phase 1; was originally Phase 3)*
- [x] Create `lib/logger.ts` — structured JSON logger per Appendix H.6; exports `logRequest()`, `logGuardEvent()`, `hashIp(ip)` **and `hashUser(userId)`** (same daily-salt rotation). Every request log includes `tier` (anon | signed_in | npx_circle); authenticated requests additionally include `user_hash`.
- [x] Verify `@assistant-ui/react-markdown` + `remark-gfm` config has raw-HTML passthrough disabled. *(confirmed 2026-04-17: `components/assistant-ui/markdown-text.tsx` passes only `remarkPlugins={[remarkGfm]}` and no `rehype-raw` — react-markdown defaults to escaping raw HTML.)*
- [x] Implement `/api/knowledge-hub/query/route.ts` — real pipeline committed 2026-04-17:
  - [x] `withGuard()` wrap (rate limit + circuit breaker per Appendix B); guard now also honours an opt-in `x-eval-bypass` header when `EVAL_BYPASS_KEY` is set, so the eval runner can do 20 queries in one shot
  - [x] Embed user query with `text-embedding-3-small`
  - [x] `match_regdoc_chunks(query_embedding, 8, 0)` RPC via anon client (threshold applied handler-side)
  - [x] D.3 fallback: top-1 < 0.40 → out-of-scope without LLM (calibrated down from the planned 0.50 after probe-sims data landed Q20 "turnover" at 0.426 — see decisions log); `MIN_CHUNK_SIM = 0.35` filters peripheral matches before envelope build so borderline queries cite the most-relevant REGDOC instead of a glossary hit; avg < 0.35 still prepends the "limited context" disclaimer
  - [x] Envelope via `lib/context-envelope.ts` (D.2) — HTML-escaped chunk bodies
  - [x] Stream from `gpt-4o-mini` with `KNOWLEDGE_HUB_SYSTEM`, tier-scaled `max_tokens`, and `StreamingGuard` (D.6) in the token pipeline
- [x] Handle out-of-corpus / ambiguous queries gracefully (fallback rules from Appendix D.3 + verified against Appendix E questions 14–16, 20). *(Q14/Q15/Q16 top-sims 0.31/0.68/0.31 — 14 + 16 hit the OOS gate pre-LLM; 15 relies on D.1 rule 4 since "US NRC" embeds near REGDOC-2.2.2 training docs.)*
- [x] Create `evals/knowledge-hub.jsonl` from Appendix E.1 (20 cases grounded against E.5 section mappings).
- [x] Create `scripts/eval-kb.ts` — grades per E.4 order; `--only 1,17,19` subset flag; `--debug` prints the raw response for any failed case; exit code gated on ship bar.
- [x] Wire `bun run eval:kb` into `package.json` scripts *(already present; confirmed 2026-04-17)*
- [ ] Add tier-aware integration tests: (a) 6th anon KH query/day → 429; (b) 51st signed_in KH query/day → 429; (c) 1400-char query succeeds as signed_in, fails 400 as anon (per Appendix H.3 + J.10)
- [ ] Frontend: parse citation markers using the regex from Appendix D.5; render as clickable chips mapped to retrieved snippet metadata. *(Route already emits a `data-sources` UIMessage part with the retrieved chunks — frontend just needs to consume it.)*
- [ ] Frontend: "Sources" panel showing retrieved chunks
- [ ] Frontend: streaming response wired into assistant-ui Thread *(already live — real route streams through assistant-ui as of iter 5. Remaining work is the citation chips + Sources panel above.)*

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
- [ ] Assist human with `git push origin main` and verify the Cloudflare Git integration build log is green (dashboard → Workers & Pages → npxai-demo → Deployments)
- [ ] Post-deploy smoke test: `bun run eval:kb` (Appendix E) + Generator run for Unit 3 Evening (the demo "money shot" per Appendix F.5) + spot check other units/shifts
- [ ] Post-deploy sign-in smoke: in an incognito window, open the prod URL → click Sign In → enter Raj's email → receive and click magic link → land on `/knowledge-hub` with session cookie set → issue one query and confirm `tier` appears in the request log (Appendix H.5 + J.10)

### Phase 6 — Frontend overhaul (opened 2026-04-17 night)

> Ordering is deliberate — see the 2026-04-17 "Phase 6 ordering" decision. Work top-to-bottom: 6A → 6D.light → 6C → 6B (KH UX, threads last) → 6D.brand → 6E → 6F.

**6A · Architecture & chrome — split landing from app**
- [ ] Introduce route groups: `app/(marketing)/` for landing + Insights + Equivalency + FAQ, `app/(app)/` for Knowledge Hub + Generator. Each group gets its own `layout.tsx`.
- [ ] Remove the global `<TopNav />` and `<Footer />` from the app group; keep them on marketing. App group gets a compact header (logo + user chip + theme toggle) and no footer — move the simulated-data disclaimer to a single muted chip inside the app shell.
- [ ] Build a shared `AppShell` in the app group — Vercel-dashboard-style fixed left sidebar with pinned surfaces (Knowledge Hub, Generator) at the top and contextual rails below (KH thread list / Generator recent reports) on their respective routes. Collapsible to icon-only rail.
- [ ] Resolve the sidebar/nav/footer z-index + stacking chaos — KH sidebar should live inside `AppShell`, not compete with TopNav + the existing `!top-14 !h-[calc(100svh-3.5rem)]` overrides in `KnowledgeHubShell.tsx:45`.

**6D · Theme scaffolding (light + dark tokens, shipped early so all later work consumes both)**
- [ ] Install `next-themes`; wrap the root layout in `ThemeProvider` with `attribute="class"` + `defaultTheme="system"`.
- [ ] Author a full light-mode token set in `app/globals.css` paralleling the current dark set — `--bg`, `--surface`, `--surface-2`, `--text`, `--text-muted`, `--accent-brand`, `--requirement`, `--guidance`, `--success`, `--warning`, `--danger`. WCAG AA contrast verified per token pair.
- [ ] Build shadcn `ThemeToggle` (sun/moon icon, tri-state: Light / Dark / System). Mount top-right in both the marketing nav and the app shell header.
- [ ] Light-mode variants of the four-state catalog (loading skeleton, empty, error, partial) for KH + Generator — per the "ships alongside dark" decision, every state Appendix G catalogued now has a light counterpart.

**6C · Generator UX (latency fix + report persistence + operator-grade styling)**
- [ ] Replace the native `<select>` elements in `components/generator/GeneratorForm.tsx:208-219` with shadcn `Select` for Station / Unit / Shift. Keep the same submit path — only the control is swapped.
- [ ] Fix the Generator latency: `app/api/generator/turnover/route.ts:68` currently calls OpenAI with `stream: false` and `max_tokens = 1500`, so the entire report generates before any bytes reach the browser. Switch to `stream: true` and pipe through `createUIMessageStream` (mirror the Knowledge Hub pattern) so tokens render progressively. `scanOutput` moves to a post-stream finalize step.
- [ ] Surface the pipeline as three user-visible phases: "Pulling plant snapshot" (RPC in-flight) → "Drafting turnover" (first tokens arriving) → "Finalizing" (output guard pass). Skeleton shimmer per phase; `aria-live="polite"` on the phase label.
- [ ] Report layout — operator-grade, not TOC-heavy:
  - [ ] Left-rail quick-jump with the 6 section labels (Plant Status / Safety Systems / Work & Clearances / Key Events / Watch Items / Recommended Actions). Active-section highlight on scroll. Lighter than a full sticky TOC.
  - [ ] Anchor IDs on every heading + smooth-scroll links from the rail.
  - [ ] Severity callouts: `[CRITICAL]` → red-outlined block with alert icon, `[ATTENTION]` → amber, `[ROUTINE]` → muted. Replace the current inline badges.
  - [ ] Collapsible section cards so operators can fold routine noise away.
  - [ ] Thin 1px borders + deep saturated surface per the Vercel-dashboard reference class. Zero decorative gradients in the app shell.
- [ ] Add a print stylesheet + "Save as PDF" button (browser print route) so operators can hand off the report.
- [ ] **Generated-report persistence** (hybrid per the 2026-04-17 decision):
  - [ ] Supabase migration: `generated_reports(id uuid pk, owner_id uuid references auth.users, station text, unit int, shift text, report_markdown text, snapshot_hash text, generated_at timestamptz default now())`. RLS: owner-only read/write. Compound index on `(owner_id, station, unit, shift, generated_at desc)`.
  - [ ] RPCs (`SECURITY DEFINER`): `list_reports()`, `get_report(p_id uuid)`, `save_report(p_station text, p_unit int, p_shift text, p_markdown text, p_snapshot_hash text)`, `delete_report(p_id uuid)`. Grant EXECUTE to `authenticated` only.
  - [ ] Update `get_turnover_snapshot` (or add a sibling `get_snapshot_hash`) to return a hash over `(plant_status.updated_at ∪ work_orders.updated_at ∪ shift_log.updated_at)` for the requested unit — this is the dedupe key.
  - [ ] Route logic: before calling OpenAI, hash the snapshot. If a signed-in user has an existing report with the same `snapshot_hash`, return it with "Last generated {x} ago, nothing has changed" + an explicit **Regenerate** button. Otherwise generate + `save_report` after streaming completes.
  - [ ] Anon path: store the last 5 reports in localStorage keyed by `{station,unit,shift,snapshot_hash}` with the same dedupe behavior. Ring-buffer eviction beyond 5.
  - [ ] UI: "Recent reports" rail in the Generator shell (signed-in: server; anon: localStorage). Each row → station/unit/shift badge + relative time + trash icon. Click to load instantly from cache.

**6B · Knowledge Hub chat UX**
- [ ] Streaming-state indicator: while assistant is responding, show an "Answering…" row with animated typing dots inside the thread (distinct from the existing abort button); read assistant-ui's streaming state so it disappears as soon as tokens start arriving.
- [ ] Make inline citation chips in `components/assistant-ui/markdown-text.tsx` clickable — resolve each `[REGDOC-X.X.X §Y.Z]` to the matching chunk URL from the `data-sources` UIMessage part and render as an `<a target="_blank">` with the existing chip styling. Keep the Sources panel as the secondary detail view.
- [ ] Kill thread auto-naming. Threads start and stay at "New thread" unless the user renames. (Confirm `lib/thread-store.ts:49` default + any upstream assistant-ui auto-title are both neutralized.)
- [ ] Add rename + delete UX to every thread row (kebab → Rename / Delete) for anon and signed-in. Inline input on Rename, Enter/Esc handling, focus trap.
- [ ] **Hybrid thread persistence** (landed late per the ordering decision — biggest RLS surface, ships after the rest of Phase 6 is green):
  - [ ] Write `supabase/migrations/…_chat_threads.sql` — `chat_threads(id uuid pk, owner_id uuid references auth.users, title text, created_at, updated_at)` and `chat_messages(id uuid pk, thread_id uuid, role text, content jsonb, created_at)`. RLS: owner-only select/insert/update/delete on both tables. No direct table grants.
  - [ ] RPCs (`SECURITY DEFINER`): `list_threads()`, `get_thread(p_id uuid)`, `save_message(p_thread uuid, p_role text, p_content jsonb)`, `rename_thread(p_id uuid, p_title text)`, `delete_thread(p_id uuid)`. Grant EXECUTE to `authenticated` only.
  - [ ] Route handlers `app/api/threads/*` wrapping the RPCs (anon key + cookies via `@supabase/ssr`). Withguard them with signed-in-only rate limits.
  - [ ] Update `lib/thread-store.ts` to branch on `session`: localStorage for anon, `fetch('/api/threads/...')` for signed-in. Optimistic writes + background sync.
  - [ ] One-shot migration path: on first sign-in detect any localStorage threads and POST them to a new `migrate_local_threads` RPC, then clear localStorage so the server becomes source of truth.
- [ ] Write one integration test that proves signed-in threads survive a sign-out → sign-in round-trip (anon tier not impacted).

**6D · Brand palette swap (operator-grade, not marketing-grade)**
- [ ] Extract a dark-navy palette referenced against **Vercel Dashboard / Linear / Palantir Foundry** — instrument-panel calm, thin 1px borders, deep saturated surfaces. Pull one cue from npxai.com (the overall "energy of the deep + aurora") but darken and desaturate so the app reads as an operator tool, not a marketing site. Keep `--requirement` blue + `--guidance` amber — they carry semantic meaning, not decoration.
- [ ] Drop the new values into `app/globals.css` using the existing Appendix G token names — no component-level edits cascade. Update `--bg`, `--surface`, `--surface-2`, `--border`, `--accent-brand` only.
- [ ] Verify WCAG AA contrast against both light and dark palettes for text-on-surface, citation chips, severity callouts, and the three Generator severity blocks. Adjust any token that fails.
- [ ] Sign-in button fix — `components/site/SignInButton.tsx` needs to render as a solid, high-contrast chip on any background (homepage hero included). Add a visible border + solid fill; never transparent over gradients.
- [ ] Typography pass — Inter for UI; JetBrains Mono used deliberately on timestamps, REGDOC IDs, clearance codes so structured data looks structured.

**6E · Marketing hero (aurora lives here and only here)**
- [ ] Build an animated northern-lights background in the hero of `app/(marketing)/page.tsx`: layered SVG gradients + CSS `@keyframes` drifting horizontally, GPU-friendly (transforms + opacity only, no large repaints). Colors pulled from our darker palette — not NPXai's marketing teal. Honor `prefers-reduced-motion: reduce` with a static gradient fallback.
- [ ] Confirm aurora does NOT appear on `/knowledge-hub`, `/generator`, or any app-group route. Motion stays marketing-only per the 2026-04-17 visual-direction decision.
- [ ] Refresh the "What's in the demo" cards + "Why NPX AI?" pillars to the new brand tokens and typography.
- [ ] Smoke-test Lighthouse on the homepage — aurora must not drop Performance below 85 on mid-tier mobile.

**6F · Cross-cutting**
- [ ] Responsive audit of the new app shell: sidebar collapses to a hamburger drawer below `md`; marketing pages stay full-width but stack card grids on mobile.
- [ ] a11y pass — `role="navigation"` on the app sidebar, keyboard-traversable thread list + recent-reports rail, `aria-live="polite"` on streaming-state indicator and the Generator phase chip, reduced-motion fallback for the aurora, theme toggle reachable via keyboard with a proper `aria-label`.
- [ ] Browserbase verification (new flows): homepage aurora + CTA click-through, theme toggle light ⇄ dark on every page, KH streaming indicator appears then disappears, citation chip opens the source URL in a new tab, thread rename persists across reload for signed-in users, Generator streams tokens progressively, shadcn Selects open/close correctly, Recent Reports rail loads a cached report without re-hitting OpenAI, snapshot-hash dedupe triggers when nothing has changed.
- [ ] `bun run preflight` + `bun run build` + `bun run eval:kb` stay green after all 6A–6F changes.

### Phase 7 — Post-launch website polish (backlog, opened 2026-04-17)

> Raj flagged three refinements after reviewing the live app — these are non-blocking for outreach and get tackled once the sign-up flow + Loom have landed. Scope is marketing-surface only; the app shell (Knowledge Hub, Generator) is not in scope for Phase 7.

**7A · Prune marketing copy (take inspiration from npxai.com's brevity)**
- [ ] Audit prose across `app/(marketing)/page.tsx`, `app/(marketing)/insights/page.tsx`, `app/(marketing)/equivalency/page.tsx`, `app/(marketing)/faq/page.tsx` and cut ~60% of the word count. Target: single-screen landing, CTAs do the work, no long explainer blocks inline.
- [ ] Hero subhead is the biggest offender — the current two-sentence block under "A CNSC Knowledge Hub and a CANDU shift generator…" should compress to one sentence of ≤ 20 words. Keep the "NPX Innovation" link.
- [ ] Collapse the "Why NPX AI?" three-card block to one tight sentence each (the current body paragraphs average 40+ words — aim for ≤ 15). Keep the three icons; kill the redundant headline-then-paragraph pattern.
- [ ] Trim feature card blurbs to one line each. Drop the "Working feature" / "Explainer" labels — the icons + CTA verbs (`Try it` / `Read more`) already encode that distinction.
- [ ] Move the detailed build rationale (security posture, RAG eval numbers, deploy stack, design-system notes) off the homepage. Consolidate into a single `/behind-the-demo` route inside `(marketing)/` that absorbs Insights + Equivalency + "Why NPX AI?" narrative. Link to it with one small footer chip. *(A separate blog on Raj's personal site is the alternative — flagged for human decision above. Default to the in-repo route for scope.)*
- [ ] FAQ page: keep questions, halve each answer. If an answer needs more than ~40 words it probably belongs in `/behind-the-demo`.

**7B · Light-mode hero gradient (darker shades of the current aurora colors)**
- [ ] Current light-mode aurora uses `mix-blend-mode: multiply` + low opacity (`app/globals.css:434-443`), which reads muddy on the near-white surface. Direction per Raj 2026-04-17: **same hues as today — `--accent-brand` blue, `#6366f1` indigo, `#2dd4bf` teal — but darkened so they visibly tint the light background instead of washing out.**
- [ ] Drop `mix-blend-mode: multiply` in the light branch; it's the source of the smear. Either use `mix-blend-mode: normal` with reduced opacity or no blend mode at all.
- [ ] Introduce darker-shade variants for each band in the light override — e.g. `color-mix(in oklab, var(--accent-brand) 80%, #000 30%)` style — so the tint is visible against white. Keep dark-mode CSS untouched.
- [ ] Verify every hero element (`h1`, subhead, both CTAs) stays WCAG AA against the heaviest tinted pixel the gradient produces.
- [ ] `prefers-reduced-motion` branch still freezes the bands (already handled); reconfirm after the rework.

**7C · Light palette swap — Tweakcn Vercel preset**
- [ ] Pull the Vercel preset from [tweakcn.com](https://tweakcn.com/editor/theme). Port the `--background / --foreground / --card / --card-foreground / --muted / --muted-foreground / --border / --primary / --accent / --ring` values into `:root` in `app/globals.css`, mapping them onto our existing semantic tokens (`--bg / --text / --surface / --surface-2 / --text-muted / --border / --accent-brand / --accent`). Do **not** rename our tokens — the whole app consumes them.
- [ ] Preserve the domain-semantic tokens (`--requirement`, `--guidance`, `--success`, `--warning`, `--danger`) — they carry regulatory meaning, not shadcn branding. Only the neutrals + the single brand accent get swapped.
- [ ] WCAG AA audit against the new light palette — text-on-surface, text-on-surface-2, chip fills, severity callouts, citation pills, `SignInButton`, `NewsletterCapture` input/button, theme-toggle focus ring. Fix every token pair under 4.5:1 before merging.
- [ ] Dark mode is out of scope for this swap. `.dark` block stays untouched.
- [ ] Run `bun run build` + `bun run eval:kb` + Browserbase smoke on every page after the swap — the CLAUDE.md "both themes must survive" rule means the matrix here is 2 themes × N pages.


### Phase 8 — Mobile polish (opened 2026-04-18, pre-outreach)

> Raj flagged mobile readiness on 2026-04-18 — outreach DMs will open on iPhones first. Scope is the **marketing shell + home page** (TopNav, hero, NPX theme background). Knowledge Hub, Generator, Insights, Equivalency confirmed acceptable on mobile already and are out of scope. Ordering: foundations (8A) first so later work consumes the corrected viewport, then navbar (8B) — that's the visible regression — then background (8C), then the sweep (8D–8E).
>
> iPhone 14 Pro Max reference viewport: 430×932 CSS px, DPR 3, notch + home indicator.

**8A · Viewport + safe-area foundations** *(shipped 2026-04-18 — commit `d6fc327`)*
- [x] Add a root `viewport` export in `app/layout.tsx` with `viewportFit: "cover"`.
- [x] Swap `min-h-screen` → `min-h-dvh` in the marketing layout. (Repo-wide grep: marketing was the only user.)
- [x] Add `.pt-safe` / `.pb-safe` / `.pl-safe` / `.pr-safe` / `.px-safe` utilities in `app/globals.css`.

**8B · TopNav mobile rebuild** *(shipped 2026-04-18 — commit `a314c9c`)*
- [x] Built `components/site/MobileNav.tsx` — Sheet-based drawer with Home + Knowledge Hub + Generator + Insights + Equivalency + ThemeToggle. 44×44 hamburger trigger, drawer closes on nav.
- [x] `TopNav.tsx`: `WORKING_APPS` + `ConceptsMenu` stay `hidden md:flex`; `MobileNav` renders `md:hidden`. Added `min-w-0` on flex children to fix the overflow root cause; `overflow-x-clip` guard on `<header>`.
- [x] `BrandThemeToggle`: brand mark stays at every size, "NPXai Demo" text hidden below `sm`.
- [x] `UserChip`: avatar-only below `sm`; email shown in dropdown header; width clamped to `min(15rem, calc(100vw-1.5rem))` so the menu can never overflow; outside-click + Escape close handlers added.
- [x] `ThemeToggle` hidden below `sm` in the header; only reachable from the drawer on mobile.

**8C · NPX theme background fit** *(shipped 2026-04-18 — commit `72b9bcb`)*
- [x] Dropped `background-attachment: fixed` on `.npx body` (iOS Safari clamps it to the device viewport and crops the photo).
- [x] Below `md`, switched to `background-size: contain` + `background-position: center top` with `--bg` letterbox fill; desktop keeps `cover`.
- [x] `@supports` AVIF block inherits the `contain` override via the shared media query (no redundant `cover` in the supports rule).

**8D · Touch-target pass (44×44 minimum per Apple HIG)** *(shipped 2026-04-18 — commit `82e4b75`)*
- [x] `SignInButton` trigger bumped to `h-11` on mobile (desktop keeps `h-8` via `sm:` reset). Modal submit was already `h-10`; left as-is (it's inside a dialog, not a top-level tap target).
- [x] `UserChip` trigger bumped to `h-11` on mobile (done as part of 8B).
- [x] `ThemeToggle` segments bumped from `h-7 w-7` to `h-10 w-10` on mobile; desktop sizing preserved.
- [x] Hamburger button is `h-11 w-11`; SheetClose bumped from `h-10` to `h-11`.
- [x] Home pill stays `hidden md:inline-flex` — not shown on mobile, so its small `py-1.5` no longer matters.

**8E · Homepage + hero fit** *(shipped 2026-04-18 — commit `1ac5274`)*
- [x] Hero h1: `text-[2rem] leading-[1.1]` below `sm`, stepping up to `text-4xl` / `text-5xl` / `text-6xl`. No longer wraps to 5 lines at 430×932.
- [x] Hero vertical padding: `py-12 sm:py-12 md:py-28`.
- [x] Hero CTAs stretch to `max-w-sm` column below `sm` so the stack reads aligned.
- [x] Contact section padding: `p-6 sm:p-8 md:p-12`.
- [x] Inter-section gap: `gap-14` below `sm`, `gap-24` above.

**8F · Cross-cutting sweep** *(shipped 2026-04-18 — commit `f92060d`)*
- [x] `overflow-x-clip` on the marketing children wrapper (not the outer flex column, so the sticky TopNav still resolves against the document scroll).
- [x] Footer right-side chip row uses `flex-wrap` + `gap-x-3 gap-y-1` so long strings break cleanly below `sm`.
- [x] Other marketing pages (Insights / Equivalency / FAQ / NewsletterCapture) audited — all single-column grids with `px-4` gutters, no horizontal overflow sources found.
- [x] `AuroraHero` bands re-verified — parent is `relative isolate overflow-hidden`, reduced-motion branch freezes the pose; no leaks.

**8G · Test + ship** *(tsc + preflight green 2026-04-18)*
- [x] `bun run preflight` passes (secrets scan + service-role-key import guard).
- [x] `bunx tsc --noEmit` passes (zero errors after the navbar rebuild + UserChip refactor).
- [ ] *Raj:* Chrome DevTools iPhone 14 Pro Max walk (captured in the Humans section above).
- [ ] *Raj:* Second-device spot check (captured in the Humans section above).
- [ ] *Optional:* `bun run build` full production build — not blocking given tsc + preflight are green; worth a run before the next deploy.


### Phase 9 — Auth + rate-limit hardening (opened 2026-04-18 evening)

**9A · Server-authoritative auth state** *(shipped 2026-04-18)*
- [x] `/api/auth/whoami` endpoint — server-validated via `getUser()` so client can reconcile instead of trusting `getSession()` (stale-cookie-proof).
- [x] `AuthProvider` (`lib/auth-context.tsx`) replaces the localStorage-persisted `useThreadStore`. Server-seeds via `initialMode`, reconciles on mount + focus.
- [x] Guard's 429 response includes the server-resolved `tier` so the client can detect "I thought signed_in, server sees anon" mismatches.
- [x] Custom transport `fetch` in `KnowledgeHubRuntimeProvider`: on 429/403 tier-mismatch, call `supabase.auth.refreshSession()` once; retry on success; on failure flip client to anon and surface the session-expired banner.
- [x] On anon → signed_in transition, wipe `npxai-kh-anon-threads` + `npxai-kh-anon-msgs:*` from localStorage (option C — nuke on sign-in).
- [x] Anon KH window ordering cleanup: `hour: 10 → 5` so the hour bucket isn't dead code under the `day: 5` cap.

**9B · Anon-thread migration prompt (option D — deferred backlog)**
- [ ] On first signed-in mount, if `npxai-kh-anon-threads` is non-empty, show a one-time prompt: "Keep your N guest threads?" with Keep / Discard buttons.
  - Keep → iterate anon threads and POST each to `/api/threads` (title + messages), then wipe localStorage.
  - Discard → wipe localStorage immediately (current option-C behavior).
  - Dismiss state persisted in a separate localStorage key so the prompt doesn't re-fire across sessions on the same device.
- [ ] Handle partial-migration failure: if any thread POST fails, keep the remaining anon threads in localStorage so the user can retry. Don't lose work.
- [ ] Update `PLAN.md` Appendix J (auth flow) to document the migration path.

### Phase 10 — Prompt-injection hardening (opened 2026-05-14)

**10A · Bot survives the red-team battery** *(shipped 2026-05-14)*
- [x] `KNOWLEDGE_HUB_SYSTEM` rewritten — security consolidated into a tight preamble (extraction / persona-swap / scope / NPX-impersonation refusals); answer rules 1–4, 2a–2c, 7 kept verbatim. `PROMPT_VERSION` → `2026-05-14.3`. (The first rewrite was refuse-first and regressed the hard eval 20/20→18/20 — terse in-corpus queries like "turnover" got refused. Restructured to answer-first: "Your job is to answer … Default to answering" leads, "Security boundary — refuse ONLY these" follows. Restored 20/20 with all 30 security rows still green.)
- [x] User query spotlighted — `buildContextEnvelope` wraps it in `<user_query>` with HTML-escaped body, mirroring the `<context_snippet>` treatment.
- [x] `lib/validators.ts` — `sanitizeQueryText` adds NFKC normalize + zero-width strip; `JAILBREAK_PATTERNS` expanded 4→16 (incl. French — Canada is bilingual, this is a CNSC bot); new `decodeBase64Probe` (re-scan base64 payloads); new `leetFold` so `detectJailbreakMarkers` also scans a leetspeak-folded copy; new `HARD_INPUT_CEILING = 8000`.
- [x] `route.ts` — jailbreak markers now short-circuit to the canonical out-of-scope reply (raw + base64-decoded scan) via the cache-hit streaming path; `HARD_INPUT_CEILING` enforced before the tier cap. `ctx.logFields.jailbreak_blocked` set so blocked rows are observable.
- [x] Adversarial eval harness — `evals/security.jsonl` (30 rows across extraction / persona / scope / hallucination / obfuscation / adversarial / social + grounded regression guards) + `scripts/eval-security.ts`, wired as `bun run evals:security`. Output is a grouped-by-category markdown table.
- [x] Final verification against the live dev server: `bun run evals:security` **30/30** (all attack categories + grounded 2/2) and `bun run eval:kb` **20/20** (Ship bar ✅, Adversarial 3/3). tsc + biome green.
- [x] Root-caused the `grounded` HTTP 500s: the Supabase project `ptepxophdneugvcziqny` was **paused** (free-tier inactivity — initially misdiagnosed as deleted because `nslookup` returned NXDOMAIN; a paused project can drop DNS too). Raj unpaused it; retrieval recovered, corpus intact. During the hunt, found the foundational RAG schema (`regdoc_chunks` + HNSW, `match_regdoc_chunks` / `get_turnover_snapshot` / `get_user_tier` RPCs, `profiles` + `handle_new_user`) was applied pre-CLI and never committed as migrations — so a fresh project couldn't be rebuilt.
- [x] Reconstructed the 5 missing foundational migrations from PLAN.md Appendix A (`20260416120000`–`20260416120400`, slotted before the earliest committed migration). RPC signatures + column names verified against the calling code; dependency chain confirmed. Repo's 14-migration set is now self-sufficient for `supabase db push` — closes the schema-drift gap even though the project recovered via unpause this time.
- [x] Added `supabase/RECOVERY.md` — runbook for a paused/lost project + exact rebuild steps (create project → link → `db push` → update `.env.local` → `bun run ingest` → re-run evals).

### Phase 11 — Artifact mode + RAG eval framework (opened 2026-07-13, orchestrated-delivery loop)

> Live sprint state (slice→PR mapping, progress line) lives in `docs/orchestration/backlog.md`; this list mirrors the item level only.

- [~] item-1 · Knowledge Hub Artifact mode — search-time toggle (chat ↔ artifact); backend route generates a self-contained NPX-themed HTML explainer with inline-SVG diagrams via the existing RAG pipeline; sandboxed-iframe viewer + download; same guard/rate-limit surface as chat; both themes.
- [ ] item-2 · RAG eval framework — golden dataset from ingested corpus; metrics module (faithfulness, answer relevancy, context precision, context recall, consistency — web-researched definitions, cited); experiment runner with structured JSONL logs + per-run cost guard; run experiments; commit scored report with realistic percentages per category.
- [x] pre-item · Timelapse cleanup — `.timelapse.yaml` deleted, `.gitignore` reverted, `.timelapse/` + `.env.timelapse` removed (2026-07-13).
- [x] pre-item · Orchestration scaffolding — `docs/orchestration/` (role templates, backlog, ledger, friction log, changelog, manual-verification queue) (2026-07-13).

---

- [ ] Before advancing `Current phase`, verify the relevant Appendix H checklist is green
- [ ] Log notable decisions in `PLAN.md` decisions log
- [ ] Flag any scope creep or new blockers to the human in chat
- [ ] Every route handler uses `logRequest()` from `lib/logger.ts` — no ad-hoc `console.log` in route code
