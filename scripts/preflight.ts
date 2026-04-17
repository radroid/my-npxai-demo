#!/usr/bin/env bun
// Pre-deploy safety checks. Exits non-zero on any violation.
//
// 1. Secrets scan (Appendix B.5) — no real OpenAI / Supabase JWTs committed.
// 2. Service-role grep (Appendix B.5 + 2026-04-16 decision) — SUPABASE_SERVICE_ROLE_KEY
//    must not appear under app/, hooks/, components/.
// Run via `bun run preflight`.

import { spawnSync } from "node:child_process";

function run(
	label: string,
	cmd: string[],
	expectEmpty: boolean,
): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync(cmd[0]!, cmd.slice(1), {
		encoding: "utf8",
		shell: false,
	});
	const stdout = result.stdout?.trim() ?? "";
	const stderr = result.stderr?.trim() ?? "";
	const hit = stdout.length > 0;
	const ok = expectEmpty ? !hit : hit;
	const badge = ok ? "✅" : "❌";
	console.log(`${badge} ${label}`);
	if (!ok) {
		if (stdout) console.log(stdout);
		if (stderr) console.log(stderr);
	}
	return { ok, stdout, stderr };
}

const checks: Array<[string, string[], boolean]> = [
	[
		"Secret literals not committed to tracked files",
		[
			"git",
			"grep",
			"-InE",
			"sk-[A-Za-z0-9]{20,}|service_role|eyJ[A-Za-z0-9_-]{20,}\\.",
			"--",
			"app",
			"components",
			"hooks",
			"lib",
			"scripts",
			// Self-exclude: the regex pattern lives inside preflight.ts itself.
			":(exclude)scripts/preflight.ts",
		],
		true,
	],
	[
		"SUPABASE_SERVICE_ROLE_KEY not imported by runtime code (app/ hooks/ components/)",
		[
			"git",
			"grep",
			"-InE",
			"SUPABASE_SERVICE_ROLE_KEY",
			"--",
			"app",
			"components",
			"hooks",
		],
		true,
	],
];

let anyFailed = false;
for (const [label, cmd, expectEmpty] of checks) {
	const { ok } = run(label, cmd, expectEmpty);
	if (!ok) anyFailed = true;
}

if (anyFailed) {
	console.error("\npreflight: FAIL");
	process.exit(1);
}
console.log("\npreflight: PASS");
