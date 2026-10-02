# Phase 12 — multi-source corpus: operator guide and hosted runbook

Spec: `PLAN.md` → "Phase 12 — source-aware regulatory expansion". Checklist: `TODO.md` → Phase 12.
This file is the **how**: flags, local workflow, the release checks, and the hosted rollout. The hosted rollout is **held for Raj's go-ahead**. Nothing here has been run against the hosted project.

---

## 1. What changes for a user

- A **Sources** picker sits next to the Chat/Artifact toggle, and you pick sources the way you'd pick a model in a chat app:
  - **Auto** is the default. It uses the regulator your question names; if the question names none, it uses CNSC. It compares only when you ask it to compare.
  - **A pinned regulator** (CNSC · NRC · ONR · EU/Euratom) stays pinned on every question until you change it.
  - **Include superseded editions** brings older editions back into the search.
- Reference-only catalogues (IAEA, AERB, the Fukushima reports) appear in the picker greyed out, with the reason. Their text is never stored.
- Answers cite `[[S1]]`-style snippet ids, and the server turns each one into a verified chip showing document, section or page, edition and a link. An id the model invents shows as **unverified**.
- If a question falls outside the selected sources, it gets a deterministic notice with one-click switches, never an answer built from the wrong regulator. A notice costs no model call.

## 2. Flags and rollback

| Switch | Where | Effect |
|---|---|---|
| `KH_SOURCE_CORPUS` | Worker env (server-only) | `legacy` (default/unset): pre-Phase-12 behaviour exactly (`regdoc_chunks`, CNSC prompt, no picker). `v2`: new corpus, citations and picker. Exact match only; anything else means legacy. A register that fails validation also forces legacy. |
| `KH_COLLECTIONS` | Worker env (server-only) | Comma list of collections v2 may answer from. Default `cnsc`. Collections with no current text (IAEA, AERB, Fukushima) can never be enabled. |
| `source_collections.searchable` | Database | Per-collection kill switch for `match_source_chunks`, with no deploy needed: `bun run sources:searchable <id> on\|off`. The database refuses to open IAEA (CHECK constraint). |

**Rollback options:**
- **Whole feature:** set `KH_SOURCE_CORPUS=legacy`. This takes effect on the next request, and nothing is deleted.
- **One collection:** run `bun run sources:searchable nrc off`. This takes effect immediately.
- **Old CNSC path:** `regdoc_chunks` and `match_regdoc_chunks` are untouched and stay the legacy path.

The migration is **additive**. It doesn't alter any existing table or RPC, so merging the code doesn't depend on applying it: with the default flag the app never calls the new RPC. This is the opposite of PR #13's in-place swap, and it has no outage window.

## 3. Local workflow

Use an isolated local stack (`bun run db:local`, or a second project on other ports). Every script refuses a non-loopback Supabase URL unless you pass `--force`.

```bash
bun run sources:fetch              # verify cached bytes against pinned sha256 (no network if cached)
bun run sources:fetch --pin        # first fetch of new entries; records sha256 + size in the register
bun run sources:publish --dry-run  # parse + quality gate + chunk, no API/DB
bun run sources:publish            # metadata rows, CNSC backfill (no re-embedding), parse → embed → atomic publish
bun run sources:searchable nrc on  # (and onr, eu) — open collections locally
bun run sources:audit --pages      # register ↔ DB consistency, rights, links, PDF page spot-check
bun run sources:recall             # approximate vs exact search through the production RPC
bun run sources:parity             # legacy vs v2-pinned-CNSC retrieval on the 92 golden questions
bun run sources:calibrate          # per-collection refusal gate check
bun run eval:sources --suite sources            # 24 routing/legal-force/notice cases (real model)
bun run eval:sources --suite cnsc --corpus v2 --repeat 3   # CNSC battery pinned to CNSC
bun run test:sources               # offline unit harness
```

**Manual import for blocked hosts.** `www.nra.go.jp` returns 403 to the identifying non-browser user agent. We don't spoof a browser, so those two entries are `ingest: false`. To include them, download each PDF in a browser and run `bun run sources:fetch --import <document_key>@<version_key> <file>`. That verifies and pins the file. Then set `ingest: true` and re-run publish. They also need a rights decision first; see PLAN.md → Needs human decision.

**Cost.** A full publish from empty embeds about 6.4k chunks, roughly 3M tokens or about $0.40 with text-embedding-3-large. The CNSC backfill copies the existing embeddings, so it costs nothing. Audit, parity, recall and calibration only embed questions (under $0.01). The two eval suites call the chat model: about 24 + 32×3 generations with gpt-4o-mini.

## 4. Release evidence (local, 2026-10-01)

Reports live in `corpus/reports/`. The numbers come from the local stack with real OpenAI calls.

| Check | Result | Caveat |
|---|---|---|
| Audit | 0 fails, 0 warns. 103 register entries = 103 DB rows. No chunks in IAEA/AERB/Fukushima or in any metadata-only/draft entry. All canonical and locator URLs allowlisted. | — |
| PDF pages | 108/108 sampled chunks found on their cited page range, using an independent pdf.js extraction. | The first run had 1 miss in 108 samples. Tracing it found 2 RG 8.10 chunks whose sentence crossed a page break but were labelled with their first page only. Fixed in the chunker, re-published, re-checked. |
| Recall (production RPC) | 1.000 recall@8 and @20 on every scope. | **This says nothing about HNSW.** At about 8.6k chunks the planner answers with an exact scan + sort (verified with EXPLAIN), so the result is exact by construction. |
| Recall (forced HNSW) | `scripts/sources/sql/hnsw-forced-recall.sql`: stored-chunk probes 0.995–1.000. "Mixed" probes 0.935 (CNSC) to 0.995 (ONR), 0.943 across all collections. | Synthetic probes, not questions. This is what the app would get once the corpus grows enough for the planner to choose the index. Re-run both checks when it does, and consider ef_search 200 then. |
| Parity (CNSC) | Unchanged documents: legacy 57/59 hit@8, v2 57/59, nothing lost, OOS gate agrees on all 59. Refreshed documents: legacy 33/33, v2 29/33. | The 4 losses: s011/s029/s047 cite REGDOC-2.5.2 (2014) sections that v2.1 renumbered (hazard analysis §9.3 → §7.3). h006's gold §4.3 was at rank 8 and is displaced by a new-edition preface chunk. |
| Calibration | CNSC/ONR/EU: the legacy 0.40 gate answers all in-scope questions and refuses all off-topic ones. NRC: "melting point of uranium-235" reached 0.401, so NRC's gate moved to 0.44, the smallest move with a 0.03 margin. The lowest in-scope NRC question scored 0.681. | 8–14 in-scope and 12 off-topic author-written probes per collection. Small n. |
| Sources suite | 24/24 on the run after the prompt fixes. The first run was 22/24. | Author-written cases, 1 run since the fix. |
| CNSC battery, 3 runs | Legacy: ship 17/18/17 of 20, hard 10/11/11 of 12. v2 pinned CNSC: ship 18/17/18, hard 10/9/10. Adversarial 2/3 on both paths, every run. | See the per-case notes below. Neither path meets the ship bar, because adversarial #19 fails on both. The legacy path's code is unchanged from `main` (verified by diff), so #19 isn't introduced here, though it wasn't re-run on `main` itself. |

Per-case differences across the 3 runs (legacy → v2):
- **Better in v2:** #4 (1/3 → 3/3) and #25 (0/3 → 2/3).
- **Worse in v2:**
  - #21 (3/3 → 0/3): the case expects REGDOC-2.5.2 (2014) §7.3.4/§7.6.2. The current edition puts design extension conditions at §5.3.4/§6.6.12.
  - #26 (2/3 → 0/3): the expected phrases exist only in the 2018 *consultation draft* of REGDOC-2.1.1, which the legacy corpus serves as if it were the current document.
  - #8 (3/3 → 2/3): the expected phrase is present in the current edition, so treat this as variance or a possible regression, not drift.
- **Both fail every run:** #11 and #19.

## 5. Hosted rollout runbook (HELD — needs Raj's authorization)

Read `supabase/LOCAL.md` → "Applying to hosted" first. **Never `db push --include-all`** against hosted, and never `db reset --linked`.

1. **Preflight.**
   - Run `bunx supabase db push --dry-run --linked`. It must list **only** `20261001000000_source_documents_and_chunks.sql`.
   - If it lists the five reconstructed foundational migrations, stop and follow LOCAL.md's `migration repair` step. Do not add `--include-all`.
2. **Migrate:** `bunx supabase db push --linked`. This is additive, and only CNSC starts searchable in `source_collections`.
3. **Publish:**
   - On a machine with `corpus/.cache` populated (`bun run sources:fetch`), point `.env.local` at hosted with the service-role key.
   - Run `bun run sources:publish --force`.
   - This backfills CNSC from hosted `regdoc_chunks` (same model, same dims), embeds NRC/ONR/EU and the refreshed CNSC editions (about $0.40), and records the metadata-only entries.
4. **Check:**
   - `bun run sources:audit --force` must report 0 fails.
   - `bun run sources:parity --force` must report nothing lost in the unchanged group.
5. **CNSC first:**
   - Set `KH_SOURCE_CORPUS=v2` and `KH_COLLECTIONS=cnsc` on the Worker. Either `printf v2 | bunx wrangler secret put KH_SOURCE_CORPUS` (and the same for `KH_COLLECTIONS`), or add a `vars` block **with `"keep_vars": true`** to `wrangler.jsonc` and deploy. Without `keep_vars`, a deploy drops dashboard-set vars.
   - Smoke https://npx.curlycloud.dev in chat and artifact mode, in light and dark themes.
   - Check that a citation chip opens the right document and section.
6. **One collection at a time:**
   - Run `bun run sources:searchable nrc on --force`, then set `KH_COLLECTIONS=cnsc,nrc`.
   - Smoke an NRC question and a CNSC-vs-NRC comparison.
   - Repeat for `onr` and `eu`.
7. **Rollback** at any point: `KH_SOURCE_CORPUS=legacy` for the whole feature, or `sources:searchable <id> off` for one collection.

**Before step 5, decide one thing.** The legacy path, which prod serves today, answers REGDOC-2.1.1 questions from a 2018 consultation draft and serves 7 outdated CNSC editions. v2 fixes both. This is a reason to roll out v2 with CNSC, not to wait.

## 6. Re-check cadence

`corpus/register.json` sets `recheck_cadence_days: 180`. `bun run sources:audit` warns on any entry whose rights review is older than that (`--strict` turns warnings into failures). The source as-of date shows in the picker (per collection) and on every source card.
