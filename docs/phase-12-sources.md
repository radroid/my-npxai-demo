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
- Answers cite `[[S1]]`-style snippet ids, and the server turns each one into a verified chip showing document, section or page, edition and a link. An id the model invents shows as **unverified**, and so does a citation-looking slip such as `[[8 CFR 20.1201]]`.
- If a question falls outside the selected sources, it gets a deterministic notice with one-click switches, never an answer built from the wrong regulator. A notice costs no model call. "Outside" means a regime the question asks about: a comparison against it ("How do CNSC dose limits differ from the US?"), or its rules as the subject ("Is a PSA mandatory in Finland?"). A country as a place ("export tritium to a customer in Korea"), an event ("post-Fukushima requirements") or a reference CNSC itself uses ("the IAEA categorisation") is answered from the selected regulator.
- If an answer states an obligation ("required", "must") while citing only non-binding guidance, it ends with a **legal-force note**. The note names the guide and points to the regulation or licence condition that would carry the duty. The model is told not to do this, but gpt-4o-mini still does sometimes, so the note is added deterministically after generation.
- A **comparison** answer that quotes limits in both rem and sieverts and calls one higher or lower ends with a **units note** giving the exact mSv equivalent of every rem value (1 rem = 10 mSv). gpt-4o-mini has called 50 mSv "higher" than 15 rem (150 mSv).

## 2. Flags and rollback

| Switch | Where | Effect |
|---|---|---|
| `KH_SOURCE_CORPUS` | Worker env (server-only) | `legacy` (default/unset): pre-Phase-12 behaviour exactly (`regdoc_chunks`, CNSC prompt, no picker). `v2`: new corpus, citations and picker. Exact match only; anything else means legacy. A register that fails validation also forces legacy. |
| `KH_COLLECTIONS` | Worker env (server-only) | Comma list of collections v2 may answer from. Default `cnsc`. Collections with no current text (IAEA, AERB, Fukushima) can never be enabled. |
| `KH_V2_CHAT_MODEL` | Worker env (server-only) | v2 chat model. Default gpt-4o-mini; accepts gpt-4.1-nano or gpt-4.1-mini only (the spend guard's caps assume that price range), anything else falls back with a logged warning. Part of the answer-cache key. |
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
bun run sources:recall             # production RPC vs exact search, plus per-call latency (fails ≥ 2.5 s)
bun run sources:parity             # legacy vs v2-pinned-CNSC retrieval on the 92 golden questions
bun run sources:calibrate          # per-collection refusal gate check
bun run eval:sources --suite sources            # 46 routing/legal-force/notice cases (real model), split by provenance
bun run eval:sources --suite cnsc --corpus v2 --repeat 3   # CNSC battery pinned to CNSC
bun run test:sources               # offline unit harness
```

After a **CNSC parser change**, `sources:fetch` reports a CNSC text-hash mismatch on the cached page-data. CNSC is pinned by extracted text, so a parser change moves the hash. Review the extracted-text diff, then run `bun run sources:fetch --repin-cnsc`. It re-pins from the cached, already-reviewed bytes only, and refuses `--refresh`.

**Manual import for blocked hosts.** `www.nra.go.jp` returns 403 to the identifying non-browser user agent. We don't spoof a browser, so those two entries are `ingest: false`. To include them, download each PDF in a browser and run `bun run sources:fetch --import <document_key>@<version_key> <file>`. That verifies and pins the file. Then set `ingest: true` and re-run publish. They also need a rights decision first; see PLAN.md → Needs human decision.

**Cost.** A full publish from empty embeds about 6.4k chunks, roughly 3M tokens or about $0.40 with text-embedding-3-large. The CNSC backfill copies the existing embeddings, so it costs nothing. A rerun re-embeds only editions whose pinned checksum, parser + chunker version or embedding model changed; everything else just gets a metadata refresh (`--reembed` forces it). Audit, parity, recall and calibration only embed questions (under $0.01). The two eval suites call the chat model: about 24 + 32×3 generations with gpt-4o-mini.

## 4. Release evidence (local, 2026-10-01)

Reports live in `corpus/reports/`. The numbers come from the isolated local stack with real OpenAI calls. The model runs used fix round 6 (`86ef2f7`). Rounds 7–9 changed only scope routing and the lint: all 46 sources-suite cases route identically under all four, and the round-9 lint gives the same flags as round 6 on every cited sentence of the stored sources-suite answers (both checked offline; CNSC answers are not stored, so their note count was not re-measured). Chat model: gpt-4o-mini (prompt `2026-10-01.v2.6`).

| Check | Result | Caveat |
|---|---|---|
| Audit | 0 fails, 0 warns. 103 register entries = 103 DB rows. No chunks in IAEA/AERB/Fukushima or in any metadata-only/draft entry. All canonical and locator URLs allowlisted. | — |
| PDF pages | 108/108 sampled chunks found on their cited page range, using an independent pdf.js extraction. | The first run had 1 miss in 108. Two RG 8.10 chunks whose sentence crossed a page break were labelled with their first page only. Fixed in the chunker, re-published, re-checked. |
| Recall (production RPC) | 1.000 recall@8 and @20 on every scope. Per-call p95 ≤ 0.21 s, max 0.38 s. | **A regression guard, not an HNSW measurement.** `match_source_chunks` is exact by design (`enable_indexscan = off`), so 1.000 is expected; the check turns red if anyone re-enables the index. |
| Recall (forced HNSW) | `corpus/reports/hnsw-forced-recall.txt`: stored-chunk probes 0.995–1.000; "mixed" probes 0.955 overall, with **a 0/8 worst case inside NRC**. | This is why search is exact. Synthetic probes; the sample shifts when chunk ids change. Tune and re-probe before allowing the index (TODO). |
| Legacy path identity | Legacy retrieval matches `main` on all 32 battery questions (same top similarity, same 8 chunk ids in order) on every check this round, except one run where #24's top similarity moved 0.708 → 0.706 and two near-tied chunks swapped places. | That is OpenAI embedding nondeterminism, not code: the legacy path makes no side searches, and under the fan-out cap its expansion list is byte-identical to `main`. Only a query naming more than 6 documents is handled differently (capped). |
| Parity (CNSC, production path) | Unchanged documents: legacy 57/59 hit@8, v2 57/59, nothing lost, the OOS gate agrees on all 59. Refreshed documents: legacy 33/33, v2 29/33. | The 4 losses (s011/s029/s047/h006) cite REGDOC-2.5.2 (2014) sections that v2.1 renumbered, or a gold section now at rank 9 behind a new-edition preface. |
| Calibration | CNSC/ONR/EU: the legacy 0.40 gate answers every in-scope probe and refuses every off-topic one. NRC moved to 0.44 (one off-topic probe reached 0.401); the lowest in-scope NRC probe scored 0.681. | 8–14 in-scope and 12 off-topic author-written probes per collection. Small n. |
| Scope resolver | A table-driven test holds 145 routing examples raised over review rounds 2–9 (decline vs answer, Auto vs pinned, one vs four collections), plus ~25 earlier scope checks. Every routing and lint rule added in rounds 4–9 was mutation-tested: removing it fails at least one check. The rules were also diffed round over round on ~710 reviewer-written questions. | Heuristic, rule-based routing. Each adversarial round found new edge phrasings; the residuals are listed below. |
| Sources suite (46 cases) | **45/46**: tuned-on 24/24, regression 4/4, held-out 4/4, **blind 13/14** (written by a separate agent from the register only). | The one failure is blind `ho-cmp-reassessment-onr-eu` ("How do ONR and the EU Euratom nuclear safety directive each approach periodic reassessment…"): two regulators with no comparison word get the "pick one or ask me to compare" notice, as PLAN's "never mix regimes silently" rule says; the case expected a comparison (see PLAN → Needs human decision). Answer cases pass only with a resolved citation; malformed citations count as unresolved. Across the last three runs the compare dose case failed once, on a malformed `[[8 CFR 20.1201]]` citation (now rendered as unverified). |
| Wrong-authority review | Blind review (separate agent, chip labels + answers only) of the final 46 answers: **5 of 27 substantive answers flagged** — 2 A-type (guidance stated as a requirement where no binding duty exists), 3 B-type (the duty exists in a regulation, but only the guide is cited). 0 wrong-jurisdiction, 0 wrong numbers or unit verdicts. 4 of 5 carry the legal-force note; the unmitigated one reads a REGDOC "should" as "a binding obligation" while citing a REGDOC chunk that also contains "shall" text, which the lint cannot tell apart. | Reviewer saw chips, not snippet text. Earlier reviews of earlier code: 7 of 27, then 4 of 27 (gpt-4o-mini) vs 6 of 28 (gpt-4.1-mini) in the blind A/B. The review also noted one answer under-claiming (calling an RG 8.13 duty non-binding when 10 CFR 19.12 binds it), which no note addresses. |
| CNSC battery | **Legacy, 8 runs:** ship 16/17/18/17/16/17/16/17 of 20 (mean 16.8), hard 10/10/11/11/11/10/11/10 of 12 (mean 10.5). **v2 pinned to CNSC, 9 runs on round-4+ code:** ship 18/18/17/17/18/17/17/18/18 (mean 17.6), hard 10/10/10/10/10/9/10/9/10 (mean 9.9). Adversarial 2/3 on both paths, every run. The legal-force note fired on 4 of 288 v2 CNSC answers. | Neither path meets the ship bar: adversarial #19 fails on both (as does ship #11). v2's lower hard score is the two edition-drift cases below. |

Per-case differences (legacy over 8 runs → v2 over 9):
- **Better in v2:** #4 (1/8 → 9/9), #25 (0/8 → 9/9), #28 (6/8 → 9/9), #24 (7/8 → 9/9), #3 (5/8 → 7/9).
- **Worse in v2 — edition drift, verified in the DB:**
  - #21 (8/8 → 0/9): the case expects REGDOC-2.5.2 (2014) §7.3.4/§7.6.2. The current edition puts design extension conditions at §5.3.4/§6.6.12.
  - #26 (7/8 → 0/9): the expected phrases exist only in the 2018 *consultation draft* of REGDOC-2.1.1, which the legacy corpus serves as if it were current.
- **Slightly worse in v2, phrasing variance:** #22 (8/8 → 7/9), #2 (8/8 → 8/9), #8 (8/8 → 8/9). An earlier note here called #8 "a possible regression"; with more runs it passes 8 of 9 (REGDOC-2.10.1 is a refreshed edition, and the misses are the model phrasing "emergency response plan" differently).
- **Both fail every run:** #11 and #19.

**Wrong-authority mitigations, and what they did not fix.** Prompt rules alone (v2.3–v2.6) did not stop gpt-4o-mini writing "required"/"must" on guidance, or calling 50 mSv "higher" than 15 rem. A blind A/B with gpt-4.1-mini was no better (6 of 28 substantive answers flagged vs 4 of 27). What did move it:
- **Binding presence (NRC):** "compare dose limits" retrieved four RG 8.29 chunks and no 10 CFR 20.1201, and the model stated the ICRP five-year limit as the NRC's. The best binding chunk within 0.2 of the top match now takes a non-named slot; the answer cites 20.1201 with the right values.
- **Deterministic notes:** the legal-force note (lint over each answer's own citations; 6 of 46 sources answers, 4 of 288 CNSC answers) and the units note (comparison answers that mix rem and Sv and say higher/lower).
- **Residual:** the model still sometimes writes "must" while citing only the guide that restates a regulation (B-type: the duty exists, the citation is the guide). The note covers these; the sentence itself is not rewritten.

**Scope resolver residuals** (known after round 9; each is answered from the selected regulator with envelope cues rather than declined, unless noted):
- all-caps or oddly cased "US"/"UK" in a comparison;
- "How are SMRs licensed in Sweden?" / "Can I build an SMR in Sweden?" (no rules word governs the country);
- "Between Canada and the US, which regulator requires a PSA?" (the rules verb is too far from the pair);
- "Explain the IAEA emergency preparedness categories", "the IAEA INES level of Fukushima" (IAEA content framed like CNSC's own IAEA schemes);
- a comparison where only the Canadian side sits in a comparison slot ("Are US transport requirements stricter than Canada's?") is answered from CNSC alone on a CNSC-only deployment (with all four enabled it compares);
- a comparative outside the comparison list ("tougher in Canada than in the UK") gets the "pick one" notice when both are enabled, instead of a comparison;
- with all four enabled, "the difference between exporting to the US and importing into Canada" (two CNSC licences) compares CNSC with NRC;
- lint: "No licensee is obligated…" phrasing is flagged (a redundant note).

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
   - `bun run sources:recall --force` must PASS. This also times every production search call: search is exact by design, and the anon role's statement timeout is 3 s. It fails at 2.5 s. Locally (final code), the p95 is ≤ 0.21 s per scope and the max is 0.38 s.
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

`corpus/register.json` sets `recheck_cadence_days: 180`. `bun run sources:audit` warns on any entry whose rights review is older than that (`--strict` turns warnings into failures). The upstream revision check is `bun run sources:fetch --refresh`. It re-downloads every source and fails on any change against the pinned checksum. A drifted download is written next to the reviewed copy as `*.unverified` for the diff; the cached, reviewed copy is never overwritten by unverified bytes. CNSC pages are pinned by extracted text, so site rebuilds don't trigger false alarms. When the register drops an edition, `bun run sources:publish --prune` deletes it from the DB; a plain full publish lists such editions and fails. The source as-of date shows in the picker (per collection) and on every source card.
