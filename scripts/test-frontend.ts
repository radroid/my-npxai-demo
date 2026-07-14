#!/usr/bin/env bun
// Frontend static/source-level harness (item-1 slice 1.2, PR #7 fix round 1
// — reviewer-authored test, ISSUE 4). Sibling to scripts/test-artifact.ts,
// same check()/failures convention.
//
// Pure/offline by design: no network, no dev server, no OpenAI, no new
// test-framework dependency. This repo has no DOM renderer installed (no
// jsdom / @testing-library) so assertions below are static/source-level
// where a real render would otherwise be required — acceptable per the
// fix-round dispatch, which explicitly permits this over adding a
// dependency.
//
// Covers:
//   (a) the artifact iframe's sandbox attribute is EXACTLY the two
//       allow-* tokens I1.1 requires, and never allow-scripts /
//       allow-same-origin, anywhere in ArtifactWorkbench.tsx's CODE
//       (comments stripped first — the security-invariant comment above the
//       iframe legitimately names both forbidden tokens).
//   (b) no dangerouslySetInnerHTML sink in the CODE of any file under
//       components/knowledge-hub/ (comments stripped first — the same file's
//       header comment legitimately mentions the API by name).
//   (c) thread.tsx's composerHeader is additive-only: destructured with no
//       default value, rendered as a bare {composerHeader} expression with
//       no wrapping element — so undefined renders nothing extra.
//   (d) the ISSUE-1 regression: the extracted pure mode-reconciliation
//       predicate (lib/knowledge-hub-mode.ts), plus a source-level check
//       that KnowledgeHubShell.tsx actually gates setMode("chat") on it
//       (mutation-tested: an unconditional setMode("chat") would fail the
//       gating check even though the predicate itself still passes).
//
// Usage:  bun run test:frontend
// Exit code 0 on pass, 1 on any failure.

import { readdirSync, readFileSync } from "node:fs";
import { shouldSnapToChatOnThreadChange } from "../lib/knowledge-hub-mode";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
	if (!cond) {
		failures++;
		console.log(`FAIL: ${name}`, extra ?? "");
	} else {
		console.log(`ok:   ${name}`);
	}
}

function readSrc(relPath: string): string {
	return readFileSync(new URL(relPath, import.meta.url), "utf8");
}

// Strips block (/* */) and line (//) comments. Naive but safe for the exact
// files scanned below: none contain a literal "//" inside a string/URL
// (verified: `grep "://" components/knowledge-hub/*.tsx` is empty), so this
// can't mistake string content for a comment start.
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// =============================================================================
// (a) Artifact iframe sandbox — I1.1 load-bearing
// =============================================================================

const workbenchSrc = readSrc(
	"../components/knowledge-hub/ArtifactWorkbench.tsx",
);
// Comments stripped first — the file's own header + inline security-invariant
// comments legitimately quote the contract string and name the forbidden
// tokens, which would otherwise double-count as a second sandbox= match.
const workbenchCode = stripComments(workbenchSrc);
const sandboxMatches = [...workbenchCode.matchAll(/sandbox="([^"]*)"/g)];
check(
	"exactly one sandbox= attribute in ArtifactWorkbench.tsx's code",
	sandboxMatches.length === 1,
	sandboxMatches.map((m) => m[0]),
);
check(
	"sandbox value is exactly the I1.1 contract string",
	sandboxMatches[0]?.[1] === "allow-popups allow-popups-to-escape-sandbox",
	sandboxMatches[0]?.[1],
);
check(
	"ArtifactWorkbench.tsx code (comments stripped) never contains allow-scripts",
	!workbenchCode.includes("allow-scripts"),
);
check(
	"ArtifactWorkbench.tsx code (comments stripped) never contains allow-same-origin",
	!workbenchCode.includes("allow-same-origin"),
);

// =============================================================================
// (b) No dangerouslySetInnerHTML sink anywhere under components/knowledge-hub/
// =============================================================================

const KH_DIR = new URL("../components/knowledge-hub/", import.meta.url);
const khFiles = readdirSync(KH_DIR).filter((f) => /\.tsx?$/.test(f));
check(
	"components/knowledge-hub/ directory scan found files",
	khFiles.length > 0,
	khFiles,
);
for (const file of khFiles) {
	const code = stripComments(readFileSync(new URL(file, KH_DIR), "utf8"));
	check(
		`no dangerouslySetInnerHTML in code: ${file}`,
		!code.includes("dangerouslySetInnerHTML"),
	);
}

// =============================================================================
// (c) thread.tsx composerHeader additive-prop contract
// =============================================================================

const threadSrc = readSrc("../components/assistant-ui/thread.tsx");
const threadSig = threadSrc.match(
	/export const Thread: FC<\{ composerHeader\?: ReactNode \}> = \(\{([^)]*)\}\) => \(/,
);
check(
	"Thread's composerHeader prop type is optional ReactNode",
	threadSig !== null,
);
check(
	"composerHeader destructured with NO default value",
	threadSig !== null && !/=/.test(threadSig[1]),
	threadSig?.[1],
);
const footerBody = threadSrc.match(
	/<ThreadScrollToBottom \/>([\s\S]*?)<Composer \/>/,
);
check(
	"composerHeader renders as a BARE child of ViewportFooter (no wrapping element)",
	footerBody !== null && footerBody[1].trim() === "{composerHeader}",
	footerBody?.[1],
);

// =============================================================================
// (d) ISSUE-1 regression — pure mode-reconciliation logic + wiring
// =============================================================================

check(
	"mode reconciliation: same id across renders (mount) does not reset",
	shouldSnapToChatOnThreadChange("thread-1", "thread-1") === false,
);
check(
	"mode reconciliation: no thread yet at mount (undefined -> undefined) does not reset",
	shouldSnapToChatOnThreadChange(undefined, undefined) === false,
);
check(
	"mode reconciliation: switching to a different existing thread resets to chat",
	shouldSnapToChatOnThreadChange("thread-1", "thread-2") === true,
);
check(
	"mode reconciliation: starting a new thread (undefined -> id) resets to chat",
	shouldSnapToChatOnThreadChange(undefined, "thread-2") === true,
);

const shellSrc = readSrc("../components/knowledge-hub/KnowledgeHubShell.tsx");
check(
	"KnowledgeHubShell imports the pure mode-reconciliation helper",
	shellSrc.includes(
		'import { shouldSnapToChatOnThreadChange } from "@/lib/knowledge-hub-mode";',
	),
);
const reconcileEffect = shellSrc.match(
	/const prevThreadIdRef = useRef\(activeThreadId\);\s*useEffect\(\(\) => \{([\s\S]*?)\}, \[activeThreadId\]\);/,
);
check(
	"KnowledgeHubShell wires a useEffect keyed on activeThreadId",
	reconcileEffect !== null,
);
if (reconcileEffect) {
	const body = reconcileEffect[1];
	check(
		"the effect calls shouldSnapToChatOnThreadChange(prevThreadIdRef.current, activeThreadId)",
		/shouldSnapToChatOnThreadChange\(\s*prevThreadIdRef\.current,\s*activeThreadId\s*\)/.test(
			body,
		),
		body,
	);
	check(
		'setMode("chat") is GATED inside that predicate\'s if-block, not unconditional',
		/if\s*\(\s*shouldSnapToChatOnThreadChange\([\s\S]*?\)\s*\)\s*\{\s*setMode\("chat"\);\s*\}/.test(
			body,
		),
		body,
	);
	check(
		"the ref is updated to the new id after the check",
		/prevThreadIdRef\.current = activeThreadId;/.test(body),
	);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
