#!/usr/bin/env bun
// Knowledge Hub eval runner (Appendix E.4).
//
// Runs evals/knowledge-hub.jsonl against a local or deployed endpoint,
// grades per the E.4 order (status → behavior → citations → sections →
// keywords → group hits → deny list → latency). Exits non-zero on the
// Phase-3 ship bar miss (≥17/20 AND all 3 adversarial pass).
//
// Usage:
//   bun run eval:kb                    # localhost:3000 (or $EVAL_BASE_URL)
//   EVAL_BASE_URL=https://npx.curlycloud.dev bun run eval:kb
//   bun run eval:kb --only 17,18,19    # run a subset

import fs from "node:fs";
import path from "node:path";
import {
	KNOWLEDGE_HUB_LOW_CONFIDENCE,
	KNOWLEDGE_HUB_OUT_OF_SCOPE,
} from "../lib/prompts";

interface EvalCase {
	id: number;
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

const BASE_URL = process.env.EVAL_BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE_URL}/api/knowledge-hub/query`;
const LATENCY_SOFT_CAP_MS = 10_000;

const CITATION_RE = /\[REGDOC-\d+(?:\.\d+){1,3}(?:\s+§[\d.]+)?\]/g;
const SECTION_RE = /§([\d.]+)/;

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

function loadCases(): EvalCase[] {
	const filePath = path.resolve(process.cwd(), "evals/knowledge-hub.jsonl");
	const raw = fs.readFileSync(filePath, "utf8");
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line, idx) => {
			try {
				return JSON.parse(line) as EvalCase;
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
		const regdocMatch = full.match(/REGDOC-\d+(?:\.\d+){1,3}/);
		if (!regdocMatch) continue;
		const regdoc = regdocMatch[0];
		const secMatch = full.match(SECTION_RE);
		out.push({ regdoc, section: secMatch ? secMatch[1] : null });
	}
	return out;
}

function sectionMatchesPrefix(cited: string, prefix: string): boolean {
	if (cited === prefix) return true;
	return cited.startsWith(`${prefix}.`);
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

function checkContainAny(phrases: string[], text: string): CheckResult {
	if (phrases.length === 0) return { pass: true };
	const lower = text.toLowerCase();
	const hit = phrases.some((p) => lower.includes(p.toLowerCase()));
	if (!hit) return { pass: false, reason: `missing_any:${phrases.join("|")}` };
	return { pass: true };
}

function checkGroupHits(
	groups: string[][],
	thresholds: number[],
	text: string,
): CheckResult {
	if (groups.length === 0) return { pass: true };
	const lower = text.toLowerCase();
	for (let i = 0; i < groups.length; i++) {
		const group = groups[i];
		const threshold = thresholds[i] ?? 1;
		const hits = group.filter((g) => lower.includes(g.toLowerCase())).length;
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
	const lower = text.toLowerCase();
	for (const banned of phrases) {
		if (lower.includes(banned.toLowerCase())) {
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
	const cases = loadCases().filter((c) => !only || only.has(c.id));

	console.log(`\nEndpoint: ${ENDPOINT}`);
	console.log(`Cases:    ${cases.length}${only ? " (filtered)" : ""}\n`);

	const results: EvalResult[] = [];
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
	const adversarial = results.filter((r) => r.category === "adversarial");
	const adversarialPass = adversarial.every((r) => r.pass);

	console.log(`\n───────────────────────────────────────────`);
	console.log(
		`Passed:       ${passed}/${total}  (${Math.round((passed / total) * 100)}%)`,
	);
	console.log(
		`Adversarial:  ${adversarial.filter((r) => r.pass).length}/${adversarial.length}${adversarialPass ? " ✅" : " ❌ blocker"}`,
	);
	console.log(`MVP bar:      ≥14/20  ${passed >= 14 ? "✅" : "❌"}`);
	console.log(
		`Ship bar:     ≥17/20 + all adversarial  ${
			passed >= 17 && adversarialPass ? "✅" : "❌"
		}`,
	);
	console.log(`───────────────────────────────────────────\n`);

	if (only) {
		console.log("(--only subset mode: exit code not gated on ship bar.)");
		return;
	}

	if (!(passed >= 17 && adversarialPass)) {
		process.exit(1);
	}
}

await main();
