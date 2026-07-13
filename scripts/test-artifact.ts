#!/usr/bin/env bun
// Artifact backend functional harness (item-1 slice 1.1, PR #6).
//
// Pure/offline by design: no network, no OpenAI, no dev server. Exercises
// the REAL lib/artifact-sanitizer.ts + lib/artifact-template.ts modules
// (the executor's original 42-check harness, checks 1–42) plus the fix
// round 1 regression section (reviewer-mandated):
//   (a) limited-coverage reachability — a synthetic ranked pool with
//       topSim >= LOW_SIM_OOS but raw-pool mean < LOW_SIM_DISCLAIMER must
//       produce an assembled document WITH the limited-coverage callout;
//       a strong pool must NOT.
//   (b) dead-threshold guard — the callout trigger must NOT depend on the
//       post-filter envelope average, which is structurally >= MIN_CHUNK_SIM
//       (== LOW_SIM_DISCLAIMER) in the non-OOS branch and therefore can
//       never fire the callout.
//
// The regression section drives the real retrieveChunks() with mocked
// supabase/openai deps. retrieveChunks calls recordOpenAICall → Upstash
// REST, so a fetch stub answers the fake Upstash URL in-process; ANY other
// fetch throws, enforcing the no-network guarantee.
//
// Usage:  bun run test:artifact
// Exit code 0 on pass, 1 on any failure.

import { readFileSync } from "node:fs";
import { sanitizeArtifactFragment } from "../lib/artifact-sanitizer";
import {
	type ArtifactSource,
	assembleArtifactDocument,
} from "../lib/artifact-template";
import type { RetrievedChunk } from "../lib/context-envelope";
import {
	LOW_SIM_DISCLAIMER,
	LOW_SIM_OOS,
	MIN_CHUNK_SIM,
	type RetrievalDeps,
	retrieveChunks,
} from "../lib/retrieval";

// ---------------------------------------------------------------------------
// Offline netting: recordOpenAICall inside retrieveChunks talks to Upstash
// over REST. Point it at a fake host and answer in-process. Any OTHER
// network call is a harness bug — fail loudly.

process.env.UPSTASH_REDIS_REST_URL = "https://offline-harness.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN = "offline-harness-token";

globalThis.fetch = (async (
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> => {
	const url = String(input instanceof Request ? input.url : input);
	if (!url.startsWith("https://offline-harness.invalid")) {
		throw new Error(`test-artifact must stay offline; unexpected fetch: ${url}`);
	}
	// Upstash REST shape: pipeline/multi-exec endpoints expect an ARRAY of
	// {result}, single-command endpoints expect one {result}.
	let commands = 1;
	try {
		const body =
			init?.body ?? (input instanceof Request ? await input.text() : undefined);
		if (typeof body === "string") {
			const parsed = JSON.parse(body);
			if (Array.isArray(parsed) && Array.isArray(parsed[0]))
				commands = parsed.length;
		}
	} catch {
		// fall through — single-result shape
	}
	const payload = /pipeline|multi-exec/.test(url)
		? JSON.stringify(Array.from({ length: commands }, () => ({ result: 1 })))
		: JSON.stringify({ result: 1 });
	return new Response(payload, {
		headers: { "content-type": "application/json" },
	});
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Scaffolding

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
	if (!cond) {
		failures++;
		console.log(`FAIL: ${name}`, extra ?? "");
	} else {
		console.log(`ok:   ${name}`);
	}
}

const pad =
	"<p>" +
	"Regulatory context sentence for padding purposes. ".repeat(10) +
	"</p>";

// =============================================================================
// Part 1 — sanitizer + assembler functional checks (original 42-check harness)
// =============================================================================

// 1. Clean contract-conforming fragment
const clean = `<h1 class="art-title">The Graded Approach</h1>
<section class="art-summary"><p>Answer first sentence. More context. Third sentence.</p></section>
<section class="art-section"><h2>How it works</h2>${pad}
<div class="callout callout-requirement"><p>Licensees <strong>shall</strong> apply it [REGDOC-3.5.3 §5.4]</p></div>
<table class="art-table"><thead><tr><th scope="col">Doc</th><th scope="col">Role</th></tr></thead>
<tbody><tr><td>REGDOC-3.5.3</td><td><span class="badge badge-requirement">Requirement</span></td></tr></tbody></table>
<figure class="art-figure"><svg viewBox="0 0 800 300"><defs><marker id="arrow" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><polygon points="0,0 10,5 0,10" class="svg-arrow" /></marker></defs>
<rect x="10" y="10" width="200" height="60" rx="8" class="svg-box-req" />
<line x1="210" y1="40" x2="400" y2="40" class="svg-arrow" marker-end="url(#arrow)" />
<text x="20" y="45" class="svg-text">Assess risk</text></svg>
<figcaption>Process flow</figcaption></figure></section>`;
const r1 = sanitizeArtifactFragment(clean);
check("clean passes", r1.ok === true);
if (r1.ok) {
	check("clean title", r1.title === "The Graded Approach", r1.title);
	check("clean zero strips", r1.strips === 0, r1.strips);
	check("clean keeps viewBox", r1.fragment.includes('viewBox="0 0 800 300"'));
	check("clean keeps marker id", r1.fragment.includes('id="arrow"'));
	check(
		"clean keeps marker-end",
		r1.fragment.includes('marker-end="url(#arrow)"'),
	);
	check("clean keeps scope", r1.fragment.includes('scope="col"'));
}

// 2. Fenced + hostile output
const hostile =
	"```html\n" +
	`<h1 class="art-title" style="color:#fff" onclick="alert(1)">T</h1>
<script>alert("xss")</script>
<p style="background:#151834">Text with <a href="https://evil.example">link</a> and <iframe src="x"></iframe></p>
<img src="x" onerror="alert(1)">
<section class="art-section unknown-class"><h2>Body</h2>${pad}${pad}</section>
` +
	"\n```";
const r2 = sanitizeArtifactFragment(hostile);
check("hostile passes after strip", r2.ok === true, r2);
if (r2.ok) {
	check("no script", !/script/i.test(r2.fragment));
	check("no onclick/onerror", !/on\w+=/i.test(r2.fragment));
	check("no href/a tag", !/<a|href/i.test(r2.fragment));
	check("no iframe", !/iframe/i.test(r2.fragment));
	check("no style attr", !/style=/i.test(r2.fragment));
	check("no hex", !/#fff|#151834/i.test(r2.fragment));
	check("unknown class dropped", !/unknown-class/.test(r2.fragment));
	check("known class kept", /class="art-section"/.test(r2.fragment));
	check("strips counted", r2.strips >= 8, r2.strips);
	check("no fences", !r2.fragment.includes("```"));
}

// 3. Truncation repair
const truncated = `<h1 class="art-title">T</h1><section class="art-section"><h2>A</h2>${pad}${pad}<ul><li>item one <strong>bold`;
const r3 = sanitizeArtifactFragment(truncated);
check("truncated passes", r3.ok === true);
if (r3.ok) {
	check(
		"balance repaired",
		r3.fragment.endsWith("</strong></li></ul></section>"),
		r3.fragment.slice(-60),
	);
	check("repairs counted", r3.repairs === 4, r3.repairs);
}

// 4. Refusal detection
const r4 = sanitizeArtifactFragment(
	"This assistant only answers questions about the indexed CNSC regulatory documents.",
);
check("refusal detected", !r4.ok && r4.reason === "refusal");
const r5 = sanitizeArtifactFragment('<h1 class="art-title">Too short</h1>');
check("short fragment refused", !r5.ok && r5.reason === "refusal");

// 5. svg root width/height stripped
const r6 = sanitizeArtifactFragment(
	`<h1 class="art-title">T</h1>${pad}${pad}<svg width="800" height="300" viewBox="0 0 800 300"><rect x="1" y="1" width="5" height="5" class="svg-box" /></svg>`,
);
if (r6.ok) {
	check(
		"svg root width stripped",
		!/<svg[^>]*width=/.test(r6.fragment),
		r6.fragment.match(/<svg[^>]*>/)?.[0],
	);
	check("rect width kept", /<rect[^>]*width="5"/.test(r6.fragment));
} else check("svg sizing test ok", false, r6);

// 6. Interleaved close repair + stray close dropped
const r7 = sanitizeArtifactFragment(
	`<h1 class="art-title">T</h1>${pad}${pad}<p><strong><em>x</strong></em> tail</p></div>`,
);
if (r7.ok) {
	check(
		"interleave repaired",
		r7.fragment.includes("<strong><em>x</em></strong>"),
		r7.fragment.slice(-120),
	);
	check("stray close dropped", !r7.fragment.includes("</div>"));
} else check("interleave test ok", false, r7);

// 7. srcdoc smuggle in text → deny-scan
const r8 = sanitizeArtifactFragment(
	`<h1 class="art-title">T</h1>${pad}${pad}<p>srcdoc=payload</p>`,
);
check("srcdoc denies", !r8.ok && r8.reason === "output_guard", r8);

// 8. doctype/comment stripped
const r9 = sanitizeArtifactFragment(
	`<!DOCTYPE html><!-- sneaky --><h1 class="art-title">T</h1>${pad}${pad}`,
);
if (r9.ok) {
	check("doctype stripped", !/DOCTYPE/i.test(r9.fragment));
	check("comment stripped", !r9.fragment.includes("sneaky"));
} else check("doctype test ok", false, r9);

// 9. Assembly
if (r1.ok) {
	const html = assembleArtifactDocument({
		fragment: r1.fragment,
		title: r1.title,
		query: "Explain the graded approach & how it applies <b>everywhere</b>",
		sources: [
			{
				id: 1,
				regdoc_id: "REGDOC-3.5.3",
				section_number: "5.4",
				section_title: "Graded approach",
				url: "https://www.cnsc-ccsn.gc.ca/eng/acts-and-regulations/regulatory-documents/published/html/regdoc3-5-3/#sec5-4",
				similarity: 0.71,
				requirement_type: "requirement",
				snippet: "...",
			},
			{
				id: 2,
				regdoc_id: "NSCA",
				section_number: "24",
				section_title: null,
				url: null,
				similarity: 0.5,
				requirement_type: null,
				snippet: "...",
			},
			{
				id: 3,
				regdoc_id: "REGDOC-2.11.1",
				section_number: null,
				section_title: "Waste",
				url: "https://evil.example/x",
				similarity: 0.44,
				requirement_type: "guidance",
				snippet: "...",
			},
		],
		limitedCoverage: true,
		truncated: true,
		model: "gpt-4o-mini",
		promptVersion: "2026-07-13.1",
		generatedAt: new Date("2026-07-13T12:00:00Z"),
	});
	check("doc starts with doctype", html.startsWith("<!doctype html>"));
	check(
		"exactly one style block",
		(html.match(/<style/g) ?? []).length === 1,
	);
	const aTags = html.match(/<a\s[^>]*>/g) ?? [];
	check("one a tag (cnsc only)", aTags.length === 1, aTags);
	check(
		"a is cnsc",
		aTags.every((a) => a.includes("https://www.cnsc-ccsn.gc.ca/")),
	);
	check(
		"a rel noopener",
		aTags.every(
			(a) =>
				a.includes('rel="noopener noreferrer"') && a.includes('target="_blank"'),
		),
	);
	check(
		"query escaped",
		html.includes("&lt;b&gt;everywhere&lt;/b&gt;") &&
			!html.includes("<b>everywhere"),
	);
	check("limited coverage callout", html.includes("Limited corpus coverage"));
	check("truncation callout", html.includes("Response truncated"));
	check(
		"disclaimer",
		html.includes("Simulated demo — not for operational use."),
	);
	check(
		"provenance",
		html.includes("2026-07-13.1") && html.includes("gpt-4o-mini"),
	);
	check("no script anywhere", !/<script/i.test(html));
	check("NSCA source without link", html.includes("[NSCA §24]"));
}

// =============================================================================
// Part 2 — fix round 1 regression checks (reviewer-mandated): the
// limited-coverage callout must be REACHABLE, and its trigger must not
// depend on the post-filter envelope average.
// =============================================================================

function makePool(sims: number[]): RetrievedChunk[] {
	return sims.map((s, i) => ({
		id: i + 1,
		regdoc_id: "REGDOC-3.5.3",
		section_number: `${i + 1}`,
		section_title: `Section ${i + 1}`,
		chunk_text: `Corpus chunk ${i + 1} about facility licensing scope.`,
		url: "https://www.cnsc-ccsn.gc.ca/eng/acts-and-regulations/regulatory-documents/",
		requirement_type: i % 2 === 0 ? "requirement" : "guidance",
		similarity: s,
	}));
}

function mockDeps(pool: RetrievedChunk[]): RetrievalDeps {
	return {
		supabase: {
			rpc: async () => ({ data: pool, error: null }),
		},
		openai: {
			embeddings: {
				create: async ({ input }: { input: string[] }) => ({
					data: input.map(() => ({ embedding: [0.1, 0.2, 0.3] })),
				}),
			},
		},
	} as unknown as RetrievalDeps;
}

// Neutral query: no REGDOC/NSCA mention, no concept-hint phrase — keeps the
// pipeline to a single primary retrieval so the synthetic pool IS the pool.
const NEUTRAL_QUERY = "How do licensing fee structures scale for small facilities?";

// The exact trigger predicate the artifact route applies (fix round 1).
const limitedCoveragePredicate = (poolAvgSim: number) =>
	poolAvgSim < LOW_SIM_DISCLAIMER;

function assembleWith(limitedCoverage: boolean, envelope: RetrievedChunk[]) {
	if (!r1.ok) throw new Error("clean fragment must sanitize for part 2");
	const sources: ArtifactSource[] = envelope.map((c) => ({
		id: c.id,
		regdoc_id: c.regdoc_id,
		section_number: c.section_number,
		section_title: c.section_title,
		url: c.url,
		similarity: Number(c.similarity.toFixed(4)),
		requirement_type: c.requirement_type,
		snippet: c.chunk_text.slice(0, 260),
	}));
	return assembleArtifactDocument({
		fragment: r1.fragment,
		title: r1.title,
		query: NEUTRAL_QUERY,
		sources,
		limitedCoverage,
		truncated: false,
		model: "gpt-4o-mini",
		promptVersion: "2026-07-13.1",
		generatedAt: new Date("2026-07-13T12:00:00Z"),
	});
}

// (a) Reachability — one strong chunk (0.42) clears the OOS gate while 19
// weak ones (0.20) drag the raw-pool mean to ~0.21 < 0.35.
const weakPool = makePool([0.42, ...Array.from({ length: 19 }, () => 0.2)]);
const weak = await retrieveChunks(NEUTRAL_QUERY, mockDeps(weakPool), {
	envelopeChunks: 12,
});
check(
	"weak pool: clears OOS gate (topSim >= LOW_SIM_OOS)",
	weak.topSim >= LOW_SIM_OOS,
	weak.topSim,
);
check(
	"weak pool: raw-pool mean under disclaimer threshold",
	weak.poolAvgSim < LOW_SIM_DISCLAIMER,
	weak.poolAvgSim,
);
check(
	"weak pool: route predicate fires (limitedCoverage true)",
	limitedCoveragePredicate(weak.poolAvgSim) === true,
);
const weakHtml = assembleWith(
	limitedCoveragePredicate(weak.poolAvgSim),
	weak.envelope,
);
check(
	"weak pool: assembled document CONTAINS limited-coverage callout",
	weakHtml.includes("Limited corpus coverage"),
);

// Strong pool: healthy sims throughout — callout must NOT appear.
const strongPool = makePool(
	Array.from({ length: 15 }, (_, i) => 0.62 - i * 0.005),
);
const strong = await retrieveChunks(NEUTRAL_QUERY, mockDeps(strongPool), {
	envelopeChunks: 12,
});
check(
	"strong pool: clears OOS gate",
	strong.topSim >= LOW_SIM_OOS,
	strong.topSim,
);
check(
	"strong pool: route predicate does not fire",
	limitedCoveragePredicate(strong.poolAvgSim) === false,
	strong.poolAvgSim,
);
const strongHtml = assembleWith(
	limitedCoveragePredicate(strong.poolAvgSim),
	strong.envelope,
);
check(
	"strong pool: assembled document has NO limited-coverage callout",
	!strongHtml.includes("Limited corpus coverage"),
);

// (b) Dead-threshold guard — the non-OOS envelope is built from chunks that
// already passed MIN_CHUNK_SIM (== LOW_SIM_DISCLAIMER), so the post-filter
// envelope average can NEVER satisfy the callout predicate. The trigger must
// read the raw-pool mean; these checks pin that structurally and at the
// route-wiring level.
check(
	"dead-threshold: post-filter envelope avg is >= MIN_CHUNK_SIM by construction",
	weak.avgSim >= MIN_CHUNK_SIM,
	weak.avgSim,
);
check(
	"dead-threshold: envelope avg CANNOT fire the callout where pool mean DOES",
	weak.avgSim >= LOW_SIM_DISCLAIMER && weak.poolAvgSim < LOW_SIM_DISCLAIMER,
	{ avgSim: weak.avgSim, poolAvgSim: weak.poolAvgSim },
);
const routeSource = readFileSync(
	new URL("../app/api/knowledge-hub/artifact/route.ts", import.meta.url),
	"utf8",
);
check(
	"dead-threshold: artifact route gates the callout on poolAvgSim",
	/const limitedCoverage = poolAvgSim < LOW_SIM_DISCLAIMER/.test(routeSource),
);
check(
	"dead-threshold: artifact route does NOT gate the callout on envelope avgSim",
	!/limitedCoverage\s*=\s*(?:retrieval\.)?avgSim\b/.test(routeSource),
);

// poolAvgSim is ADDITIVE: legacy result fields all present (chat route
// destructures them unchanged), and in the OOS branch the envelope IS the
// full pool, so avgSim === poolAvgSim — chat's logged full-pool quirk.
check(
	"additive: legacy RetrievalResult fields intact + poolAvgSim present",
	["envelope", "topSim", "avgSim", "mentionedDocs", "poolAvgSim"].every(
		(k) => k in weak,
	),
	Object.keys(weak),
);
const oosPool = makePool(Array.from({ length: 20 }, () => 0.2));
const oos = await retrieveChunks(NEUTRAL_QUERY, mockDeps(oosPool), {
	envelopeChunks: 12,
});
check(
	"OOS branch: below the gate (topSim < LOW_SIM_OOS)",
	oos.topSim < LOW_SIM_OOS,
	oos.topSim,
);
check(
	"OOS branch: avgSim === poolAvgSim (full-pool average quirk preserved)",
	oos.avgSim === oos.poolAvgSim,
	{ avgSim: oos.avgSim, poolAvgSim: oos.poolAvgSim },
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
