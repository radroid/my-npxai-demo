import Link from "next/link";

export const metadata = {
	title: "FAQ — NPXai Demo",
	description:
		"Questions about the NPX Innovation hiring demo — what it is, what's real, what's simulated.",
};

const FAQS = [
	{
		q: "What is this?",
		a: "Raj Dholakia's hiring demo for NPX Innovation: a cited Q&A over 19 real CNSC REGDOCs and a CANDU shift-turnover generator over simulated Bruce Power data.",
	},
	{
		q: "Is the plant data real?",
		a: "No — simulated, tuned to CANDU-nominal parameters. None of it mirrors any actual Bruce Power reading.",
	},
	{
		q: "Is the REGDOC corpus real?",
		a: "Yes. 19 CNSC REGDOCs from cnsc-ccsn.gc.ca, chunked and embedded into Supabase pgvector. Every answer cites its source section.",
	},
	{
		q: "How many questions can I ask?",
		a: "Anon: 5/day. Signed in: 50/day. Industry domains (npxinnovation.ca, brucepower.com, opg.com, cnsc-ccsn.gc.ca, cameco.com, uwaterloo.ca): 100/day. Limits are tight because the demo runs on a personal OpenAI wallet.",
	},
	{
		q: "What happens if I ask something outside the corpus?",
		a: "One of two fallbacks — off-topic questions get a plain refusal, in-topic but uncovered questions get a low-confidence disclaimer. The assistant never guesses and never fabricates citations.",
	},
	{
		q: "Can I sign in?",
		a: "Yes — magic link to your email. Session cookies only. Your email is used to resolve rate-limit tier; never sent to OpenAI or logged against queries.",
	},
	{
		q: "Are my questions logged?",
		a: "Request metadata only (timestamp, route, latency, hashed IP, tier, similarity scores). Never the raw question or answer.",
	},
	{
		q: "What stack is this on?",
		a: "Next.js 16 + assistant-ui + Supabase pgvector + OpenAI + Upstash + Cloudflare Workers. Bun as the package manager.",
	},
	{
		q: "Is the code public?",
		a: "It will be once the Loom walkthrough is recorded.",
	},
	{
		q: "Who do I talk to about NPX Innovation?",
		a: "Visit npxai.com. This demo is a hiring application from a candidate, separate from NPX's own work.",
	},
] as const;

export default function FAQPage() {
	return (
		<div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-16 md:px-6">
			<header className="flex flex-col gap-3">
				<p className="text-xs uppercase tracking-[0.18em] text-fg-muted">FAQ</p>
				<h1 className="font-semibold text-3xl text-fg md:text-4xl">
					Frequently asked questions
				</h1>
			</header>
			<dl className="flex flex-col gap-4">
				{FAQS.map((f) => (
					<div
						key={f.q}
						className="rounded-lg border border-border bg-surface p-5"
					>
						<dt className="font-semibold text-fg">{f.q}</dt>
						<dd className="mt-2 text-sm text-fg-muted leading-relaxed">
							{f.a}
						</dd>
					</div>
				))}
			</dl>
			<footer className="text-sm text-fg-muted">
				Something missing? The{" "}
				<Link
					href="/"
					className="text-brand hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
				>
					homepage contact section
				</Link>{" "}
				has a newsletter capture — Raj will get back to you.
			</footer>
		</div>
	);
}
