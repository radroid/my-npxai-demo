// In-process evaluation of the v2 (multi-source) Knowledge Hub chat path.
//
//   bun --env-file=<local env> run scripts/sources/eval-v2.ts            # both suites
//   … --suite cnsc      # evals/knowledge-hub.jsonl, scope pinned to CNSC
//   … --suite sources   # evals/sources-v2.jsonl (routing, NRC/ONR/EU, compare, notices)
//   … --only v2-auto-eu-psr,12
//
//   … --corpus legacy   # same battery through the legacy path (baseline on
//                       # the SAME database, for the no-regression check)
//
// Runs the REAL chat handler (lib/knowledge-hub/query-handler.ts) through
// withGuard's test seam — guard, validation, jailbreak screen and corpus
// flag included — against the Supabase URL in the environment (refuses a
// non-local one). The eval bypass header skips rate limits; Redis is absent
// so the answer cache and spend counter fail open (every call is a MISS and
// a fresh model call). Writes corpus/reports/eval-<corpus>.json.
//
// Gate 5 checks per answered case: every [[S#]] resolves to a snippet the
// server handed out, at least one is cited, and every cited snippet belongs
// to the expected collection(s) — a wrong-jurisdiction citation fails.

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { type GuardedHandlerArgs, withGuard } from "../../lib/guard";
import { knowledgeHubQueryHandler } from "../../lib/knowledge-hub/query-handler";
import { isLowConfidenceText, isRefusalText } from "../../lib/prompts";
import { extractSnippetIds } from "../../lib/sources/citations";
import { isSourcesPayloadV2 } from "../../lib/sources/payload";
import { isLocalSupabaseUrl } from "../lib/embed";
import { type EvalCase, grade, loadCases, parseStream } from "../eval-kb";
import { REPO_ROOT, REPORTS_DIR } from "./register-io";

const CORPUS = process.argv.includes("--corpus")
	? process.argv[process.argv.indexOf("--corpus") + 1]
	: "v2";
process.env.KH_SOURCE_CORPUS = CORPUS === "legacy" ? "legacy" : "v2";
process.env.EVAL_BYPASS_KEY = crypto.randomUUID();
// No Redis locally: the cache and the spend counter fail open by design and
// log each miss with a stack. Keep the report readable.
const consoleError = console.error;
console.error = (...args: unknown[]) => {
	if (/redis|_cache_|accounting|UPSTASH/i.test(String(args[0]))) return;
	consoleError(...args);
};
process.env.KH_COLLECTIONS ??= "cnsc,nrc,onr,eu";

interface V2Case {
	id: string;
	category: string;
	query: string;
	scope?: unknown;
	expect: {
		kind: "single" | "compare" | "notice" | "oos" | "any";
		collections?: string[];
		notice_reason?: string;
		suggestions?: string[];
		cite_refs_any?: string[];
		cite_collections_all?: boolean;
		must_contain_any?: string[];
		must_not_contain?: string[];
		/**
		 * The right answer is a DECLINE by the model (on-topic but not in the
		 * corpus): refusal / low-confidence line, or an explicit "not
		 * covered" statement. Without this flag an answer case must cite.
		 */
		decline?: boolean;
		/** The answer must say a named document is not covered. */
		notes_absent?: boolean;
		/** Notice must link at least one of these reference documents. */
		references_any?: string[];
	};
	/** Added after the 2026-10-01 prompt fixes — never tuned against. */
	held_out?: boolean;
}

// "The indexed sources do not cover 10 CFR 73.54", "no snippet comes from…"
const NOT_COVERED_RE =
	/\b(?:not (?:covered|included|addressed|indexed|available|among)|(?:does|do|did) not (?:contain|cover|include|address|mention|provide)|doesn't (?:contain|cover|include|address)|don't (?:contain|cover|include|address)|no (?:snippets?|information|indexed)|outside the selected sources|isn't covered|aren't covered)\b/;

let handler: ((req: NextRequest) => Promise<Response>) | null = null;

async function run(
	query: string,
	scope: unknown,
	supabase: GuardedHandlerArgs["supabase"],
) {
	handler ??= withGuard(
		{ route: "knowledge-hub/query" },
		knowledgeHubQueryHandler,
		{
			createSupabase: async () => supabase,
		},
	);
	const started = Date.now();
	const req = new NextRequest("http://localhost/api/knowledge-hub/query", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-eval-bypass": process.env.EVAL_BYPASS_KEY as string,
			"x-forwarded-for": "127.0.0.1",
		},
		body: JSON.stringify({
			id: `eval-${crypto.randomUUID()}`,
			messages: [
				{
					id: crypto.randomUUID(),
					role: "user",
					parts: [{ type: "text", text: query }],
				},
			],
			// Regenerate: skip any answer cache, always a fresh model call.
			trigger: "regenerate-assistant-message",
			...(scope ? { scope } : {}),
		}),
	});
	const res = await handler(req);
	const body = await res.text();
	return {
		status: res.status,
		...parseStream(body),
		log: lastLog,
		ms: Date.now() - started,
	};
}

// withGuard emits one JSON request line per call; keep the last one so the
// report can show scope_key / per-collection similarity.
let lastLog: Record<string, unknown> = {};
const consoleLog = console.log;
console.log = (...args: unknown[]) => {
	const first = args[0];
	if (
		typeof first === "string" &&
		first.startsWith("{") &&
		first.includes('"route"')
	) {
		try {
			lastLog = JSON.parse(first);
			return;
		} catch {}
	}
	consoleLog(...args);
};

function norm(s: string): string {
	return s
		.toLowerCase()
		.replace(/\*\*|`/g, "")
		.replace(/[‘’]/g, "'");
}

function gradeV2(c: V2Case, r: Awaited<ReturnType<typeof run>>): string | null {
	if (r.status !== 200) return `http_${r.status}`;
	const e = c.expect;
	const payload = isSourcesPayloadV2(r.sources) ? r.sources : null;
	const kind = r.notice
		? "notice"
		: payload
			? payload.scope.kind
			: isRefusalText(r.text)
				? "oos"
				: "unknown";
	// A decline case may also be declined by the refusal gate itself.
	if (e.decline && kind === "oos") return null;
	if (e.kind !== "any" && kind !== e.kind) return `kind:${kind}≠${e.kind}`;
	if (
		e.notice_reason &&
		(r.notice as { reason?: string } | null)?.reason !== e.notice_reason
	) {
		return `notice_reason:${(r.notice as { reason?: string } | null)?.reason}≠${e.notice_reason}`;
	}
	if (e.suggestions) {
		const got = (
			(r.notice as { suggestions?: Array<{ id: string }> })?.suggestions ?? []
		).map((s) => s.id);
		if (!e.suggestions.every((s) => got.includes(s)))
			return `suggestions:${got.join(",")}`;
	}
	if (e.references_any) {
		const got = (
			(r.notice as { references?: Array<{ label: string }> })?.references ?? []
		).map((x) => x.label);
		if (!e.references_any.some((ref) => got.includes(ref)))
			return `references:${got.join(",") || "none"}`;
	}
	const text = norm(r.text);
	for (const banned of e.must_not_contain ?? []) {
		if (text.includes(banned.toLowerCase())) return `forbidden:${banned}`;
	}
	if (!payload) return null;
	if (e.collections) {
		const got = [...payload.scope.collections].sort().join(",");
		if (got !== [...e.collections].sort().join(","))
			return `collections:${got}`;
	}
	const ids = extractSnippetIds(r.text);
	const cited = ids.map((id) => payload.sources.find((s) => s.sid === id));
	if (cited.some((s) => !s))
		return `unresolved:${ids.filter((_, i) => !cited[i]).join(",")}`;
	const declined =
		isRefusalText(r.text) ||
		isLowConfidenceText(r.text) ||
		NOT_COVERED_RE.test(text);
	if (e.decline) {
		// The model must not present uncovered material as answered: a decline,
		// and nothing attributed to a document outside the envelope (checked
		// by the unresolved-id test above).
		if (!declined) return "answered_uncovered_question";
	} else if (e.kind === "single" || e.kind === "compare") {
		// An answer case passes only on a cited answer — a refusal or a
		// "not covered" line with no citation is a failure, not a pass.
		if (ids.length === 0)
			return isLowConfidenceText(r.text) || isRefusalText(r.text)
				? "declined_answerable"
				: "no_citations";
	}
	if (e.notes_absent && !NOT_COVERED_RE.test(text))
		return "absent_doc_not_flagged";
	const allowed = new Set(payload.scope.collections);
	const wrong = cited.filter((s) => s && !allowed.has(s.collection));
	if (wrong.length > 0)
		return `wrong_collection:${wrong.map((s) => s?.ref).join(",")}`;
	if (e.cite_collections_all) {
		const citedCols = new Set(cited.map((s) => s?.collection));
		const missing = payload.scope.collections.filter(
			(col) => !citedCols.has(col),
		);
		if (missing.length > 0) return `compare_side_uncited:${missing.join(",")}`;
	}
	if (e.cite_refs_any) {
		const hit = cited.some((s) =>
			e.cite_refs_any?.some((ref) => s?.ref.startsWith(ref)),
		);
		if (!hit)
			return `missing_cite:${e.cite_refs_any.join("|")} (cited ${[...new Set(cited.map((s) => s?.chip))].join("; ")})`;
	}
	if (
		e.must_contain_any &&
		!e.must_contain_any.some((p) => text.includes(p.toLowerCase()))
	) {
		return `missing_any:${e.must_contain_any.join("|")}`;
	}
	return null;
}

async function main() {
	const argv = process.argv.slice(2);
	const suiteIdx = argv.indexOf("--suite");
	const suite = suiteIdx >= 0 ? argv[suiteIdx + 1] : "all";
	const onlyIdx = argv.indexOf("--only");
	const only =
		onlyIdx >= 0 ? new Set((argv[onlyIdx + 1] ?? "").split(",")) : null;
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
	const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
	if (!isLocalSupabaseUrl(url) && !argv.includes("--force")) {
		console.error(`Refusing: ${url} is not a local Supabase URL.`);
		process.exit(1);
	}
	// The anon key, exactly like the route: reads go through the SECURITY
	// DEFINER RPC only.
	const supabase = createClient(url, anon, {
		auth: { persistSession: false },
	}) as unknown as GuardedHandlerArgs["supabase"];
	const report: Record<string, unknown> = {
		ran_at: new Date().toISOString(),
		collections: process.env.KH_COLLECTIONS,
	};

	const repeatIdx = argv.indexOf("--repeat");
	const repeat =
		repeatIdx >= 0 ? Math.max(1, Number(argv[repeatIdx + 1]) || 1) : 1;

	if (suite === "all" || suite === "cnsc") {
		const cases = loadCases().filter((c) => !only || only.has(String(c.id)));
		// v2 pins the battery to CNSC (gate 5); the legacy path has no scope.
		const scope =
			CORPUS === "v2" ? { mode: "pinned", collection: "cnsc" } : undefined;
		const passCounts = new Map<number, number>();
		const runs: unknown[] = [];
		for (let pass = 1; pass <= repeat; pass++) {
			const rows: Array<{
				id: number;
				suite?: string;
				category: string;
				pass: boolean;
				reason: string;
			}> = [];
			console.log(
				`\n== CNSC battery — ${CORPUS}${scope ? ", pinned to CNSC" : ""} — run ${pass}/${repeat} (${cases.length} cases)`,
			);
			for (const c of cases as EvalCase[]) {
				const r = await run(c.question, scope, supabase);
				const v = grade(c, r.status, r.text, r.sources);
				rows.push({
					id: c.id,
					suite: c.suite,
					category: c.category,
					pass: v.pass,
					reason: v.reason,
				});
				console.log(
					`${v.pass ? "✅" : "❌"} ${String(c.id).padStart(2)} [${c.category}] ${c.question.slice(0, 70)}${v.pass ? "" : `  — ${v.reason}`}`,
				);
			}
			const ship = rows.filter((r) => r.suite !== "hard");
			const hard = rows.filter((r) => r.suite === "hard");
			const adv = ship.filter((r) => r.category === "adversarial");
			const summary = {
				ship: `${ship.filter((r) => r.pass).length}/${ship.length}`,
				hard: `${hard.filter((r) => r.pass).length}/${hard.length}`,
				adversarial: `${adv.filter((r) => r.pass).length}/${adv.length}`,
			};
			console.log(
				`ship ${summary.ship} · hard ${summary.hard} · adversarial ${summary.adversarial}`,
			);
			for (const r of rows) {
				passCounts.set(r.id, (passCounts.get(r.id) ?? 0) + (r.pass ? 1 : 0));
			}
			runs.push({ summary, rows });
		}
		report.cnsc = {
			corpus: CORPUS,
			repeat,
			runs,
			pass_rate_by_case: Object.fromEntries(
				[...passCounts].map(([id, n]) => [id, `${n}/${repeat}`]),
			),
		};
	}

	if ((suite === "all" || suite === "sources") && CORPUS === "v2") {
		const cases = readFileSync(
			join(REPO_ROOT, "evals", "sources-v2.jsonl"),
			"utf8",
		)
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l) as V2Case)
			.filter((c) => !only || only.has(c.id));
		console.log(
			`\n== Source routing / multi-source battery (${cases.length} cases)`,
		);
		const rows: Array<Record<string, unknown>> = [];
		for (const c of cases) {
			const r = await run(c.query, c.scope, supabase);
			const fail = gradeV2(c, r);
			const payload = isSourcesPayloadV2(r.sources) ? r.sources : null;
			rows.push({
				id: c.id,
				category: c.category,
				pass: fail === null,
				reason: fail ?? "ok",
				held_out: c.held_out === true,
				scope_key: r.log.scope_key,
				cited: [
					...new Set(
						extractSnippetIds(r.text).map(
							(id) => payload?.sources.find((s) => s.sid === id)?.chip,
						),
					),
				],
				per_collection: r.log.retrieval_per_collection,
				ms: r.ms,
				// Kept for the wrong-authority / wrong-jurisdiction review.
				answer: r.text,
			});
			console.log(
				`${fail === null ? "✅" : "❌"} ${c.id.padEnd(30)} ${String(r.log.scope_key ?? "").padEnd(24)}${fail ? `  — ${fail}` : ""}`,
			);
			if (fail && argv.includes("--debug"))
				console.log(`   ${r.text.slice(0, 600).replace(/\n/g, "\n   ")}`);
		}
		const passed = rows.filter((r) => r.pass).length;
		const held = rows.filter((r) => r.held_out);
		const heldPassed = held.filter((r) => r.pass).length;
		const tuned = rows.length - held.length;
		console.log(
			`sources: ${passed}/${rows.length}  (tuned-on ${passed - heldPassed}/${tuned} · held-out ${heldPassed}/${held.length})`,
		);
		report.sources = {
			summary: `${passed}/${rows.length}`,
			tuned_on: `${passed - heldPassed}/${tuned}`,
			held_out: `${heldPassed}/${held.length}`,
			rows,
		};
	}

	const name = `eval-${CORPUS}${suite === "all" ? "" : `-${suite}`}.json`;
	await writeFile(
		join(REPORTS_DIR, name),
		`${JSON.stringify(report, null, "\t")}\n`,
	);
	console.log(`\nreport → corpus/reports/${name}`);
}

await main();
