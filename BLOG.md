# BLOG.md — material carved out of the marketing surface

> Long-form content lifted off the homepage / Insights / Equivalency / FAQ as
> part of the 7A pruning pass (2026-04-17). Raj to repurpose on his personal
> blog — the site copy now points here in spirit if not in link.
>
> Each section is self-contained so individual posts can be assembled without
> cross-reference. Edit voice freely — these are first drafts in the
> site's register, not yours.

---

## 1. Why build the demo the way I did — security-first RAG, grounded answers, edge deploy

*(Formerly the "Why NPX AI?" three-pillar section on the homepage.)*

**Security-first RAG.** The route handlers use only Supabase's anon key; all
reads go through `SECURITY DEFINER` RPCs with RLS enabled on every table. The
service-role key is used by one offline ingestion script and never sees the
runtime. Public endpoints are behind Upstash sliding-window rate limits, tiered
per-user (anon / signed-in / nuclear-industry domain) and backed by a global
daily OpenAI circuit breaker that trips before the wallet does. Input is
length-capped and HTML-escaped into context envelopes wrapped in
`<context_snippet>` tags so retrieved text can't masquerade as instructions to
the model. Output passes a deny-list scan before streaming. Threads stay
client-side, so there is no server-side prompt log to leak.

**Grounded answers only.** Every claim is cited back to the specific REGDOC
section it came from, with a visible Sources panel under each answer. The
prompt is instruction-tuned to refuse when retrieval is below a similarity
threshold, and a 20-question eval battery — including three adversarial
questions — runs pre-deploy. Current build: 20/20. Ship bar: 17/20 with all
three adversarial Qs passing. If the corpus doesn't cover a question, the
assistant says so instead of guessing.

**Cloudflare-edge deploy.** Built on Next.js 16 + `@opennextjs/cloudflare`,
Supabase pgvector (HNSW index), and Upstash Redis. Portable to Azure OpenAI
+ Cosmos DB vector + Azure Cognitive Search if the deployment posture calls
for it — the provider seams are thin on purpose.

---

## 2. Insights — what would it take to build this for real?

*(Formerly the bottom section of the Insights explainer page.)*

The Insights surface would sit downstream of the Knowledge Hub and Generator:
both of those tools pull structured data on demand, while Insights
continuously scans the same data + CNSC signal for operator-relevant
narratives.

Build list:

- Continuous ingestion of the same simulated (or real) plant data already
  seeded for the Generator.
- An additional corpus: CNSC Commission meeting letters + Event Initial
  Report (EIR) summaries, parsed and embedded alongside the existing REGDOC
  chunks.
- A scheduled worker (Cloudflare cron) that pulls the latest window, applies
  the same RAG + citation contract, and writes a rolling narrative to an
  append-only log.
- A "what changed since last shift" surface in the UI, with the same
  Sources-panel contract as the Knowledge Hub.

What this would give a control-room supervisor:

- **Trend-aware summarisation.** Roll up parameter drift (temperature,
  pressure, oxygen) into plain-language narratives you can skim in
  30 seconds — rather than hunt through 40 trend screens.
- **Regulatory signal.** Cross-reference operating anomalies against active
  CNSC REGDOC sections and recent Commission letters. Flag the clauses a
  station needs to address before the next compliance inspection, not
  after.
- **Shift-over-shift deltas.** Compare the current shift's operating
  envelope + event log against the same shift last week / last cycle.
  Narratives highlight what's actually new — not the noise.

---

## 3. Equivalency — why it pairs with the Knowledge Hub

*(Formerly the "Why this pairs with the Knowledge Hub" section on the
Equivalency explainer page.)*

When a vendor proposes an alternative approach — a different cooling
topology, a non-standard fuel handling sequence, a new digital I&C
architecture — the licensee has to make an equivalency case against CNSC
expectations.

The Knowledge Hub proves the retrieval + citation posture works on the
regulatory side. Equivalency applies that same posture to the submission
side: a vendor PDF becomes a set of claim-clause pairs, each pair is
retrieved against the REGDOC corpus that already sits in the Knowledge
Hub, and the comparison is rendered with the same requirement/guidance
colour contract. Same engine, different entry point.

The three pillars a real Equivalency surface would have to get right:

- **Claim ↔ clause matching.** Vendor submissions rarely line up 1:1 with
  the CNSC clause they're meant to satisfy. Equivalency maps each claim to
  the exact section it's addressing and flags gaps where a claim doesn't
  cover the clause's intent.
- **Defensible equivalency case.** Build the write-up your licensing team
  would actually hand to a regulator: what the clause requires, what the
  vendor approach does, why the two are equivalent or different, and the
  residual risk if any.
- **Traceable evidence.** Every paragraph of the equivalency case links
  back to the source it's quoting — REGDOC section, CSA standard clause,
  or vendor submission page — with the same Sources-panel contract the
  Knowledge Hub uses.

---

## 4. The stack, in full

*(Long answer to "What stack is this on?" from the FAQ.)*

- **Frontend.** Next.js 16 App Router; assistant-ui for the chat surface;
  Tailwind 4 + shadcn/ui; design tokens in `globals.css` map to Appendix G
  of the project plan.
- **Backend.** Next.js Route Handlers under `app/api/`. No separate backend
  service. Every handler goes through a `withGuard()` wrapper that owns
  rate limiting, input validation, and the daily circuit breaker.
- **LLM.** OpenAI `text-embedding-3-small` for retrieval, `gpt-4o-mini` for
  generation. Max token caps are scaled per tier.
- **Vector DB.** Supabase pgvector (1536 dims), HNSW index. Swapped in from
  ivfflat after smoke tests showed weaker top-3 recall.
- **Database.** Supabase Postgres. RLS enabled on every table; runtime uses
  anon key only; all reads + writes go through `SECURITY DEFINER` RPCs.
- **Rate limiting.** Upstash Redis + `@upstash/ratelimit` sliding window,
  tier-aware per Appendix J.
- **Auth.** Supabase Auth — magic link, cookie-based session via
  `@supabase/ssr`.
- **Deploy.** Cloudflare Workers via `@opennextjs/cloudflare`.
- **Package manager.** Bun.

Portable to Azure OpenAI + Cosmos DB vector + Azure Cognitive Search — the
only code that would change is in `lib/openai.ts` and `lib/supabase.ts`.

---

## 5. Rate limit rationale (anon vs signed-in vs industry domain)

*(Long answer to "How many questions can I ask?" from the FAQ.)*

Anon (no sign-in): 3 per minute, 10 per hour, 5 per day. Sign in for a
comfortable 50/day. Evaluators from nuclear-industry domains
(`npxinnovation.ca`, `brucepower.com`, `opg.com`, `cnsc-ccsn.gc.ca`,
`cameco.com`, `uwaterloo.ca`) are auto-lifted to 100/day via a
`get_user_tier()` RPC that reads the email domain at sign-in.

Why the limits are tight: the whole thing runs on Raj's personal OpenAI
wallet. The ceiling isn't about gatekeeping — it's about surviving a
worst-case scenario where the demo ends up on Hacker News and every
`gpt-4o-mini` call costs real money. Tier bumps exist so evaluators from
the target companies can poke at it without hitting a wall.

---

## 6. Out-of-corpus behavior — the two fallbacks

*(Long answer to "What happens if I ask something outside the corpus?"
from the FAQ.)*

Two fallback responses, deliberately distinguished:

- **Not in corpus.** The question is clearly off-topic — medical advice,
  personal opinions, non-CNSC regulation. The top-1 retrieval similarity
  is below 0.40, so the LLM is never invoked. Response is a plain
  "this is outside what I can answer" message.
- **Low confidence.** The question is in-topic but the indexed documents
  don't cover it. Top-1 similarity clears the 0.40 gate but average
  similarity is below 0.35. The LLM is invoked with a "limited context"
  disclaimer baked into the system prompt, and the response is forced to
  say it isn't confident.

In neither case does the assistant guess or fabricate citations. This was
enforced both at the prompt level and by the eval battery — three
adversarial questions specifically test that the fallbacks fire.

---

## 7. What is and isn't logged

*(Long answer to "Are my questions logged?" from the FAQ.)*

Logged per request:

- Timestamp, route, HTTP status, latency
- Tier (anon / signed-in / industry) and hashed user ID
- Hashed IP (daily-rotating salt — so correlation is possible within
  a day, impossible across days)
- Prompt version ID
- Retrieval similarity scores (top-1, avg of top-K)
- Guard events: rate-limit hits, circuit-breaker trips, output-guard
  truncations

Never logged:

- Raw query text
- Raw answer text
- Retrieved chunk bodies
- Email addresses
- Session cookies / auth tokens

The full field list lives in the project plan (Appendix H.6). If you want
to audit it, the code's in `lib/logger.ts`.

---

*End of carved-out material. Anything else pruned off the marketing pages
that seems worth a post will land here under a new section.*
