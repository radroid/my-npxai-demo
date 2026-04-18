#!/usr/bin/env bun
// Knowledge Hub eval runner (Appendix E.4).
//
// Runs evals/knowledge-hub.jsonl against a local or deployed endpoint,
// grades per the E.4 order (status → behavior → citations → sections →
// keywords → group hits → deny list → latency). Exits non-zero on the
// Phase-3 ship bar miss (≥17/20 AND all 3 adversarial pass).
//
// Usage:
//   bun run eval:kb                    # localhost:3001 (or $EVAL_BASE_URL)
//   EVAL_BASE_URL=https://npx.curlycloud.dev bun run eval:kb
//   bun run eval:kb --suite hard       # hard corpus-stress battery only
//   bun run eval:kb --suite all        # ship + hard suites together
//   bun run eval:kb --only 17,18,19    # run a subset
//   bun run eval:kb --debug            # print raw response text on failures

import fs from "node:fs";
import path from "node:path";
import {
	KNOWLEDGE_HUB_LOW_CONFIDENCE,
	KNOWLEDGE_HUB_OUT_OF_SCOPE,
} from "../lib/prompts";

interface EvalCase {
	id: number;
	suite?: "ship" | "hard";
	category: string;
	question: string;
	expected_behavior: "answer" | "fallback" | "out_of_scope" | "refuse";
	must_cite: string[];
	must_cite_section: string[];
	must_contain_any: string[];
	must_contain_all_from_group: string[][];
	min_group_hits: number[];
	must_not_contain: string[];
}

interface CheckResult {
	pass: boolean;
	reason?: string;
}

interface EvalResult {
	id: number;
	category: string;
	pass: boolean;
	reason: string;
	latencyMs: number;
	outputLen: number;
}

// Default to 3001 — this repo's `next dev` binds there because another
// local project holds 3000. Override with EVAL_BASE_URL when needed
// (e.g. `EVAL_BASE_URL=https://npx.curlycloud.dev bun run eval:kb`).
const BASE_URL = process.env.EVAL_BASE_URL ?? "http://localhost:3001";
const ENDPOINT = `${BASE_URL}/api/knowledge-hub/query`;
const LATENCY_SOFT_CAP_MS = 10_000;
const SHIP_PASS_THRESHOLD = 17;

// Section labels in the CNSC corpus are not always numeric — appendix /
// glossary sections use letters (REGDOC-3.6 §A, REGDOC-2.4.1 §Appendix C,
// §B.2) and statutory sections use parenthetical sub-letters (NSCA §26(a),
// §48(1)(b)). The § glyph is occasionally dropped by the model. Allow all
// of these so extracted citations reflect what the LLM actually wrote.
const CITATION_RE =
	/\[(?:REGDOC-\d+(?:\.\d+){1,3}|NSCA)(?:\s+§?[A-Za-z0-9.()]+(?:\s[A-Za-z0-9.()]+)?)?\]/g;
const SECTION_RE = /§([A-Za-z0-9.()]+(?:\s[A-Za-z0-9.()]+)?)/;

function parseOnly(argv: string[]): Set<number> | null {
	const idx = argv.indexOf("--only");
	if (idx === -1) return null;
	const list = argv[idx + 1];
	if (!list) return null;
	return new Set(
		list
			.split(",")
			.map((s) => Number(s.trim()))
			.filter((n) => Number.isInteger(n)),
	);
}

function parseSuite(argv: string[]): "ship" | "hard" | "all" {
	const idx = argv.indexOf("--suite");
	if (idx === -1) return "ship";
	const value = argv[idx + 1]?.trim().toLowerCase();
	if (value === "hard" || value === "all" || value === "ship") return value;
	return "ship";
}

function loadCases(): EvalCase[] {
	const filePath = path.resolve(process.cwd(), "evals/knowledge-hub.jsonl");
	const raw = fs.readFileSync(filePath, "utf8");
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line, idx) => {
			try {
				const parsed = JSON.parse(line) as EvalCase;
				return {
					...parsed,
					suite: parsed.suite === "hard" ? "hard" : "ship",
				};
			} catch (err) {
				throw new Error(
					`Bad JSONL at line ${idx + 1}: ${(err as Error).message}`,
				);
			}
		});
}

function buildBody(question: string): Record<string, unknown> {
	return {
		id: `eval-${crypto.randomUUID()}`,
		messages: [
			{
				id: crypto.randomUUID(),
				role: "user",
				parts: [{ type: "text", text: question }],
			},
		],
		trigger: "submit-message",
	};
}

async function callEndpoint(question: string): Promise<{
	status: number;
	body: string;
	latencyMs: number;
}> {
	const start = Date.now();
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	const bypassKey = process.env.EVAL_BYPASS_KEY;
	if (bypassKey) headers["x-eval-bypass"] = bypassKey;
	const res = await fetch(ENDPOINT, {
		method: "POST",
		headers,
		body: JSON.stringify(buildBody(question)),
	});
	const body = await res.text();
	return { status: res.status, body, latencyMs: Date.now() - start };
}

// Parse the AI SDK v6 UIMessage stream response (SSE: "data: {...}" lines)
// and reconstruct the accumulated assistant text.
function parseStreamedText(raw: string): string {
	const lines = raw.split("\n");
	let accumulated = "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			const obj = JSON.parse(payload);
			if (obj?.type === "text-delta" && typeof obj.delta === "string") {
				accumulated += obj.delta;
			}
		} catch {
			// Non-JSON data frames (start/end markers) — ignore
		}
	}
	return accumulated;
}

function extractCitations(
	text: string,
): Array<{ regdoc: string; section: string | null }> {
	const out: Array<{ regdoc: string; section: string | null }> = [];
	for (const match of text.matchAll(CITATION_RE)) {
		const full = match[0];
		const regdocMatch = full.match(/REGDOC-\d+(?:\.\d+){1,3}|NSCA/);
		if (!regdocMatch) continue;
		const regdoc = regdocMatch[0];
		const secMatch = full.match(SECTION_RE);
		out.push({ regdoc, section: secMatch ? secMatch[1] : null });
	}
	return out;
}

function sectionMatchesPrefix(cited: string, prefix: string): boolean {
	if (cited === prefix) return true;
	// Accept numeric sub-sections ("3.2" ⊃ "3.2.1") and parenthetical
	// sub-clauses used in statutory citations ("26" ⊃ "26(a)", "48(1)(b)").
	return cited.startsWith(`${prefix}.`) || cited.startsWith(`${prefix}(`);
}

function checkBehavior(
	expected: EvalCase["expected_behavior"],
	text: string,
): CheckResult {
	const lower = text.toLowerCase();
	const hasLowConf = text.includes(KNOWLEDGE_HUB_LOW_CONFIDENCE);
	const hasOOS = text.includes(KNOWLEDGE_HUB_OUT_OF_SCOPE);
	switch (expected) {
		case "answer":
			// Pass if the response isn't purely the canonical fallback text.
			if (text.trim().length === 0) {
				return { pass: false, reason: "empty_response" };
			}
			if ((hasLowConf || hasOOS) && text.trim().length < 200) {
				return {
					pass: false,
					reason: "unexpected_fallback_on_answer_question",
				};
			}
			return { pass: true };
		case "fallback":
			if (hasLowConf || hasOOS) return { pass: true };
			// Also accept a response that's clearly refusing to answer
			if (
				lower.includes("don't have enough") ||
				lower.includes("do not have enough") ||
				lower.includes("not covered") ||
				lower.includes("outside") ||
				lower.includes("cannot find")
			) {
				return { pass: true };
			}
			return { pass: false, reason: "no_fallback_text" };
		case "out_of_scope":
			if (hasOOS) return { pass: true };
			if (
				lower.includes("outside") &&
				(lower.includes("scope") ||
					lower.includes("corpus") ||
					lower.includes("cnsc"))
			) {
				return { pass: true };
			}
			return { pass: false, reason: "no_out_of_scope_response" };
		case "refuse":
			// For refusal Qs, the behavior gate is "doesn't leak system prompt";
			// the must_not_contain list does the actual leak detection.
			return { pass: true };
	}
}

function checkCitations(
	required: string[],
	citations: Array<{ regdoc: string; section: string | null }>,
): CheckResult {
	for (const needed of required) {
		const neededLower = needed.toLowerCase();
		const hit = citations.some((c) =>
			c.regdoc.toLowerCase().startsWith(neededLower),
		);
		if (!hit) return { pass: false, reason: `missing_cite:${needed}` };
	}
	return { pass: true };
}

function checkCiteSections(
	prefixes: string[],
	citations: Array<{ regdoc: string; section: string | null }>,
): CheckResult {
	if (prefixes.length === 0) return { pass: true };
	for (const cited of citations) {
		if (!cited.section) continue;
		for (const prefix of prefixes) {
			if (sectionMatchesPrefix(cited.section, prefix)) return { pass: true };
		}
	}
	return { pass: false, reason: `no_cite_section_match:${prefixes.join("|")}` };
}

// Strip markdown formatting that the LLM adds for presentation (bold,
// italics, inline code) but which splits content phrases mid-word — e.g.
// `**Possess, transfer...** a nuclear substance` hides the substring
// `transfer... a nuclear substance` from a naive grader. Also collapses
// non-breaking spaces + curly apostrophes to ASCII equivalents.
function normalizeForMatching(raw: string): string {
	return raw
		.replace(/\*\*|__|`/g, "") // bold / underline bold / inline code markers
		.replace(/(?<=\w)\*(?=\w)/g, "") // leftover single-asterisk italics inside words
		.replace(/[\u00A0\u2007\u202F]/g, " ") // non-breaking whitespace variants
		.replace(/[\u2018\u2019]/g, "'") // curly single quotes
		.replace(/[\u201C\u201D]/g, '"') // curly double quotes
		.toLowerCase();
}

function checkContainAny(phrases: string[], text: string): CheckResult {
	if (phrases.length === 0) return { pass: true };
	const norm = normalizeForMatching(text);
	const hit = phrases.some((p) => norm.includes(p.toLowerCase()));
	if (!hit) return { pass: false, reason: `missing_any:${phrases.join("|")}` };
	return { pass: true };
}

function checkGroupHits(
	groups: string[][],
	thresholds: number[],
	text: string,
): CheckResult {
	if (groups.length === 0) return { pass: true };
	const norm = normalizeForMatching(text);
	for (let i = 0; i < groups.length; i++) {
		const group = groups[i];
		const threshold = thresholds[i] ?? 1;
		const hits = group.filter((g) => norm.includes(g.toLowerCase())).length;
		if (hits < threshold) {
			return {
				pass: false,
				reason: `group${i + 1}_hits_${hits}_of_${threshold}:[${group.join("|")}]`,
			};
		}
	}
	return { pass: true };
}

function checkDeny(phrases: string[], text: string): CheckResult {
	if (phrases.length === 0) return { pass: true };
	const norm = normalizeForMatching(text);
	for (const banned of phrases) {
		if (norm.includes(banned.toLowerCase())) {
			return { pass: false, reason: `forbidden:${banned}` };
		}
	}
	return { pass: true };
}

function grade(
	c: EvalCase,
	status: number,
	text: string,
): { pass: boolean; reason: string } {
	if (status < 200 || status >= 300) {
		return { pass: false, reason: `http_${status}` };
	}
	const citations = extractCitations(text);

	const checks: Array<[string, () => CheckResult]> = [
		["behavior", () => checkBehavior(c.expected_behavior, text)],
		["cite", () => checkCitations(c.must_cite, citations)],
		["cite_section", () => checkCiteSections(c.must_cite_section, citations)],
		["contain_any", () => checkContainAny(c.must_contain_any, text)],
		[
			"group_hits",
			() =>
				checkGroupHits(c.must_contain_all_from_group, c.min_group_hits, text),
		],
		["deny", () => checkDeny(c.must_not_contain, text)],
	];

	for (const [name, fn] of checks) {
		const r = fn();
		if (!r.pass)
			return { pass: false, reason: `${name}:${r.reason ?? "fail"}` };
	}
	return { pass: true, reason: "ok" };
}

function printRow(r: EvalResult, question: string): void {
	const mark = r.pass ? "✅" : "❌";
	const latFlag = r.latencyMs > LATENCY_SOFT_CAP_MS ? " ⏱" : "";
	const qPreview =
		question.length > 64 ? `${question.slice(0, 61)}…` : question;
	const reason = r.pass ? "" : `  — ${r.reason}`;
	console.log(
		`${mark}  #${String(r.id).padStart(2, "0")} [${r.category.padEnd(12)}] ${(r.latencyMs / 1000).toFixed(1)}s${latFlag}  ${qPreview}${reason}`,
	);
}

function printDebug(id: number, text: string): void {
	console.log(`\n  ---- #${id} response (${text.length} chars) ----`);
	console.log(
		text
			.split("\n")
			.map((line) => `    ${line}`)
			.join("\n"),
	);
	console.log("  --------------------\n");
}

async function main(): Promise<void> {
	const only = parseOnly(process.argv);
	const suite = parseSuite(process.argv);
	const cases = loadCases().filter((c) => {
		if (suite !== "all" && c.suite !== suite) return false;
		return !only || only.has(c.id);
	});

	console.log(`\nEndpoint: ${ENDPOINT}`);
	console.log(`Suite:    ${suite}`);
	console.log(`Cases:    ${cases.length}${only ? " (filtered)" : ""}\n`);

	const results: EvalResult[] = [];
	const caseById = new Map(cases.map((c) => [c.id, c]));
	for (const c of cases) {
		try {
			const { status, body, latencyMs } = await callEndpoint(c.question);
			const text = parseStreamedText(body);
			const verdict = grade(c, status, text);
			const r: EvalResult = {
				id: c.id,
				category: c.category,
				pass: verdict.pass,
				reason: verdict.reason,
				latencyMs,
				outputLen: text.length,
			};
			results.push(r);
			printRow(r, c.question);
			if (!r.pass && process.argv.includes("--debug")) printDebug(c.id, text);
		} catch (err) {
			const r: EvalResult = {
				id: c.id,
				category: c.category,
				pass: false,
				reason: `exception:${(err as Error).message}`,
				latencyMs: 0,
				outputLen: 0,
			};
			results.push(r);
			printRow(r, c.question);
		}
	}

	const passed = results.filter((r) => r.pass).length;
	const total = results.length;
	const shipResults = results.filter(
		(r) => caseById.get(r.id)?.suite === "ship",
	);
	const hardResults = results.filter(
		(r) => caseById.get(r.id)?.suite === "hard",
	);
	const shipPassed = shipResults.filter((r) => r.pass).length;
	const shipAdversarial = shipResults.filter(
		(r) => r.category === "adversarial",
	);
	const shipAdversarialPass =
		shipAdversarial.length > 0 && shipAdversarial.every((r) => r.pass);
	const shipBarPass =
		shipPassed >= SHIP_PASS_THRESHOLD && shipAdversarialPass;
	const hardPassed = hardResults.filter((r) => r.pass).length;
	const hardBarPass = hardResults.length === 0 || hardPassed === hardResults.length;

	console.log(`\n───────────────────────────────────────────`);
	if (total > 0) {
		console.log(
			`Passed:       ${passed}/${total}  (${Math.round((passed / total) * 100)}%)`,
		);
	} else {
		console.log("Passed:       0/0");
	}
	if (suite === "ship") {
		console.log(
			`Adversarial:  ${shipAdversarial.filter((r) => r.pass).length}/${shipAdversarial.length}${shipAdversarialPass ? " ✅" : " ❌ blocker"}`,
		);
		console.log(`MVP bar:      ≥14/20  ${passed >= 14 ? "✅" : "❌"}`);
		console.log(
			`Ship bar:     ≥17/20 + all adversarial  ${shipBarPass ? "✅" : "❌"}`,
		);
	} else if (suite === "hard") {
		console.log(`Hard bar:     all ${total} must pass  ${hardBarPass ? "✅" : "❌"}`);
	} else {
		console.log(
			`Ship suite:   ${shipPassed}/${shipResults.length}  ${
				shipBarPass ? "✅ ship bar" : "❌ ship bar"
			}`,
		);
		console.log(
			`Hard suite:   ${hardPassed}/${hardResults.length}  ${
				hardBarPass ? "✅ hard bar" : "❌ hard bar"
			}`,
		);
		console.log(
			`Ship bar:     ≥17/20 + all adversarial  ${shipBarPass ? "✅" : "❌"}`,
		);
		console.log(
			`Hard bar:     all hard cases must pass  ${hardBarPass ? "✅" : "❌"}`,
		);
	}
	console.log(`───────────────────────────────────────────\n`);

	if (only) {
		console.log("(--only subset mode: exit code not gated on ship bar.)");
		return;
	}

	if (suite === "ship" && !shipBarPass) {
		process.exit(1);
	}
	if (suite === "hard" && !hardBarPass) {
		process.exit(1);
	}
	if (suite === "all" && !(shipBarPass && hardBarPass)) {
		process.exit(1);
	}
}

await main();
