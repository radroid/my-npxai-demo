# Local Supabase — runbook

Run the whole Supabase stack (Postgres 17 + pgvector, PostgREST, GoTrue auth, Studio, mail catcher) on the Mac mini in Docker. **$0/month, never auto-pauses.**

Everything below was executed end-to-end on 2026-07-14, not just written down. Numbers are measured, not estimated.

**Read [§ What local can and cannot do](#what-local-can-and-cannot-do) before you assume this replaces the hosted project. It does not — the deployed demo still needs it.**

---

## Why

The hosted free-tier project has auto-paused three times. A paused project takes the RAG eval battery down with it (`bun run eval:rag*` had no DB to read). Local Postgres removes both the cost and the pausing for everything that isn't the public demo.

---

## Prerequisites

| Need | Detail |
|---|---|
| Docker Desktop | Must be **running**. `open -a Docker`, wait for the whale icon. Verify: `docker info`. |
| Docker memory | The stack idles at **~1.9 GB RSS** across 12 containers. Docker's 8 GB default is plenty; don't go below 4 GB. |
| Disk | **~8.9 GB** of images once pulled (first `supabase start` downloads them; subsequent starts are cached). |
| Supabase CLI | Already installed (Homebrew, v2.104.0). The `db:local:*` scripts call `bunx supabase`, so they work even on a fresh clone with no global install. |

---

## Everyday commands

```bash
bun run db:local          # start the stack (first run pulls images; after that ~30s)
bun run db:local:status   # print URLs + keys
bun run db:local:studio   # open Studio in a browser
bun run db:local:stop     # stop, KEEPING data (see below)
bun run db:local:reset    # wipe + replay every migration + seed.sql  ⚠️ destroys data
```

| Service | URL |
|---|---|
| API / PostgREST | `http://127.0.0.1:54321` |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| Studio (table editor, SQL) | `http://127.0.0.1:54323` |
| Inbucket / Mailpit (catches all outbound mail) | `http://127.0.0.1:54324` |

---

## Point the app at local

`.env.local` holds your real hosted secrets — **this repo never rewrites it for you.** Swap these three lines by hand; leave `OPENAI_API_KEY` and `UPSTASH_*` alone (those still hit the real services):

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU
```

Keep your hosted values commented out directly above them so switching back is one comment-swap. The same block lives in `.env.example`.

**Those two JWTs are not secrets.** They're the stock Supabase local demo keys (`iss: supabase-demo`) — byte-identical on every `supabase start` on every machine, published in Supabase's docs, signed with the well-known local JWT secret. They unlock a Postgres on your own laptop and nothing else. That's why they can sit in a committed file. Never do this with hosted keys.

Restart the dev server after editing `.env.local` — Next.js only reads env at boot.

> **Careful:** Bun auto-loads `.env.local` for every `bun run`. Inline env vars **do** override it (verified), which is why the ingest command below is safe — but it also means a `bun run` with no inline vars silently talks to whatever `.env.local` currently points at. Check which DB you're on before destructive work.

---

## Migrations

`supabase/migrations/` is the source of truth. 15 migrations, all replay clean.

```bash
bun run db:local:reset     # local: wipe + replay all migrations, then seed.sql
bunx supabase db push      # hosted: apply only NOT-yet-applied migrations. Does NOT run seed.sql.
```

- **`db reset`** is the local workhorse — destructive and idempotent. Use it freely; it's the only way to prove the migration chain works from zero.
- **`db push`** is the hosted path. It never runs `seed.sql`, so local-only tweaks in that file can't leak to production.

New migration: `bunx supabase migration new <name>`, edit the generated file, `bun run db:local:reset` to test, then `bunx supabase db push` when you're ready to ship it to hosted.

### `seed.sql` — local-only, and load-bearing

`supabase/seed.sql` raises `statement_timeout` for `service_role` to 120s. Without it, ingest **intermittently** dies:

```
insert failed at batch 3: canceling statement due to statement timeout
```

PostgREST logs in as `authenticator` (`statement_timeout=8s`) and `SET ROLE`s to `service_role`, which had no override. Each 500-row batch of 1536-dim vectors has to maintain the HNSW index, and on a busy machine that tips past 8s. It's load-dependent, so it looks flaky — it succeeded on the first run and died mid-run on the second, leaving **1,500 of 1,945 rows** in the table. A truncated corpus that still *looks* fine is worse than a clean failure: the evals would quietly score against a partial index. The `anon` (3s) and `authenticator` (8s) caps are deliberately untouched — they guard the request path the app actually serves.

---

## Re-ingest the corpus

Needs `scraped_regdocs/` (gitignored, 21 files). Costs **~2¢** of OpenAI embeddings (`text-embedding-3-small`, ~780k tokens). The script truncates `regdoc_chunks` first, so it's idempotent.

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_SERVICE_ROLE_KEY=$(bunx supabase status -o env | grep '^SERVICE_ROLE_KEY=' | cut -d'"' -f2) \
bun run ingest
```

`OPENAI_API_KEY` is picked up from `.env.local` automatically — you never have to paste it. The inline vars override Bun's autoload, so this targets local **even while `.env.local` still points at hosted**. That's the one command you can run without swapping env first.

Expected tail:

```
  total chunks in DB: 1945
  chunks with NULL embedding: 0  (expect 0)
  smoke query "shift turnover" → 3 matches
✅ Ingestion complete
```

**1,945 chunks across 19 docs.** Anything materially lower means a batch timed out — check `seed.sql` applied (`bun run db:local:reset` runs it).

---

## Auth works locally — including magic links

Real GoTrue, real JWTs, real sessions. No code changes needed:

- The app builds its redirect from `window.location.origin` (`components/site/SignInButton.tsx`), so on `localhost:3001` the magic link points back at `localhost:3001/auth/callback` — already in `additional_redirect_urls` in `config.toml`.
- **No mail leaves your machine.** Every outbound email is captured by Inbucket/Mailpit. Sign in, then open **`http://127.0.0.1:54324`**, click the newest message, and follow the magic link.
- The `handle_new_user` trigger provisions a `profiles` row and assigns the tier automatically. Verified: `raj9dholakia@gmail.com` → `npx_circle`, `@brucepower.com` → `npx_circle`, everything else → `signed_in`.

Wipe local test users any time:

```bash
docker exec -i supabase_db_my-npxai-demo psql -U postgres -d postgres -c "delete from auth.users;"
```

---

## Stopping: keep data vs. wipe

```bash
bun run db:local:stop            # stops containers, KEEPS the Postgres volume. Data survives.
bunx supabase stop --no-backup   # stops AND DELETES the volume. Everything gone. ⚠️
```

`supabase stop` on its own is **safe** — it snapshots the DB and your 1,945 chunks are still there on the next `db:local`. `--no-backup` skips that snapshot and drops the volume, so you'd have to re-run migrations *and* re-ingest (another 2¢). Reach for `--no-backup` only when you actually want a clean slate.

Rebuilding from scratch is always: `bun run db:local` → `bun run db:local:reset` → re-ingest.

---

## Keeping it alive across Mac mini reboots

The Mac mini is up most of the time, so make the stack come back on its own.

**1. Docker Desktop on login** *(do this one)* — Docker Desktop → Settings → General → check **"Start Docker Desktop when you sign in"**. Without this nothing else matters; the containers can't start if the daemon isn't up.

**2. Auto-start the stack.** Supabase containers use Docker's default restart policy, so they do **not** come back on their own after a reboot. Either run `bun run db:local` when you need it (it's ~30s and honestly fine), or install a login agent:

```bash
cat > ~/Library/LaunchAgents/dev.curlycloud.supabase-local.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.curlycloud.supabase-local</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <!-- Wait for the Docker daemon to accept connections, then start. -->
    <string>until /usr/local/bin/docker info >/dev/null 2>&1; do sleep 5; done; cd /Users/rajdholakia/Documents/3-job-hunt/npx/my-npxai-demo && /opt/homebrew/bin/supabase start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/supabase-local.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/supabase-local.err.log</string>
</dict>
</plist>
PLIST

launchctl load ~/Library/LaunchAgents/dev.curlycloud.supabase-local.plist
```

The `until docker info` guard is the important bit — a login agent races Docker Desktop's daemon and fails instantly without it. Logs land in `/tmp/supabase-local.*.log`. Remove with `launchctl unload <plist>`.

**3. Trim the idle footprint (optional, ~550 MB back).** Analytics/Logflare is the single biggest consumer (551 MB RSS, 927 MB image) and nothing in this app reads it. In `config.toml`:

```toml
[analytics]
enabled = false
```

Left **on** by default here — it's the CLI default and turning it off changes a committed, shared config. Flip it if you want the RAM back on an always-on box.

Stale images from older CLI versions are worth reclaiming too — `docker system df` reported **10.3 GB (54%) reclaimable**. `docker image prune -a` gets it back.

---

## Security note (it's an always-on box)

`supabase start` prints this, and on a Mac mini that lives on your LAN it deserves a second read:

> All services bind to 0.0.0.0 (network-accessible, not just localhost). API keys and JWT secrets are shared defaults. Studio, pgMeta and analytics have no authentication.

So **anyone on your home network can reach Studio on :54323 and Postgres on :54322 with the default `postgres:postgres` credentials.** That's fine behind a home router; it is not fine on a café Wi-Fi or a network you share with people you don't control. Don't port-forward these. See the Tunnel option below for why exposing this to the internet is a bad trade.

---

## What local can and cannot do

**This is the part that matters. Local Supabase does not replace the hosted project.**

The deployed demo runs on **Cloudflare Workers** (`npxai-demo`, at `npx.curlycloud.dev`). Cloudflare's edge cannot reach `127.0.0.1` on your Mac mini — `localhost` means *the Worker's own sandbox*, not your machine. There is no configuration that changes this.

| Workload | Local Supabase? |
|---|---|
| `bun dev` on :3001 | ✅ |
| `bun run ingest` — corpus + embedding experiments | ✅ |
| `bun run eval:kb`, `bun run evals:security` | ✅ |
| The whole `bun run eval:rag*` battery | ✅ **this is what was blocked** |
| Schema/migration work before it hits hosted | ✅ |
| **The public demo URL you send to NPX** | ❌ **needs a reachable, hosted DB** |

Everything expensive and everything that was blocked is now local. The one thing local can't serve is the one thing that has to stay up when a hiring manager clicks the link.

### Options for the deployed demo

**(a) Keep the hosted free project + a keep-alive cron.** ✅ **Recommended.**

Supabase pauses free projects after ~7 days of inactivity. Any query resets that clock, so a scheduled ping keeps it awake. Cost: **$0** — Supabase free tier, and Cloudflare Cron Triggers are free.

A **weekly** cron races the 7-day boundary; one missed run and you're paused. Ping **daily**. It's a single cheap request.

Deploy a standalone keep-alive Worker (kept separate from `npxai-demo` so it doesn't touch the OpenNext build):

```js
// keepalive/src/index.js
export default {
  async scheduled(_event, env, ctx) {
    // Cheapest possible authenticated read — enough to count as activity.
    ctx.waitUntil(
      fetch(`${env.SUPABASE_URL}/rest/v1/regdoc_chunks?select=id&limit=1`, {
        headers: {
          apikey: env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
        },
      }).then((r) => console.log("keepalive", r.status)),
    );
  },
};
```

```jsonc
// keepalive/wrangler.jsonc
{
  "name": "npxai-keepalive",
  "main": "src/index.js",
  "compatibility_date": "2025-09-23",
  "triggers": { "crons": ["0 7 * * *"] }  // 07:00 UTC daily
}
```

```bash
cd keepalive
bunx wrangler secret put SUPABASE_URL        # https://<ref>.supabase.co
bunx wrangler secret put SUPABASE_ANON_KEY   # the HOSTED anon key
bunx wrangler deploy
bunx wrangler tail npxai-keepalive           # confirm it fires
```

Anon key is enough — `regdoc_chunks` is readable through the anon path the app already uses, and nothing here needs `service_role`. If you'd rather not stand up a second Worker, a GitHub Actions `schedule:` job doing the same `curl` is equally free.

> Not yet built — this runbook stops at the local DB. Ship it before the next 7-day idle window.

**(b) Expose the Mac mini through a Cloudflare Tunnel.** ❌ **Don't do this for a demo a hiring team will open.**

Technically works (`cloudflared` gives the Worker a public hostname for your local PostgREST). The real costs:

- **Your home uptime becomes the demo's uptime.** ISP blip, macOS update, someone unplugs it — the link a hiring manager clicked is dead, and you won't know.
- **You're publishing Postgres/PostgREST from your house.** See the security note above: default credentials, unauthenticated Studio, everything bound to `0.0.0.0`. You'd have to re-key the JWT secret, lock down Studio, and firewall the ports *before* this is even arguable.
- **Key management gets worse, not better** — you now maintain a second set of production-grade secrets on a machine that isn't managed like production.

Trading a free, managed, always-up Postgres for a home-network dependency is a bad trade when the entire point is that a stranger clicks a link and it works.

**(c) Self-host Supabase on the Mac mini for everything.** Sensible in general, wrong for *this*. Same home-uptime dependency as (b), plus you now own backups, upgrades, and TLS — real work that isn't what you're being hired to demonstrate.

### Recommendation

**Hybrid.** Local for dev, evals, ingest, and schema work — that's where the money and the blocking were. Hosted free project **plus the daily keep-alive** for the public demo, because it has to be up when someone else clicks it.

Total cost: **$0/month**, and the eval battery stops being hostage to a pause.

---

## Unblocked by this

The RAG eval battery was blocked on the paused hosted project. With local up, all of these run:

```bash
bun run ingest            # corpus → local pgvector
bun run eval:kb           # knowledge-base evals
bun run evals:security    # prompt-injection battery
bun run eval:rag          # RAG eval framework
bun run eval:rag:golden   # generate the golden set
bun run eval:rag:report   # scored report
```

The eval runners POST to the dev server, so it needs to be running (`bun dev`, :3001) with `.env.local` pointed at local, and `EVAL_BYPASS_KEY` set — without it the anon tier caps the run at 3 req/min and the first 429 aborts it.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Cannot connect to the Docker daemon` | Docker Desktop isn't running. `open -a Docker`, wait, retry. |
| `insert failed at batch N: canceling statement due to statement timeout` | `seed.sql` didn't apply. `bun run db:local:reset` (it runs seed), then re-ingest. |
| `500: Database error saving new user` on sign-in | The `handle_new_user` search_path bug — fixed in `20260714000000_fix_handle_new_user_search_path.sql`. Make sure you're on a DB that has it: `bun run db:local:reset`. |
| Magic-link email never arrives | It didn't leave the machine, by design. It's in Inbucket: `http://127.0.0.1:54324`. |
| Chunk count < 1945 | A batch timed out mid-run and the table is half-populated. Re-ingest; check `seed.sql`. |
| Port already in use | Something else owns 54321-54324. `bunx supabase stop`, then `bun run db:local`. |
| App still hitting hosted after editing `.env.local` | Next.js reads env at boot — restart the dev server. |
