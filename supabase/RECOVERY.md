# Supabase recovery runbook

## What happened

The Supabase project this repo was built against (`ptepxophdneugvcziqny`) was
**deleted**. Confirmed by `nslookup ptepxophdneugvcziqny.supabase.co` →
`NXDOMAIN` (a *paused* project still resolves and returns a "paused" response;
a deleted one is gone from DNS entirely).

Symptom: every database-backed route returns HTTP 500 —
`app/api/knowledge-hub/query` returns `"Retrieval failed."`, the Generator
returns `"Snapshot retrieval failed."`, auth/tier lookups fail. The app code is
fine; the database it points at no longer exists.

## What was missing (and is now fixed)

The foundational schema — `regdoc_chunks` + HNSW index, `plant_status` /
`work_orders` / `shift_log_entries`, the `match_regdoc_chunks` /
`get_turnover_snapshot` / `get_user_tier` RPCs, the `profiles` table, and the
`handle_new_user` trigger — was originally applied **pre-CLI, directly in the
Supabase SQL editor**, and was never committed as migration files (see PLAN.md
decision 2026-04-17). Only April-17-onward changes became real migrations.

That meant `supabase db push` against a fresh project would rebuild
`chat_threads` and `generated_reports` but **not the RAG core** — the app would
still be broken.

This has been fixed: the foundational DDL was reconstructed verbatim from
PLAN.md Appendix A into five migrations, timestamped `20260416120000`–
`20260416120400` so they apply before the earliest committed migration:

| File | Appendix | Creates |
|---|---|---|
| `20260416120000_enable_vector_extension.sql` | A.1 | `vector` extension |
| `20260416120100_core_tables.sql` | A.2 | `regdoc_chunks` (+HNSW), `plant_status`, `work_orders`, `shift_log_entries` |
| `20260416120200_core_rls.sql` | A.3 | RLS enable + revoke on the four core tables |
| `20260416120300_rpc_functions.sql` | A.4 | `match_regdoc_chunks`, `get_turnover_snapshot` + grants |
| `20260416120400_auth_profiles_and_tier.sql` | A.6 | `profiles` + RLS, `handle_new_user` trigger, `get_user_tier` |

The full migration set (14 files) is now self-sufficient: a fresh project can
be rebuilt entirely with `supabase db push`.

## Rebuild steps

These require a Supabase account and cannot be done by an agent.

1. **Create a new Supabase project** at https://supabase.com/dashboard. Note
   the new project ref, URL, anon key, and service-role key.

2. **Link the repo to the new project:**
   ```sh
   bunx supabase link --project-ref <NEW_PROJECT_REF>
   ```

3. **Apply all migrations** (the new project has empty migration history, so
   all 14 apply in order — the reconstructed foundational five first):
   ```sh
   bunx supabase db push
   ```
   This builds the full schema and runs the Bruce Power seed data. It does
   **not** populate `regdoc_chunks` — that table is filled by ingestion.

4. **Update `.env.local`** with the new project's values:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<NEW_PROJECT_REF>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<new anon key>
   SUPABASE_SERVICE_ROLE_KEY=<new service-role key>
   SUPABASE_DB_PASSWORD=<new db password>
   ```

5. **Ingest the REGDOC corpus** (embeds `scraped_regdocs/` into
   `regdoc_chunks` — needs `OPENAI_API_KEY` + `SUPABASE_SERVICE_ROLE_KEY`):
   ```sh
   bun run ingest
   ```

6. **Restart the dev server** so it picks up the new `.env.local`, then verify:
   ```sh
   bun run evals:security      # grounded rows grd-01/grd-02 should pass 2/2
   bun run eval:kb             # hard eval suite — confirm no regression
   ```

7. **Update the deploy environment** — set the same four Supabase vars in the
   Cloudflare dashboard (Settings → Variables and Secrets). Note
   `SUPABASE_SERVICE_ROLE_KEY` is **never** set in Cloudflare — ingestion runs
   locally only.

## Preventing this gap in future

All DB changes already go through `supabase migration new …` (CLAUDE.md
CLI-first rule, in force since 2026-04-17). The reconstructed migrations close
the one remaining pre-CLI gap. Keep the rule: no schema or function changes via
the SQL editor — if it isn't a migration file, it doesn't survive a project
loss.
