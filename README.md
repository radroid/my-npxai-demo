# NPXai Demo

A working demonstration of a grounded, citation-aware AI assistant for the Canadian nuclear industry — built as a portfolio piece for the team at **[NPX Innovation](https://npxai.com)**.

The intent is simple: three of the "Learn More" links on npxai.com currently go to `#`. This project is a working version of what two of those features could look like, built end-to-end on the same stack NPX uses.

---

## What this demo does

**1. Knowledge Hub** — a RAG-based chat over real CNSC regulatory documents (REGDOCs).
Ask a plain-language regulatory question; get a grounded answer with clickable citations back to the source document and section, with `shall/must` requirements visually distinguished from `should/may` guidance.

**2. Shift Turnover Generator** — a structured report generator over simulated CANDU plant data.
Pick a station, unit, and shift; generate a turnover report in the structure expected by REGDOC-2.3.4 (Plant Status, Safety System Availability, Active Work & Clearances, Key Events, Watch Items, Recommended Actions).

**3. Homepage + static explainer pages** for the remaining features on npxai.com (Insights, Equivalency Evaluator), so the full product surface tells a coherent story.

---

## Architecture

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | Next.js 16 App Router + TypeScript + Tailwind + shadcn/ui | Aligns with the Senior Full Stack Developer stack. |
| Chat UI | [assistant-ui](https://www.assistant-ui.com) (Thread, ThreadListSidebar, streaming, markdown) | Production-grade chat primitives; citations render as first-class elements. |
| Backend | Next.js Route Handlers (`app/api/*`) | One repo, one deploy, no CORS, all TypeScript. |
| LLM | OpenAI `text-embedding-3-large` (3072-dim, stored as `halfvec`) + `gpt-4o-mini` | Larger embedding measurably improves retrieval (hit@8 95.7%→96.7%, recall@8 82.6%→86.0%); `halfvec` keeps storage flat. Costs negligible for demo traffic. |
| Vector store | Supabase `pgvector` | Functionally equivalent to Cosmos DB vector search. Free tier, persistent. |
| Database | Supabase Postgres | Same instance — structured tables for simulated plant data and thread history. |
| Deploy | Cloudflare Workers via `@opennextjs/cloudflare` | Near-zero cold starts, free tier, single-command deploy. |

> **Portability note:** the architecture is deliberately portable to Azure — Azure OpenAI in place of OpenAI, Cosmos DB vector in place of pgvector, Azure Cognitive Search for hybrid retrieval. Same interfaces, different providers.

---

## RAG pipeline

```
User question
  → OpenAI text-embedding-3-large (embed query, 3072-dim)
  → Supabase pgvector similarity search (top 8-10 chunks)
  → rerank by relevance
  → system prompt: "You are a CNSC regulatory expert. Answer using
     ONLY the provided context. Cite specific REGDOC sections. Distinguish
     requirements (shall/must) from guidance (should/may). Format
     citations as [REGDOC-X.X.X §Y.Z]."
  → OpenAI gpt-4o-mini (streaming)
  → stream to assistant-ui Thread; citations parsed into clickable chips;
    sources panel renders retrieved chunks
```

Ingestion covers 15 priority CNSC REGDOCs (REGDOC-2.3.4 Operations Programs, REGDOC-2.2.5 Minimum Staff Complement, REGDOC-2.2.2 Personnel Training, REGDOC-2.6.3 Aging Management, and others spanning management, accident management, radiation protection, design, emergency management, waste, and security). Chunks carry `regdoc_id`, `section_number`, `section_title`, `url`, and a `requirement_type` tag derived from the language of the chunk.

---

## Getting started

### Prerequisites

- [Bun](https://bun.sh) (package manager)
- OpenAI API key
- Supabase project with `pgvector` enabled

### 1. Install

```bash
bun install
```

### 2. Environment

Copy `.env.example` to `.env.local` and fill in:

```bash
OPENAI_API_KEY=sk-...
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

### 3. Supabase schema

Enable the extension and create the tables:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE regdoc_chunks (
  id BIGSERIAL PRIMARY KEY,
  regdoc_id TEXT NOT NULL,
  title TEXT NOT NULL,
  section_number TEXT,
  section_title TEXT,
  chunk_text TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  url TEXT,
  requirement_type TEXT,
  embedding HALFVEC(3072),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ON regdoc_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE plant_status (
  id BIGSERIAL PRIMARY KEY,
  unit_id TEXT NOT NULL,
  parameter TEXT NOT NULL,
  value TEXT NOT NULL,
  unit_of_measure TEXT,
  status TEXT DEFAULT 'normal',
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE work_orders (
  id BIGSERIAL PRIMARY KEY,
  wo_number TEXT NOT NULL,
  unit TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  assigned_to TEXT,
  clearance_required BOOLEAN DEFAULT FALSE,
  shift TEXT
);

CREATE TABLE shift_log_entries (
  id BIGSERIAL PRIMARY KEY,
  unit TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  operator_role TEXT NOT NULL,
  entry TEXT NOT NULL,
  category TEXT,
  severity TEXT DEFAULT 'routine'
);
```

### 4. Run

```bash
bun dev
```

Open [http://localhost:3001](http://localhost:3001). (Dev + start scripts pin port 3001 so the eval/tier-test scripts hit the right origin by default.)

### 5. Deploy

```bash
bunx wrangler deploy
```

---

## Project layout

```
app/
├── api/
│   ├── knowledge-hub/query/route.ts   # RAG endpoint
│   ├── generator/plant-status/route.ts
│   ├── generator/work-orders/route.ts
│   ├── generator/turnover/route.ts    # Structured turnover report
│   └── chat/                          # assistant-ui chat API
├── knowledge-hub/page.tsx             # RAG chat over CNSC REGDOCs
├── generator/page.tsx                 # Shift turnover generator
├── insights/page.tsx
├── equivalency/page.tsx
├── layout.tsx
└── page.tsx                           # Homepage
components/
├── assistant-ui/                      # Thread, sidebar, markdown, tools
└── ui/                                # shadcn primitives
```

---

## Why this demo, for NPX specifically

- **Real data, real answers.** Questions like *"What are the CNSC requirements for shift turnover?"* return grounded, cited answers from actual regulatory documents. Not a mockup, not hand-written copy.
- **Three broken links → two working features.** The demo literally fills the gaps on npxai.com's current homepage.
- **Covers both roles.** The RAG pipeline demonstrates the AI Developer skill set (embeddings, vector retrieval, prompt design, streaming). The Next.js/TypeScript/React frontend demonstrates the Senior Full Stack Developer skill set. Same codebase.
- **Nuclear domain fluency.** Real CANDU terminology, real operator roles (SM, CRSS, ANO), real REGDOC-2.3.4 turnover structure. The language is not generic.

---

## Author

Built by **Raj Dholakia** as a demonstration for the NPX Innovation team.

- Nuclear engineering background
- 4 years shipping AI products
- Reach me on LinkedIn, or via the contact form on the live demo
